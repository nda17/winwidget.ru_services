import { randomBytes } from 'node:crypto';
import { PrismaService } from '@/prisma.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	PASSWORD_SALT_ROUNDS,
	TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED,
	TELEGRAM_NOTIFICATION_WEBHOOK_SECRET_INVALID
} from '@/utils/auth.constants';
import {
	BadRequestException,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	PaymentStatus,
	SubscriptionStatus,
	type TelegramBotSettings,
	type TelegramNotificationChannel,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/client';
import { hash } from 'bcryptjs';

interface DailySummaryPeriod {
	start: Date;
	end: Date;
	label: string;
}

interface DailySummaryStats {
	period: DailySummaryPeriod;
	generatedAtLabel: string;
	newUsersCount: number;
	succeededPaymentsCount: number;
	succeededPaymentsAmount: number;
	pendingPaymentsCount: number;
	currentPendingPaymentsCount: number;
	cancelledPaymentsCount: number;
	leads: {
		total: number;
		wheel: number;
		quiz: number;
		callback: number;
		countdownTimer: number;
	};
	expiringSubscriptionsCount: number;
	expiredActiveSubscriptionsCount: number;
	usersWithoutEmailCount: number;
	usersWithoutPhoneCount: number;
	usersWithoutContactsCount: number;
}

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
	text?: string;
	chat: TelegramChat;
	from?: TelegramUser;
};

