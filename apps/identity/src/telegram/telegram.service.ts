import {
	BadRequestException,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AuthIdentityType,
	Prisma,
	TelegramBotKind,
	UserStatus,
	VerificationChallengePurpose,
	VerificationChallengeType,
	WebhookReceiptStatus,
	type VerificationChallenge
} from '@prisma/identity-client';
import { compare, hash } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import {
	clientIp,
	PASSWORD_SALT_ROUNDS,
	randomToken,
	safeEqual,
	sha256,
	verificationCode
} from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { AuthSettingsService } from '../auth/auth-settings.service';
import { AuthService } from '../auth/auth.service';

type TelegramUser = {
	id: number;
	username?: string;
	first_name?: string;
	last_name?: string;
};

type TelegramChat = {
	id: number | string;
	type?: string;
};

type TelegramMessage = {
	message_id?: number;
	text?: string;
	chat: TelegramChat;
	from?: TelegramUser;
};

type TelegramCallbackQuery = {
	id: string;
	data?: string;
	from: TelegramUser;
	message?: TelegramMessage;
};

export type TelegramWebhookUpdate = {
	update_id?: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

type TelegramApiEnvelope = {
	ok?: boolean;
	description?: string;
	result?: Record<string, unknown>;
};

type TelegramWebhookKind = 'AUTH' | 'INFO';

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

const AUTH_CALLBACK_PREFIX = 'winwidget_login:';
const WEBHOOK_LEASE_MS = 120_000;
const REQUEST_TTL_MS = 15 * 60_000;
const MAX_CODE_ATTEMPTS = 5;

@Injectable()
export class TelegramService {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService,
		private readonly settings: AuthSettingsService,
		private readonly auth: AuthService
	) {}

	async startLogin() {
		await this.settings.assertProviderEnabled('telegram');
		const username = this.botUsername('AUTH', true);
		this.botToken('AUTH', true);
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				expiresAt: { lte: new Date() }
			}
		});
		const requestId = randomToken(24);
		const code = verificationCode();
		const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
		await this.prisma.verificationChallenge.create({
			data: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				value: requestId,
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				expiresAt
			}
		});
		return {
			requestId,
			botUrl: `https://t.me/${username}?start=${requestId}`,
			expiresAt: expiresAt.toISOString()
		};
	}

	async verifyLogin(
		requestId: string,
		code: string,
		referrerId: string | undefined,
		request: Request
	) {
		await this.settings.assertProviderEnabled('telegram');
		const result = await this.resolveLogin(requestId, referrerId, code);
		if ('error' in result) throw new UnauthorizedException(result.error);
		if ('pending' in result) {
			throw new UnauthorizedException(
				'Telegram verification code not found'
			);
		}
		return this.auth.startSession(result.user, request);
	}

	async completeLogin(
		requestId: string,
		referrerId: string | undefined,
		request: Request
	) {
		await this.settings.assertProviderEnabled('telegram');
		const result = await this.resolveLogin(requestId, referrerId);
		if ('pending' in result) return { confirmed: false as const };
		if ('error' in result) throw new UnauthorizedException(result.error);
		const session = await this.auth.startSession(result.user, request);
		return { confirmed: true as const, ...session };
	}

	async cancelLogin(requestId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				value: requestId
			}
		});
		return { cancelled: true as const };
	}

	async handleAuthWebhook(update: TelegramWebhookUpdate, secret?: string) {
		this.assertWebhookSecret('AUTH', secret);
		return this.withWebhookReceipt(
			TelegramBotKind.AUTH,
			update,
			async () => {
				if (update.callback_query) {
					await this.handleAuthCallback(update.callback_query);
				} else if (update.message) {
					await this.handleAuthMessage(update.message);
				}
			}
		);
	}

	async handleInfoWebhook(update: TelegramWebhookUpdate, secret?: string) {
		this.assertWebhookSecret('INFO', secret);
		if (update.message && update.message.chat.type !== 'private')
			return true;
		return this.withWebhookReceipt(
			TelegramBotKind.INFO,
			update,
			async () => {
				if (update.message) await this.handleInfoMessage(update.message);
			}
		);
	}

	adminSettings() {
		return {
			authTelegramBotTokenConfigured: Boolean(this.botToken('AUTH')),
			authTelegramBotUsernameConfigured: Boolean(this.botUsername('AUTH'))
		};
	}

	authWebhookStatus() {
		return this.webhookStatus('AUTH');
	}

	infoWebhookStatus() {
		return this.webhookStatus('INFO');
	}

	private async webhookStatus(kind: TelegramWebhookKind) {
		const config = this.webhookConfig(kind);
		const token = this.botToken(kind);
		const username = this.botUsername(kind);
		let expectedWebhookUrl: string | null = null;
		try {
			expectedWebhookUrl = this.webhookUrl(kind);
		} catch (error) {
			return this.webhookFailure(
				kind,
				token,
				username,
				null,
				error instanceof Error ? error.message : String(error)
			);
		}
		if (!token) {
			return this.webhookFailure(
				kind,
				token,
				username,
				expectedWebhookUrl,
				config.notConfiguredError
			);
		}
		try {
			const [webhook, bot] = await Promise.all([
				this.telegramApi(token, 'getWebhookInfo'),
				this.telegramApi(token, 'getMe')
			]);
			const result = webhook.result || {};
			const botResult = bot.result || {};
			const webhookUrl = this.string(result.url) || null;
			const actualUsername = this.string(botResult.username) || null;
			const lastErrorDate = this.number(result.last_error_date);
			const allowedUpdates = Array.isArray(result.allowed_updates)
				? result.allowed_updates.filter(
						(value): value is string => typeof value === 'string'
					)
				: null;
			return {
				bot: config.bot,
				title: config.title,
				configured: true,
				ok: webhook.ok === true,
				expectedWebhookUrl,
				webhookUrl,
				webhookMatchesExpected: webhookUrl === expectedWebhookUrl,
				pendingUpdateCount: this.number(result.pending_update_count) ?? 0,
				lastErrorAt:
					lastErrorDate === undefined
						? null
						: new Date(lastErrorDate * 1_000).toISOString(),
				lastErrorMessage: this.string(result.last_error_message) || null,
				allowedUpdates,
				secretConfigured: Boolean(this.webhookSecret(kind)),
				configuredUsername: username || null,
				actualUsername,
				usernameMatchesConfigured: username
					? actualUsername === username
					: null,
				error: webhook.ok === true ? null : webhook.description || null
			};
		} catch (error) {
			return this.webhookFailure(
				kind,
				token,
				username,
				expectedWebhookUrl,
				error instanceof Error ? error.message : String(error)
			);
		}
	}

	reinstallAuthWebhook(actorId: string, request: Request) {
		return this.reinstallWebhook('AUTH', actorId, request);
	}

	reinstallInfoWebhook(actorId: string, request: Request) {
		return this.reinstallWebhook('INFO', actorId, request);
	}

	private async reinstallWebhook(
		kind: TelegramWebhookKind,
		actorId: string,
		request: Request
	) {
		const config = this.webhookConfig(kind);
		const token = this.botToken(kind, true);
		const webhookUrl = this.webhookUrl(kind);
		await this.telegramApi(token, 'deleteWebhook', {
			drop_pending_updates: true
		});
		await this.telegramApi(token, 'setWebhook', {
			url: webhookUrl,
			drop_pending_updates: true,
			max_connections: 40,
			allowed_updates: config.allowedUpdates,
			secret_token: this.webhookSecret(kind, true)
		});
		const result = {
			bot: config.bot,
			title: config.title,
			webhookUrl,
			dropPendingUpdates: true,
			allowedUpdates: config.allowedUpdates,
			secretConfigured: true,
			installedAt: new Date().toISOString()
		};
		await this.prisma.$transaction(transaction =>
			this.events.emitAudit(transaction, {
				actorId,
				section: 'TELEGRAM_BOT',
				action: 'TELEGRAM_BOT_WEBHOOK_REINSTALL',
				entityType: 'telegram_webhook',
				entityId: config.bot,
				entityLabel: config.title,
				description: `Переустановлен webhook ${config.title}`,
				metadata: {
					bot: result.bot,
					title: result.title,
					dropPendingUpdates: result.dropPendingUpdates,
					allowedUpdates: result.allowedUpdates,
					secretConfigured: result.secretConfigured,
					installedAt: result.installedAt
				},
				requestId: request.header('x-request-id'),
				requestIp: clientIp(request),
				requestUserAgent: request.get('user-agent')?.slice(0, 500),
				correlationId: request.header('x-correlation-id')
			})
		);
		return result;
	}

	private async resolveLogin(
		requestId: string,
		referrerId?: string,
		code?: string
	): Promise<
		| { user: Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }> }
		| { pending: true }
		| { error: string }
	> {
		return this.prisma.$transaction(
			async transaction => {
				const challenge =
					await transaction.verificationChallenge.findUnique({
						where: {
							type_purpose_value: {
								type: VerificationChallengeType.TELEGRAM,
								purpose: VerificationChallengePurpose.LOGIN,
								value: requestId
							}
						}
					});
				if (!challenge || challenge.expiresAt <= new Date()) {
					if (challenge) {
						await transaction.verificationChallenge.delete({
							where: { id: challenge.id }
						});
					}
					return { error: 'Telegram auth request not found' };
				}
				if (!challenge.telegramUserId) return { pending: true };
				if (code === undefined && !challenge.telegramChatId) {
					return { pending: true };
				}
				if (code !== undefined) {
					if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
						await transaction.verificationChallenge.delete({
							where: { id: challenge.id }
						});
						return {
							error: 'Telegram verification code attempts exceeded'
						};
					}
					if (!(await compare(code, challenge.codeHash))) {
						const attempts = challenge.attempts + 1;
						if (attempts >= MAX_CODE_ATTEMPTS) {
							await transaction.verificationChallenge.delete({
								where: { id: challenge.id }
							});
							return {
								error: 'Telegram verification code attempts exceeded'
							};
						}
						await transaction.verificationChallenge.update({
							where: { id: challenge.id },
							data: { attempts }
						});
						return { error: 'Telegram verification code invalid' };
					}
				}
				const user = await this.findOrCreateTelegramUser(
					transaction,
					challenge,
					referrerId
				);
				await transaction.verificationChallenge.delete({
					where: { id: challenge.id }
				});
				return { user };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async findOrCreateTelegramUser(
		transaction: Prisma.TransactionClient,
		challenge: VerificationChallenge,
		referrerId?: string
	) {
		const telegramUserId = challenge.telegramUserId!;
		const existing = await transaction.authIdentity.findUnique({
			where: {
				type_value: {
					type: AuthIdentityType.TELEGRAM,
					value: telegramUserId
				}
			},
			include: { user: { include: USER_INCLUDE } }
		});
		if (existing) {
			if (
				existing.user.status !== UserStatus.ACTIVE ||
				existing.user.deletedAt
			) {
				throw new UnauthorizedException('User is deactivated');
			}
			return existing.user;
		}
		const user = await transaction.user.create({
			data: {
				name: this.telegramName(challenge),
				password: '',
				authIdentities: {
					create: {
						type: AuthIdentityType.TELEGRAM,
						value: telegramUserId,
						verifiedAt: new Date()
					}
				}
			},
			include: USER_INCLUDE
		});
		const normalizedReferrer = referrerId?.trim();
		if (
			normalizedReferrer &&
			normalizedReferrer !== user.id &&
			normalizedReferrer.length <= 255
		) {
			const referrer = await transaction.user.findFirst({
				where: {
					id: normalizedReferrer,
					status: UserStatus.ACTIVE,
					deletedAt: null
				},
				select: { id: true }
			});
			if (referrer) {
				await this.events.emitBillingRequest(transaction, {
					eventType: 'billing.referral.requested.v1',
					aggregateType: 'billing.referral-request',
					aggregateId: user.id,
					state: {
						referrerId: referrer.id,
						referredUserId: user.id,
						requestedAt: user.createdAt.toISOString()
					}
				});
			}
		}
		await this.events.emitUserChanged(transaction, user.id);
		return user;
	}

	private async handleAuthMessage(message: TelegramMessage) {
		const chatId = message.chat.id;
		if (message.chat.type && message.chat.type !== 'private') {
			await this.sendMessage(
				'AUTH',
				chatId,
				'Подтвердите вход или привязку в личном чате с Auth_bot.'
			);
			return;
		}
		const requestId = this.startArgument(message.text);
		if (!requestId || !message.from) {
			await this.sendMessage(
				'AUTH',
				chatId,
				'Откройте Auth_bot кнопкой на сайте winwidget.ru.'
			);
			return;
		}
		const challenge = await this.activeAuthWebhookChallenge(requestId);
		if (!challenge) {
			await this.sendMessage(
				'AUTH',
				chatId,
				'Ссылка истекла. Вернитесь на сайт.'
			);
			return;
		}
		const code = verificationCode();
		await this.prisma.verificationChallenge.update({
			where: { id: challenge.id },
			data: {
				codeHash: await hash(code, PASSWORD_SALT_ROUNDS),
				attempts: 0,
				telegramUserId: String(message.from.id),
				telegramChatId: null,
				telegramUsername: message.from.username || null,
				telegramFirstName: message.from.first_name || null,
				telegramLastName: message.from.last_name || null
			}
		});
		if (challenge.purpose === VerificationChallengePurpose.BIND_IDENTITY) {
			await this.sendMessage(
				'AUTH',
				chatId,
				'Нажмите кнопку, чтобы привязать Telegram к профилю.',
				{
					inline_keyboard: [
						[
							{
								text: 'Привязать Telegram',
								callback_data: `${AUTH_CALLBACK_PREFIX}${requestId}`
							}
						]
					]
				}
			);
			return;
		}
		await this.sendMessage(
			'AUTH',
			chatId,
			`Код входа: ${code}. Или подтвердите вход кнопкой ниже.`,
			{
				inline_keyboard: [
					[
						{
							text: 'Подтвердить вход',
							callback_data: `${AUTH_CALLBACK_PREFIX}${requestId}`
						}
					]
				]
			}
		);
	}

	private async handleAuthCallback(callback: TelegramCallbackQuery) {
		if (!callback.data?.startsWith(AUTH_CALLBACK_PREFIX)) return;
		const requestId = callback.data
			.slice(AUTH_CALLBACK_PREFIX.length)
			.trim();
		const chatId = callback.message?.chat.id ?? callback.from.id;
		const challenge = await this.activeAuthWebhookChallenge(requestId);
		if (!challenge) {
			await this.answerCallback(callback.id, 'Ссылка истекла.');
			return;
		}
		const telegramUserId = String(callback.from.id);
		if (
			challenge.telegramUserId &&
			challenge.telegramUserId !== telegramUserId
		) {
			await this.answerCallback(
				callback.id,
				'Запрос подтверждён другим аккаунтом.'
			);
			return;
		}
		if (challenge.purpose === VerificationChallengePurpose.BIND_IDENTITY) {
			if (!challenge.userId) {
				await this.answerCallback(callback.id, 'Ссылка истекла.');
				return;
			}
			await this.prisma.$transaction(
				async transaction => {
					const occupied = await transaction.authIdentity.findUnique({
						where: {
							type_value: {
								type: AuthIdentityType.TELEGRAM,
								value: telegramUserId
							}
						}
					});
					if (occupied && occupied.userId !== challenge.userId) {
						throw new BadRequestException(
							'This Telegram account is already linked'
						);
					}
					await transaction.authIdentity.upsert({
						where: {
							userId_type: {
								userId: challenge.userId!,
								type: AuthIdentityType.TELEGRAM
							}
						},
						create: {
							userId: challenge.userId!,
							type: AuthIdentityType.TELEGRAM,
							value: telegramUserId,
							verifiedAt: new Date()
						},
						update: { value: telegramUserId, verifiedAt: new Date() }
					});
					await transaction.verificationChallenge.delete({
						where: { id: challenge.id }
					});
					await this.events.emitUserChanged(
						transaction,
						challenge.userId!
					);
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
			);
			await this.answerCallback(callback.id, 'Telegram привязан.');
			await this.sendMessage(
				'AUTH',
				chatId,
				'Telegram привязан к профилю.'
			);
			return;
		}
		await this.prisma.verificationChallenge.update({
			where: { id: challenge.id },
			data: {
				telegramUserId,
				telegramChatId: String(chatId),
				telegramUsername: callback.from.username || null,
				telegramFirstName: callback.from.first_name || null,
				telegramLastName: callback.from.last_name || null
			}
		});
		await this.answerCallback(callback.id, 'Вход подтверждён.');
		await this.sendMessage(
			'AUTH',
			chatId,
			'Вернитесь на сайт для завершения входа.'
		);
	}

	private async handleInfoMessage(message: TelegramMessage) {
		if (message.chat.type !== 'private') return;
		const requestId = this.startArgument(message.text);
		if (!requestId || !message.from) {
			await this.sendMessage(
				'INFO',
				message.chat.id,
				'Откройте Info_bot кнопкой в профиле winwidget.ru.'
			);
			return;
		}
		const now = new Date();
		const challenge = await this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.TELEGRAM,
					purpose:
						VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS,
					value: requestId
				}
			}
		});
		if (!challenge?.userId || challenge.expiresAt <= now) {
			if (challenge) {
				await this.prisma.verificationChallenge.deleteMany({
					where: { id: challenge.id }
				});
			}
			await this.sendMessage('INFO', message.chat.id, 'Ссылка истекла.');
			return;
		}
		const chatId = String(message.chat.id);
		await this.prisma.$transaction(
			async transaction => {
				const occupied =
					await transaction.telegramNotificationChannel.findUnique({
						where: { chatId }
					});
				if (occupied && occupied.userId !== challenge.userId) {
					throw new BadRequestException(
						'This Telegram chat is already linked to another profile'
					);
				}
				await transaction.telegramNotificationChannel.upsert({
					where: { userId: challenge.userId! },
					create: {
						userId: challenge.userId!,
						chatId,
						telegramUserId: String(message.from!.id),
						username: message.from!.username || null,
						firstName: message.from!.first_name || null,
						lastName: message.from!.last_name || null,
						isActive: true,
						connectedAt: now,
						disabledAt: null
					},
					update: {
						chatId,
						telegramUserId: String(message.from!.id),
						username: message.from!.username || null,
						firstName: message.from!.first_name || null,
						lastName: message.from!.last_name || null,
						isActive: true,
						connectedAt: now,
						disabledAt: null
					}
				});
				await transaction.verificationChallenge.delete({
					where: { id: challenge.id }
				});
				await this.events.emitUserChanged(transaction, challenge.userId!);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		await this.sendMessage(
			'INFO',
			chatId,
			'Telegram-уведомления подключены.'
		);
	}

	private async activeAuthWebhookChallenge(requestId: string) {
		const challenge = await this.prisma.verificationChallenge.findFirst({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				value: requestId,
				purpose: {
					in: [
						VerificationChallengePurpose.LOGIN,
						VerificationChallengePurpose.BIND_IDENTITY
					]
				}
			}
		});
		if (!challenge) return null;
		if (challenge.expiresAt > new Date()) return challenge;
		await this.prisma.verificationChallenge.deleteMany({
			where: { id: challenge.id }
		});
		return null;
	}

	private async withWebhookReceipt(
		botKind: TelegramBotKind,
		update: TelegramWebhookUpdate,
		handle: () => Promise<void>
	) {
		if (
			!Number.isSafeInteger(update.update_id) ||
			Number(update.update_id) < 0
		) {
			throw new BadRequestException('Telegram update_id is required');
		}
		const updateId = BigInt(update.update_id!);
		const payloadHash = sha256(JSON.stringify(update));
		const leaseToken = randomUUID();
		const now = new Date();
		const leaseExpiresAt = new Date(now.getTime() + WEBHOOK_LEASE_MS);
		const claim = await this.prisma.$transaction(
			async transaction => {
				const created = await transaction.telegramUpdateReceipt.createMany(
					{
						data: [
							{
								botKind,
								updateId,
								payloadHash,
								status: WebhookReceiptStatus.PROCESSING,
								attempts: 1,
								leaseToken,
								leaseExpiresAt
							}
						],
						skipDuplicates: true
					}
				);
				if (created.count === 1) return true;
				const current = await transaction.telegramUpdateReceipt.findUnique(
					{
						where: { botKind_updateId: { botKind, updateId } }
					}
				);
				if (!current || current.payloadHash !== payloadHash) {
					throw new BadRequestException(
						'Telegram update receipt mismatch'
					);
				}
				if (current.status === WebhookReceiptStatus.DELIVERED)
					return false;
				const reclaimed =
					await transaction.telegramUpdateReceipt.updateMany({
						where: {
							botKind,
							updateId,
							payloadHash,
							OR: [
								{ status: WebhookReceiptStatus.FAILED },
								{
									status: WebhookReceiptStatus.PROCESSING,
									leaseExpiresAt: { lte: now }
								}
							]
						},
						data: {
							status: WebhookReceiptStatus.PROCESSING,
							attempts: { increment: 1 },
							leaseToken,
							leaseExpiresAt,
							lastError: null
						}
					});
				if (reclaimed.count === 0) {
					throw new BadRequestException(
						'Telegram update is already processing'
					);
				}
				return true;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		if (!claim) return true;
		try {
			await handle();
			const delivered = await this.prisma.telegramUpdateReceipt.updateMany(
				{
					where: {
						botKind,
						updateId,
						leaseToken,
						status: WebhookReceiptStatus.PROCESSING
					},
					data: {
						status: WebhookReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						leaseToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				}
			);
			if (delivered.count !== 1) {
				throw new Error('Telegram update lease was lost');
			}
			return true;
		} catch (error) {
			await this.prisma.telegramUpdateReceipt.updateMany({
				where: { botKind, updateId, leaseToken },
				data: {
					status: WebhookReceiptStatus.FAILED,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: this.errorText(error)
				}
			});
			throw error;
		}
	}

	private async sendMessage(
		kind: 'AUTH' | 'INFO',
		chatId: string | number,
		text: string,
		replyMarkup?: Record<string, unknown>
	) {
		await this.telegramApi(this.botToken(kind, true), 'sendMessage', {
			chat_id: chatId,
			text,
			...(replyMarkup ? { reply_markup: replyMarkup } : {})
		});
	}

	private async answerCallback(callbackQueryId: string, text: string) {
		await this.telegramApi(
			this.botToken('AUTH', true),
			'answerCallbackQuery',
			{
				callback_query_id: callbackQueryId,
				text
			}
		);
	}

	private async telegramApi(
		token: string,
		method: string,
		body?: Record<string, unknown>
	): Promise<TelegramApiEnvelope> {
		const apiBaseUrl = this.telegramApiBaseUrl();
		let response: Response;
		try {
			response = await fetch(`${apiBaseUrl}/bot${token}/${method}`, {
				method: body ? 'POST' : 'GET',
				headers: body ? { 'content-type': 'application/json' } : undefined,
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(10_000)
			});
		} catch {
			throw new BadRequestException('Telegram API is unavailable');
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new BadRequestException('Telegram API returned invalid JSON');
		}
		if (!this.isRecord(value)) {
			throw new BadRequestException('Telegram API returned invalid JSON');
		}
		const envelope = value as TelegramApiEnvelope;
		if (!response.ok || envelope.ok !== true) {
			throw new BadRequestException(
				typeof envelope.description === 'string'
					? envelope.description.slice(0, 500)
					: 'Telegram API request failed'
			);
		}
		return envelope;
	}

	private telegramApiBaseUrl(): string {
		const mode = this.config.get<string>('MODE')?.trim().toLowerCase();
		const configured = this.config
			.get<string>('TELEGRAM_API_BASE_URL')
			?.trim();
		if (!configured) {
			if (mode === 'production') {
				throw new BadRequestException(
					'Telegram API configuration is invalid'
				);
			}
			return 'https://api.telegram.org';
		}

		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new BadRequestException(
				'Telegram API configuration is invalid'
			);
		}
		const loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(
			url.hostname
		);
		const directTelegramApi =
			url.protocol === 'https:' &&
			url.hostname === 'api.telegram.org' &&
			url.port === '' &&
			url.pathname === '/';
		const productionReverseProxy =
			url.protocol === 'https:' &&
			url.hostname === 'tg.winwidget.ru' &&
			url.port === '' &&
			url.pathname === '/telegram-api';
		const loopbackTestApi =
			mode !== 'production' && url.protocol === 'http:' && loopbackHost;
		if (
			!(mode === 'production'
				? productionReverseProxy
				: directTelegramApi ||
					productionReverseProxy ||
					loopbackTestApi) ||
			url.username !== '' ||
			url.password !== '' ||
			url.search !== '' ||
			url.hash !== ''
		) {
			throw new BadRequestException(
				'Telegram API configuration is invalid'
			);
		}
		return url.toString().replace(/\/+$/, '');
	}

	private webhookFailure(
		kind: TelegramWebhookKind,
		token: string,
		username: string,
		expectedWebhookUrl: string | null,
		error: string
	) {
		const config = this.webhookConfig(kind);
		return {
			bot: config.bot,
			title: config.title,
			configured: Boolean(token),
			ok: false,
			expectedWebhookUrl,
			webhookUrl: null,
			webhookMatchesExpected: false,
			pendingUpdateCount: null,
			lastErrorAt: null,
			lastErrorMessage: null,
			allowedUpdates: null,
			secretConfigured: Boolean(this.webhookSecret(kind)),
			configuredUsername: username || null,
			actualUsername: null,
			usernameMatchesConfigured: null,
			error
		};
	}

	private webhookConfig(kind: TelegramWebhookKind) {
		return kind === 'AUTH'
			? {
					bot: 'auth' as const,
					title: 'Auth_bot',
					allowedUpdates: ['message', 'callback_query'],
					notConfiguredError: 'Telegram auth bot is not configured'
				}
			: {
					bot: 'info' as const,
					title: 'Info_bot',
					allowedUpdates: ['message'],
					notConfiguredError: 'Telegram notification bot is not configured'
				};
	}

	private startArgument(text?: string): string | null {
		if (!text?.startsWith('/start')) return null;
		const value = text.split(/\s+/, 2)[1]?.trim();
		return value && value.length <= 255 ? value : null;
	}

	private telegramName(challenge: VerificationChallenge): string {
		const name = [challenge.telegramFirstName, challenge.telegramLastName]
			.filter(Boolean)
			.join(' ')
			.trim();
		if (name) return name;
		if (challenge.telegramUsername)
			return `@${challenge.telegramUsername}`;
		return `Telegram ${challenge.telegramUserId}`;
	}

	private webhookUrl(kind: TelegramWebhookKind): string {
		const raw =
			this.config.get<string>('TELEGRAM_WEBHOOK_HOST')?.trim() || '';
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error(
				'TELEGRAM_WEBHOOK_HOST must be a valid HTTPS origin'
			);
		}
		if (
			url.protocol !== 'https:' ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== '/'
		) {
			throw new Error(
				'TELEGRAM_WEBHOOK_HOST must be a valid HTTPS origin'
			);
		}
		return `${url.toString().replace(/\/$/, '')}/api/v1/${
			kind === 'AUTH' ? 'telegram-auth/webhook' : 'telegram-bot/webhook'
		}`;
	}

	private botToken(kind: TelegramWebhookKind, required = false): string {
		const value =
			this.config.get<string>(`TELEGRAM_${kind}_BOT_TOKEN`)?.trim() || '';
		if (required && !value) {
			throw new BadRequestException(
				kind === 'AUTH'
					? 'Telegram auth bot not configured'
					: 'Telegram notification bot not configured'
			);
		}
		return value;
	}

	private botUsername(
		kind: TelegramWebhookKind,
		required = false
	): string {
		const value =
			this.config
				.get<string>(`TELEGRAM_${kind}_BOT_USERNAME`)
				?.trim()
				.replace(/^@/, '') || '';
		if (required && !value) {
			throw new BadRequestException(
				kind === 'AUTH'
					? 'Telegram auth bot not configured'
					: 'Telegram notification bot not configured'
			);
		}
		return value;
	}

	private webhookSecret(
		kind: TelegramWebhookKind,
		required = false
	): string {
		const value =
			this.config
				.get<string>(`TELEGRAM_${kind}_BOT_WEBHOOK_SECRET`)
				?.trim() || '';
		if (required && value.length < 16) {
			throw new BadRequestException(
				'Telegram webhook secret is not configured'
			);
		}
		return value;
	}

	private assertWebhookSecret(
		kind: TelegramWebhookKind,
		supplied?: string
	) {
		const expected = this.webhookSecret(kind, true);
		if (!supplied || !safeEqual(expected, supplied)) {
			throw new UnauthorizedException(
				kind === 'AUTH'
					? 'Telegram auth webhook secret invalid'
					: 'Telegram notification webhook secret invalid'
			);
		}
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return (
			Boolean(value) && typeof value === 'object' && !Array.isArray(value)
		);
	}

	private string(value: unknown): string | undefined {
		return typeof value === 'string' ? value : undefined;
	}

	private number(value: unknown): number | undefined {
		return typeof value === 'number' && Number.isFinite(value)
			? value
			: undefined;
	}

	private errorText(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(
			0,
			2_000
		);
	}
}
