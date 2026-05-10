import { randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '@/prisma.service';
import {
	PASSWORD_SALT_ROUNDS,
	TELEGRAM_AUTH_CODE_ATTEMPTS_EXCEEDED,
	TELEGRAM_AUTH_CODE_INVALID,
	TELEGRAM_AUTH_CODE_NOT_FOUND,
	TELEGRAM_AUTH_NOT_CONFIGURED,
	TELEGRAM_AUTH_REQUEST_NOT_FOUND,
	TELEGRAM_AUTH_WEBHOOK_SECRET_INVALID
} from '@/utils/auth.constants';
import {
	BadRequestException,
	Injectable,
	Logger,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	VerificationChallengePurpose,
	VerificationChallengeType,
	type VerificationChallenge
} from '@prisma/client';
import { compare, hash } from 'bcryptjs';

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

@Injectable()
export class TelegramAuthService {
	private readonly REQUEST_EXPIRATION_MINUTES = 15;
	private readonly CODE_MAX_ATTEMPTS = 5;
	private readonly CALLBACK_PREFIX = 'winwidget_login:';
	private readonly TELEGRAM_SEND_TIMEOUT_MS = 5_000;
	private readonly logger = new Logger(TelegramAuthService.name);

	constructor(private readonly prisma: PrismaService) {}

	async start() {
		this.ensureBotConfigured();
		await this.deleteExpiredRequests();

		const requestId = this.generateRequestId();
		const codeHash = await hash(this.generateCode(), PASSWORD_SALT_ROUNDS);
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() + this.REQUEST_EXPIRATION_MINUTES * 60 * 1000
		);

		await this.prisma.verificationChallenge.create({
			data: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				value: requestId,
				codeHash,
				expiresAt,
				lastSentAt: now
			}
		});

		return {
			requestId,
			botUrl: `https://t.me/${this.getBotUsername()}?start=${requestId}`,
			expiresAt
		};
	}

	async verify(requestId: string, code: string) {
		const request = await this.getActiveLoginRequest(requestId);

		if (!request) {
			throw new UnauthorizedException(TELEGRAM_AUTH_REQUEST_NOT_FOUND);
		}

		if (!request.telegramUserId) {
			await this.deleteRequest(requestId);
			throw new UnauthorizedException(TELEGRAM_AUTH_CODE_NOT_FOUND);
		}

		if (request.attempts >= this.CODE_MAX_ATTEMPTS) {
			await this.deleteRequest(requestId);
			throw new UnauthorizedException(
				TELEGRAM_AUTH_CODE_ATTEMPTS_EXCEEDED
			);
		}

		const isValidCode = await compare(code, request.codeHash);

		if (!isValidCode) {
			const nextAttempts = request.attempts + 1;

			if (nextAttempts >= this.CODE_MAX_ATTEMPTS) {
				await this.deleteRequest(requestId);
				throw new UnauthorizedException(
					TELEGRAM_AUTH_CODE_ATTEMPTS_EXCEEDED
				);
			}

			await this.prisma.verificationChallenge.update({
				where: {
					type_purpose_value: {
						type: VerificationChallengeType.TELEGRAM,
						purpose: VerificationChallengePurpose.LOGIN,
						value: request.value
					}
				},
				data: {
					attempts: nextAttempts
				}
			});

			throw new UnauthorizedException(TELEGRAM_AUTH_CODE_INVALID);
		}

		const user = await this.findOrCreateTelegramUser(request);
		await this.deleteRequest(requestId);
		return user;
	}

	async complete(requestId: string) {
		const request = await this.getActiveLoginRequest(requestId);

		if (!request) {
			throw new UnauthorizedException(TELEGRAM_AUTH_REQUEST_NOT_FOUND);
		}

		if (!request.telegramUserId) {
			return null;
		}

		const user = await this.findOrCreateTelegramUser(request);
		await this.deleteRequest(requestId);
		return user;
	}

	async cancel(requestId: string) {
		await this.deleteRequest(requestId);
		return { cancelled: true };
	}

	async handleWebhook(update: TelegramWebhookUpdate, secret?: string) {
		this.ensureWebhookSecret(secret);

		const callbackQuery = update.callback_query;
		const message = update.message;

		if (callbackQuery) {
			this.enqueueWebhookTask('callback', update.update_id, () =>
				this.handleCallback(callbackQuery)
			);
			return true;
		}

		if (message) {
			this.enqueueWebhookTask('message', update.update_id, () =>
				this.handleMessage(message)
			);
		}

		return true;
	}

	private enqueueWebhookTask(
		updateType: string,
		updateId: number | undefined,
		task: () => Promise<void>
	) {
		setImmediate(() => {
			void task().catch(error => {
				this.logger.warn(
					`Auth_bot ${updateType} handling failed${
						updateId ? ` for update ${updateId}` : ''
					}: ${error instanceof Error ? error.message : String(error)}`
				);
			});
		});
	}

	private async handleMessage(message: TelegramMessage) {
		if (!message.text?.startsWith('/start')) {
			if (!message.chat.type || message.chat.type === 'private') {
				await this.sendMessage(
					message.chat.id,
					'Для входа или привязки Telegram откройте Auth_bot через кнопку на сайте winwidget.ru.'
				);
			}

			return;
		}

		const requestId = message.text.split(/\s+/)[1]?.trim();

		if (!requestId) {
			await this.sendMessage(
				message.chat.id,
				'Для входа в winwidget.ru откройте Telegram через кнопку на странице входа.'
			);
			return;
		}

		const request = await this.getActiveWebhookRequest(requestId);

		if (!request) {
			await this.sendMessage(
				message.chat.id,
				'Ссылка для входа истекла. Вернитесь на сайт и нажмите кнопку Telegram ещё раз.'
			);
			return;
		}

		const isBinding =
			request.purpose === VerificationChallengePurpose.BIND_IDENTITY;

		await this.sendMessage(
			message.chat.id,
			isBinding
				? 'Нажмите кнопку ниже, чтобы привязать Telegram к профилю winwidget.'
				: 'Нажмите кнопку ниже, чтобы подтвердить вход в winwidget.',
			{
				inline_keyboard: [
					[
						{
							text: isBinding
								? 'Привязать Telegram к winwidget'
								: 'Подтвердить вход в winwidget',
							callback_data: `${this.CALLBACK_PREFIX}${requestId}`
						}
					]
				]
			}
		);
	}

	private async handleCallback(callbackQuery: TelegramCallbackQuery) {
		if (!callbackQuery.data?.startsWith(this.CALLBACK_PREFIX)) {
			return;
		}

		const requestId = callbackQuery.data
			.slice(this.CALLBACK_PREFIX.length)
			.trim();
		const chatId = callbackQuery.message?.chat.id ?? callbackQuery.from.id;
		const request = await this.getActiveWebhookRequest(requestId);

		if (!request) {
			await this.answerCallbackQuery(
				callbackQuery.id,
				'Ссылка для входа истекла.'
			);
			await this.sendMessage(
				chatId,
				'Ссылка для входа истекла. Вернитесь на сайт и нажмите кнопку Telegram ещё раз.'
			);
			return;
		}

		if (request.purpose === VerificationChallengePurpose.BIND_IDENTITY) {
			await this.handleBindingCallback(callbackQuery, request, chatId);
			return;
		}

		await this.handleLoginCallback(callbackQuery, request, chatId);
	}

	private async handleLoginCallback(
		callbackQuery: TelegramCallbackQuery,
		request: VerificationChallenge,
		chatId: string | number
	) {
		const telegramUserId = String(callbackQuery.from.id);

		if (
			request.telegramUserId &&
			request.telegramUserId !== telegramUserId
		) {
			await this.answerCallbackQuery(
				callbackQuery.id,
				'Вход уже подтверждён другим Telegram-аккаунтом.'
			);
			return;
		}

		const now = new Date();

		await this.prisma.verificationChallenge.update({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.LOGIN,
					value: request.value
				}
			},
			data: {
				attempts: 0,
				telegramUserId,
				telegramChatId: String(chatId),
				telegramUsername: callbackQuery.from.username ?? null,
				telegramFirstName: callbackQuery.from.first_name ?? null,
				telegramLastName: callbackQuery.from.last_name ?? null,
				lastSentAt: now
			}
		});

		await this.answerCallbackQuery(callbackQuery.id, 'Вход подтверждён.');
		await this.sendMessage(
			chatId,
			'Вход через Telegram подтверждён. Вернитесь на сайт, статус обновится автоматически.'
		);
	}

	private async handleBindingCallback(
		callbackQuery: TelegramCallbackQuery,
		request: VerificationChallenge,
		chatId: string | number
	) {
		if (!request.userId) {
			await this.answerCallbackQuery(
				callbackQuery.id,
				'Ссылка для привязки истекла.'
			);
			return;
		}

		const telegramUserId = String(callbackQuery.from.id);
		const currentIdentity = await this.prisma.authIdentity.findUnique({
			where: {
				userId_type: {
					userId: request.userId,
					type: AuthIdentityType.TELEGRAM
				}
			}
		});

		if (currentIdentity) {
			await this.deleteRequestById(request.id);
			await this.answerCallbackQuery(
				callbackQuery.id,
				'Telegram уже привязан.'
			);
			await this.sendMessage(
				chatId,
				'Telegram уже привязан к этому профилю winwidget.ru.'
			);
			return;
		}

		const existingIdentity = await this.prisma.authIdentity.findUnique({
			where: {
				type_value: {
					type: AuthIdentityType.TELEGRAM,
					value: telegramUserId
				}
			}
		});

		if (existingIdentity && existingIdentity.userId !== request.userId) {
			await this.answerCallbackQuery(
				callbackQuery.id,
				'Этот Telegram уже привязан к другому профилю.'
			);
			await this.sendMessage(
				chatId,
				'Этот Telegram уже привязан к другому профилю winwidget.ru.'
			);
			return;
		}

		await this.prisma.$transaction([
			this.prisma.authIdentity.create({
				data: {
					userId: request.userId,
					type: AuthIdentityType.TELEGRAM,
					value: telegramUserId,
					verifiedAt: new Date()
				}
			}),
			this.prisma.verificationChallenge.delete({
				where: {
					id: request.id
				}
			})
		]);

		await this.answerCallbackQuery(callbackQuery.id, 'Telegram привязан.');
		await this.sendMessage(
			chatId,
			'Telegram привязан к профилю winwidget.ru. Вернитесь на сайт, статус обновится автоматически.'
		);
	}

	private async findOrCreateTelegramUser(request: VerificationChallenge) {
		const telegramUserId = request.telegramUserId!;
		const identity = await this.prisma.authIdentity.findUnique({
			where: {
				type_value: {
					type: AuthIdentityType.TELEGRAM,
					value: telegramUserId
				}
			},
			include: {
				user: {
					include: {
						authIdentities: true
					}
				}
			}
		});

		if (identity?.user) {
			return identity.user;
		}

		const displayName = this.getTelegramDisplayName(request);

		return this.prisma.user.create({
			data: {
				name: displayName,
				password: '',
				authIdentities: {
					create: {
						type: AuthIdentityType.TELEGRAM,
						value: telegramUserId,
						verifiedAt: new Date()
					}
				}
			},
			include: {
				authIdentities: true
			}
		});
	}

	private getTelegramDisplayName(request: VerificationChallenge) {
		const fullName = [request.telegramFirstName, request.telegramLastName]
			.filter(Boolean)
			.join(' ')
			.trim();

		if (fullName) return fullName;
		if (request.telegramUsername) return `@${request.telegramUsername}`;

		return `Telegram ${request.telegramUserId}`;
	}

	private async getActiveLoginRequest(requestId: string) {
		const request = await this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.LOGIN,
					value: requestId
				}
			}
		});

		if (!request) {
			return null;
		}

		if (request.expiresAt.getTime() < Date.now()) {
			await this.deleteRequest(requestId);
			return null;
		}

		return request;
	}

	private async getActiveWebhookRequest(requestId: string) {
		const request = await this.prisma.verificationChallenge.findFirst({
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

		if (!request) {
			return null;
		}

		if (request.expiresAt.getTime() < Date.now()) {
			await this.deleteRequestById(request.id);
			return null;
		}

		return request;
	}

	private async deleteRequest(requestId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				value: requestId
			}
		});
	}

	private async deleteRequestById(id: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				id
			}
		});
	}

	private async deleteExpiredRequests() {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				expiresAt: {
					lt: new Date()
				}
			}
		});
	}

	private async sendMessage(
		chatId: string | number,
		text: string,
		replyMarkup?: Record<string, unknown>
	) {
		const token = this.getBotToken();
		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: AbortSignal.timeout(this.TELEGRAM_SEND_TIMEOUT_MS),
				body: JSON.stringify({
					chat_id: chatId,
					text,
					...(replyMarkup ? { reply_markup: replyMarkup } : {})
				})
			}
		);

		if (!response.ok) {
			throw new BadRequestException('Telegram auth bot request failed');
		}
	}

	private async answerCallbackQuery(
		callbackQueryId: string,
		text: string
	) {
		const token = this.getBotToken();
		await fetch(
			`https://api.telegram.org/bot${token}/answerCallbackQuery`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: AbortSignal.timeout(this.TELEGRAM_SEND_TIMEOUT_MS),
				body: JSON.stringify({
					callback_query_id: callbackQueryId,
					text
				})
			}
		);
	}

	private ensureBotConfigured() {
		if (!this.getBotToken() || !this.getBotUsername()) {
			throw new BadRequestException(TELEGRAM_AUTH_NOT_CONFIGURED);
		}
	}

	private ensureWebhookSecret(secret?: string) {
		const expected = process.env.TELEGRAM_AUTH_BOT_WEBHOOK_SECRET?.trim();

		if (expected && secret !== expected) {
			throw new UnauthorizedException(
				TELEGRAM_AUTH_WEBHOOK_SECRET_INVALID
			);
		}
	}

	private getBotToken() {
		return process.env.TELEGRAM_AUTH_BOT_TOKEN?.trim() ?? '';
	}

	private getBotUsername() {
		return (
			process.env.TELEGRAM_AUTH_BOT_USERNAME?.trim().replace(/^@/, '') ??
			''
		);
	}

	private generateRequestId() {
		return randomBytes(16).toString('hex');
	}

	private generateCode() {
		return `${randomInt(100000, 1000000)}`;
	}
}