export type TelegramInfoBotWebhookUpdate = {
	message?: TelegramMessage;
};

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
	private readonly DAILY_SUMMARY_HOUR_MOSCOW = 1;
	private readonly DAILY_SUMMARY_MINUTE_MOSCOW = 50;
	private readonly NOTIFICATION_BINDING_EXPIRATION_MINUTES = 15;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(TelegramBotService.name);
	private summaryTimeout: NodeJS.Timeout | null = null;

	constructor(private readonly prisma: PrismaService) {}

	async onModuleInit() {
		await this.sendMissedDailySummaryIfNeeded();
		this.scheduleDailySummary();
	}

	onModuleDestroy() {
		if (this.summaryTimeout) {
			clearTimeout(this.summaryTimeout);
			this.summaryTimeout = null;
		}
	}

	async getSettings() {
		const settings = await this.getOrCreateSettings();
		return this.serializeSettings(settings);
	}

	async updateSettings(dto: UpdateTelegramBotSettingsDto) {
		const currentSettings = await this.getOrCreateSettings();
		const data = this.getSettingsPatch(dto);
		const nextDailySummaryEnabled =
			data.dailySummaryEnabled ?? currentSettings.dailySummaryEnabled;
		const nextDailySummaryChatId =
			data.dailySummaryChatId ?? currentSettings.dailySummaryChatId;

		if (nextDailySummaryEnabled && !nextDailySummaryChatId.trim()) {
			throw new BadRequestException('Укажите ID группы Telegram');
		}

		const settings = await this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: data,
			create: {
				id: 'singleton',
				...data
			}
		});

		return this.serializeSettings(settings);
	}

	async sendInfoBotMessage(chatId: string, text: string) {
		const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

		if (!token) {
			throw new Error('Info_bot token is not configured');
		}

		await this.sendTelegramMessage(token, chatId, text);
	}

	async getNotificationStatus(userId: string) {
		const channel =
			await this.prisma.telegramNotificationChannel.findUnique({
				where: { userId }
			});

		return this.serializeNotificationStatus(channel);
	}

	async startNotificationBinding(userId: string) {
		this.ensureNotificationBotConfigured();
		await this.deleteExpiredNotificationBindings();

		const requestId = randomBytes(16).toString('hex');
		const codeHash = await hash(requestId, PASSWORD_SALT_ROUNDS);
		const now = new Date();
		const expiresAt = new Date(
			now.getTime() +
				this.NOTIFICATION_BINDING_EXPIRATION_MINUTES * 60 * 1000
		);

		await this.prisma.verificationChallenge.upsert({
			where: {
				userId_type_purpose: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
				}
			},
			update: {
				value: requestId,
				passwordHash: null,
				codeHash,
				attempts: 0,
				telegramUserId: null,
				telegramChatId: null,
				telegramUsername: null,
				telegramFirstName: null,
				telegramLastName: null,
				expiresAt,
				lastSentAt: now
			},
			create: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS,
				value: requestId,
				codeHash,
				expiresAt,
				lastSentAt: now
			}
		});

		return {
			requestId,
			botUrl: `https://t.me/${this.getInfoBotUsername()}?start=${requestId}`,
			expiresAt
		};
	}

	async handleWebhook(
		update: TelegramInfoBotWebhookUpdate,
		secret?: string
	) {
		this.ensureNotificationWebhookSecret(secret);

		if (update.message) {
			await this.handleNotificationMessage(update.message);
		}

		return true;
	}

	isRecipientUnavailableError(error: unknown) {
		const message =
			error instanceof Error
				? error.message.toLowerCase()
				: String(error).toLowerCase();

		return (
			message.includes('bot was blocked') ||
			message.includes('chat not found') ||
			message.includes('user is deactivated') ||
			message.includes('forbidden')
		);
	}

	async deactivateNotificationChannelByChatId(chatId: string) {
		await this.prisma.telegramNotificationChannel.updateMany({
			where: { chatId },
			data: {
				isActive: false,
				disabledAt: new Date()
			}
		});
	}

	private getSettingsPatch(dto: UpdateTelegramBotSettingsDto) {
		return {
			...(typeof dto.dailySummaryEnabled === 'boolean'
				? { dailySummaryEnabled: dto.dailySummaryEnabled }
				: {}),
			...(typeof dto.dailySummaryChatId === 'string'
				? { dailySummaryChatId: dto.dailySummaryChatId.trim() }
				: {})
		};
	}

	private async getOrCreateSettings() {
		return this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}

	private serializeSettings(settings: TelegramBotSettings) {
		return {
			dailySummaryEnabled: settings.dailySummaryEnabled,
			dailySummaryChatId: settings.dailySummaryChatId,
			dailySummaryLastSentPeriodStart:
				settings.dailySummaryLastSentPeriodStart?.toISOString() ?? null,
			dailySummaryLastSentAt:
				settings.dailySummaryLastSentAt?.toISOString() ?? null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_BOT_TOKEN?.trim()
			),
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private serializeNotificationStatus(
		channel: TelegramNotificationChannel | null
	) {
		return {
			connected: Boolean(channel?.isActive),
			username: channel?.username ?? null,
			connectedAt:
				channel?.isActive && channel.connectedAt
					? channel.connectedAt.toISOString()
					: null,
			disabledAt: channel?.disabledAt?.toISOString() ?? null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername())
		};
	}

	private async handleNotificationMessage(message: TelegramMessage) {
		if (!message.text?.startsWith('/start')) {
			return;
		}

		const chatId = String(message.chat.id);
		const requestId = message.text.split(/\s+/)[1]?.trim();

		if (message.chat.type && message.chat.type !== 'private') {
			await this.sendInfoBotMessage(
				chatId,
				'Подключите уведомления winwidget.ru в личном чате с Info_bot.'
			);
			return;
		}

		if (!requestId) {
			await this.sendInfoBotMessage(
				chatId,
				'Чтобы подключить уведомления, откройте профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений.'
			);
			return;
		}

		const request = await this.getActiveNotificationRequest(requestId);

		if (!request?.userId) {
			await this.sendInfoBotMessage(
				chatId,
				'Ссылка подключения уведомлений истекла. Вернитесь в профиль winwidget.ru и создайте новую ссылку.'
			);
			return;
		}

		const telegramUserId = message.from?.id
			? String(message.from.id)
			: null;
		const linkedChannel =
			await this.prisma.telegramNotificationChannel.findFirst({
				where: {
					OR: [{ chatId }, ...(telegramUserId ? [{ telegramUserId }] : [])]
				}
			});

		if (linkedChannel && linkedChannel.userId !== request.userId) {
			await this.sendInfoBotMessage(
				chatId,
				'Этот Telegram уже подключён к другому профилю winwidget.ru.'
			);
			return;
		}

		const now = new Date();

		await this.prisma.$transaction([
			this.prisma.telegramNotificationChannel.upsert({
				where: {
					userId: request.userId
				},
				update: {
					chatId,
					telegramUserId,
					username: message.from?.username ?? null,
					firstName: message.from?.first_name ?? null,
					lastName: message.from?.last_name ?? null,
					isActive: true,
					connectedAt: now,
					disabledAt: null
				},
				create: {
					userId: request.userId,
					chatId,
					telegramUserId,
					username: message.from?.username ?? null,
					firstName: message.from?.first_name ?? null,
					lastName: message.from?.last_name ?? null,
					isActive: true,
					connectedAt: now
				}
			}),
			this.prisma.verificationChallenge.delete({
				where: {
					id: request.id
				}
			})
		]);

		await this.sendInfoBotMessage(
			chatId,
			'Telegram-уведомления winwidget.ru подключены. Напоминания о подписке будут приходить сюда.'
		);
	}

	private async getActiveNotificationRequest(requestId: string) {
		const request = await this.prisma.verificationChallenge.findUnique({
			where: {
				type_purpose_value: {
					type: VerificationChallengeType.TELEGRAM,
					purpose:
						VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS,
					value: requestId
				}
			}
		});

		if (!request) return null;

		if (request.expiresAt.getTime() < Date.now()) {
			await this.deleteNotificationRequestById(request.id);
			return null;
		}

		return request;
	}

	private async deleteNotificationRequestById(id: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				id
			}
		});
	}

	private async deleteExpiredNotificationBindings() {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS,
				expiresAt: {
					lt: new Date()
				}
			}
		});
	}

	private ensureNotificationBotConfigured() {
		if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
			throw new BadRequestException(
				TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED
			);
		}

		if (!this.getInfoBotUsername()) {
			throw new BadRequestException(
				TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED
			);
		}
	}

	private ensureNotificationWebhookSecret(secret?: string) {
		const expected = process.env.TELEGRAM_BOT_WEBHOOK_SECRET?.trim();

		if (expected && secret !== expected) {
			throw new UnauthorizedException(
				TELEGRAM_NOTIFICATION_WEBHOOK_SECRET_INVALID
			);
		}
	}

	private getInfoBotUsername() {
		return (
			process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') ?? ''
		);
	}

	private scheduleDailySummary() {
		const nextRun = this.getNextDailySummaryDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);
		const moscowTime = new Date(
			nextRun.getTime() + this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000
		);

		this.logger.log(
			`Next Telegram daily summary scheduled for ${moscowTime.toISOString().replace('T', ' ').slice(0, 16)} MSK.`
		);

		this.summaryTimeout = setTimeout(async () => {
			try {
				const sent = await this.sendDailySummaryIfEnabled();
				this.logger.log(
					sent
						? 'Telegram daily summary sent.'
						: 'Telegram daily summary skipped.'
				);
			} catch (error) {
				this.logger.error(
					`Telegram daily summary failed: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			} finally {
				this.scheduleDailySummary();
			}
		}, delay);

		this.summaryTimeout.unref?.();
	}

	private async sendMissedDailySummaryIfNeeded() {
		if (!this.shouldRunStartupDailySummary()) {
			return;
		}

		try {
			const sent = await this.sendDailySummaryIfEnabled();
			this.logger.log(
				sent
					? 'Missed Telegram daily summary sent on startup.'
					: 'No missed Telegram daily summary to send on startup.'
			);
		} catch (error) {
			this.logger.error(
				`Telegram daily summary startup check failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async sendDailySummaryIfEnabled() {
		const settings = await this.getOrCreateSettings();
		const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();

		if (!settings.dailySummaryEnabled || !chatId || !token) {
			return false;
		}

		const period = this.getPreviousMoscowDayPeriod();

		if (
			settings.dailySummaryLastSentPeriodStart?.getTime() ===
			period.start.getTime()
		) {
			return false;
		}

		const stats = await this.collectDailySummaryStats(period);
		const text = this.buildDailySummaryMessage(stats);

		await this.sendTelegramMessage(token, chatId, text);

		await this.prisma.telegramBotSettings.update({
			where: { id: 'singleton' },
			data: {
				dailySummaryLastSentPeriodStart: period.start,
				dailySummaryLastSentAt: new Date()
			}
		});

		return true;
	}

	private async collectDailySummaryStats(period: DailySummaryPeriod) {
		const range = {
			gte: period.start,
			lt: period.end
		};
		const now = new Date();
		const soonEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

		const [
			newUsersCount,
			succeededPayments,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			cancelledPaymentsCount,
			wheelLeadsCount,
			quizLeadsCount,
			callbackLeadsCount,
			countdownTimerLeadsCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutEmailCount,
			usersWithoutPhoneCount,
			usersWithoutContactsCount
		] = await Promise.all([
			this.prisma.user.count({
				where: { createdAt: range }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: range
				},
				select: { amount: true }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.PENDING,
					createdAt: range
				}
			}),
			this.prisma.payment.count({
				where: { status: PaymentStatus.PENDING }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.CANCELLED,
					updatedAt: range
				}
			}),
			this.prisma.lead.count({ where: { createdAt: range } }),
			this.prisma.quizLead.count({ where: { createdAt: range } }),
			this.prisma.callbackLead.count({ where: { createdAt: range } }),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: range }
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: {
						gte: now,
						lt: soonEndsAt
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: {
						lt: now
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: { type: AuthIdentityType.EMAIL }
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: { type: AuthIdentityType.PHONE }
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: {
							type: {
								in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
							}
						}
					}
				}
			})
		]);

		const leadsTotal =
			wheelLeadsCount +
			quizLeadsCount +
			callbackLeadsCount +
			countdownTimerLeadsCount;

		return {
			period,
			generatedAtLabel: this.formatMoscowDateTime(new Date()),
			newUsersCount,
			succeededPaymentsCount: succeededPayments.length,
			succeededPaymentsAmount: this.getPaymentsAmount(succeededPayments),
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			cancelledPaymentsCount,
			leads: {
				total: leadsTotal,
				wheel: wheelLeadsCount,
				quiz: quizLeadsCount,
				callback: callbackLeadsCount,
				countdownTimer: countdownTimerLeadsCount
			},
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutEmailCount,
			usersWithoutPhoneCount,
			usersWithoutContactsCount
		};
	}

	private buildDailySummaryMessage(stats: DailySummaryStats) {
		return [
			'<b>Ежедневная сводка WinWidget</b>',
			`Период: ${stats.period.label}`,
			`Сформировано: ${stats.generatedAtLabel} МСК`,
			'',
			'<b>Пользователи</b>',
			`- Новые регистрации: ${stats.newUsersCount}`,
			`- Без email: ${stats.usersWithoutEmailCount}`,
			`- Без телефона: ${stats.usersWithoutPhoneCount}`,
			`- Без email и телефона: ${stats.usersWithoutContactsCount}`,
			'',
			'<b>Платежи</b>',
			`- Успешные оплаты: ${stats.succeededPaymentsCount}`,
			`- Сумма успешных оплат: ${this.formatMoney(stats.succeededPaymentsAmount)}`,
			`- Pending за период: ${stats.pendingPaymentsCount}`,
			`- Pending сейчас: ${stats.currentPendingPaymentsCount}`,
			`- Отменённые за период: ${stats.cancelledPaymentsCount}`,
			'',
			'<b>Лиды</b>',
			`- Всего: ${stats.leads.total}`,
			`- Колесо: ${stats.leads.wheel}`,
			`- Квизы: ${stats.leads.quiz}`,
			`- Обратный звонок: ${stats.leads.callback}`,
			`- Таймеры: ${stats.leads.countdownTimer}`,
			'',
			'<b>Подписки</b>',
			`- Истекают в ближайшие 7 дней: ${stats.expiringSubscriptionsCount}`,
			`- Истекли, но ещё ACTIVE: ${stats.expiredActiveSubscriptionsCount}`
		].join('\n');
	}

	private async sendTelegramMessage(
		token: string,
		chatId: string,
		text: string
	) {
		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text,
					parse_mode: 'HTML',
					disable_web_page_preview: true
				})
			}
		);

		const data = (await response.json().catch(() => null)) as {
			ok?: boolean;
			description?: string;
		} | null;

		if (!response.ok || !data?.ok) {
			throw new Error(
				`Telegram sendMessage failed: ${data?.description ?? `HTTP ${response.status}`}`
			);
		}
	}

	private getPaymentsAmount(payments: Array<{ amount: string }>) {
		return payments.reduce(
			(total, payment) => total + this.parsePaymentAmount(payment.amount),
			0
		);
	}

	private parsePaymentAmount(value: string) {
		const amount = Number(value.replace(',', '.'));
		return Number.isFinite(amount) ? amount : 0;
	}

	private formatMoney(value: number) {
		return new Intl.NumberFormat('ru-RU', {
			style: 'currency',
			currency: 'RUB',
			maximumFractionDigits: 2
		}).format(value);
	}

	private getPreviousMoscowDayPeriod(): DailySummaryPeriod {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedTodayStart = new Date(shiftedNow);
		shiftedTodayStart.setUTCHours(0, 0, 0, 0);

		const shiftedPeriodStart = new Date(shiftedTodayStart);
		shiftedPeriodStart.setUTCDate(shiftedPeriodStart.getUTCDate() - 1);

		const start = new Date(shiftedPeriodStart.getTime() - offsetMs);
		const end = new Date(shiftedTodayStart.getTime() - offsetMs);
		const labelEnd = new Date(end.getTime() - 60 * 1000);

		return {
			start,
			end,
			label: `${this.formatMoscowDateTime(start)} - ${this.formatMoscowDateTime(labelEnd)} МСК`
		};
	}

	private formatMoscowDateTime(date: Date) {
		return date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	private getNextDailySummaryDate() {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedNextRun = new Date(shiftedNow);

		shiftedNextRun.setUTCHours(
			this.DAILY_SUMMARY_HOUR_MOSCOW,
			this.DAILY_SUMMARY_MINUTE_MOSCOW,
			0,
			0
		);

		if (shiftedNextRun.getTime() <= shiftedNow.getTime()) {
			shiftedNextRun.setUTCDate(shiftedNextRun.getUTCDate() + 1);
		}

		return new Date(shiftedNextRun.getTime() - offsetMs);
	}

	private shouldRunStartupDailySummary() {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedRun = new Date(shiftedNow);

		shiftedRun.setUTCHours(
			this.DAILY_SUMMARY_HOUR_MOSCOW,
			this.DAILY_SUMMARY_MINUTE_MOSCOW,
			0,
			0
		);

		return shiftedNow.getTime() >= shiftedRun.getTime();
	}
}
