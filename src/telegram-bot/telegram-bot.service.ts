import { PrismaService } from '@/prisma.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	PASSWORD_SALT_ROUNDS,
	TELEGRAM_AUTH_NOT_CONFIGURED,
	TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED,
	TELEGRAM_NOTIFICATION_WEBHOOK_SECRET_INVALID,
	TELEGRAM_SUPPORT_BOT_NOT_CONFIGURED,
	TELEGRAM_SUPPORT_WEBHOOK_SECRET_INVALID
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
	BillingPeriod,
	PaymentStatus,
	Plan,
	Role,
	SubscriptionStatus,
	type TelegramBotSettings,
	type TelegramNotificationChannel,
	type VerificationChallenge,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/client';
import { hash } from 'bcryptjs';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
	mkdir,
	readFile,
	stat,
	unlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const DATABASE_BACKUP_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;

interface DailySummaryPeriod {
	start: Date;
	end: Date;
	label: string;
}

interface DailySummaryStats {
	period: DailySummaryPeriod;
	generatedAtLabel: string;
	totalUsersCount: number;
	usersByRole: {
		user: number;
		admin: number;
		dev: number;
	};
	newUsersCount: number;
	previousDayNewUsersCount: number;
	averageNewUsersCount7d: number;
	succeededPaymentsCount: number;
	succeededPaymentsAmount: number;
	previousDaySucceededPaymentsAmount: number;
	currentMonthSucceededPaymentsAmount: number;
	firstPaymentsCount: number;
	repeatPaymentsCount: number;
	averagePaymentAmount: number | null;
	pendingPaymentsCount: number;
	currentPendingPaymentsCount: number;
	stalePendingPaymentsCount: number;
	cancelledPaymentsCount: number;
	leads: {
		total: number;
		previousDayTotal: number;
		averageTotal7d: number;
		wheel: number;
		quiz: number;
		callback: number;
		countdownTimer: number;
		stopOffer: number;
		onlineConsultant: number;
		calculator: number;
	};
	expiringSubscriptionsTodayCount: number;
	expiringSubscriptions3dCount: number;
	expiringSubscriptionsCount: number;
	expiredActiveSubscriptionsCount: number;
	usersWithoutContactsCount: number;
}

type TelegramUser = {
	id: number;
	is_bot?: boolean;
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
	message_thread_id?: number;
	text?: string;
	caption?: string;
	chat: TelegramChat;
	from?: TelegramUser;
	reply_to_message?: TelegramMessage;
};

export type TelegramInfoBotWebhookUpdate = {
	update_id?: number;
	message?: TelegramMessage;
};

export type TelegramSupportBotWebhookUpdate = {
	update_id?: number;
	message?: TelegramMessage;
};

export type TelegramWebhookBot = 'info' | 'auth' | 'support';

export interface PaymentSucceededNotification {
	paymentId: string;
	yookassaId: string;
	amount: string;
	plan: Plan;
	billingPeriod: BillingPeriod;
	userId: string;
	userName: string | null;
	email: string | null;
	phone: string | null;
	succeededAt: Date;
}

interface TelegramWebhookConfig {
	bot: TelegramWebhookBot;
	title: string;
	token?: string;
	username?: string;
	secret?: string;
	path: string;
	allowedUpdates: string[];
}

type TelegramWebhookInfo = {
	ok?: boolean;
	result?: {
		url?: string;
		pending_update_count?: number;
		last_error_date?: number;
		last_error_message?: string;
		allowed_updates?: string[];
	};
	description?: string;
};

type TelegramBotInfo = {
	ok?: boolean;
	result?: {
		username?: string;
	};
};

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
	private readonly DEFAULT_DAILY_SUMMARY_TIME = '01:50';
	private readonly DEFAULT_DATABASE_BACKUP_TIME = '01:45';
	private readonly MIN_TELEGRAM_TASK_TIME_GAP_MINUTES = 5;
	private readonly NOTIFICATION_BINDING_EXPIRATION_MINUTES = 15;
	private readonly TELEGRAM_SEND_TIMEOUT_MS = 5_000;
	private readonly TELEGRAM_API_STATUS_TIMEOUT_MS = 10_000;
	private readonly TELEGRAM_WEBHOOK_MAX_CONNECTIONS = 40;
	private readonly TELEGRAM_WEBHOOK_HEALTHCHECK_INTERVAL_MS = 60_000;
	private readonly DATABASE_BACKUP_TIMEOUT_MS = 10 * 60 * 1000;
	private readonly DATABASE_RESTORE_CONFIRMATION = 'ВОССТАНОВИТЬ БД';
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(TelegramBotService.name);
	private summaryTimeout: NodeJS.Timeout | null = null;
	private databaseBackupTimeout: NodeJS.Timeout | null = null;
	private webhookHealthcheckInterval: NodeJS.Timeout | null = null;
	private webhookHealthcheckInProgress = false;
	private databaseBackupInProgress = false;
	private databaseRestoreInProgress = false;

	constructor(private readonly prisma: PrismaService) {}

	async onModuleInit() {
		void this.ensureWebhooksOnStartup();
		await this.sendMissedDailyDatabaseBackupIfNeeded();
		await this.sendMissedDailySummaryIfNeeded();
		this.scheduleWebhookHealthcheck();
		void this.scheduleDailyDatabaseBackup();
		void this.scheduleDailySummary();
	}

	onModuleDestroy() {
		if (this.summaryTimeout) {
			clearTimeout(this.summaryTimeout);
			this.summaryTimeout = null;
		}

		if (this.databaseBackupTimeout) {
			clearTimeout(this.databaseBackupTimeout);
			this.databaseBackupTimeout = null;
		}

		if (this.webhookHealthcheckInterval) {
			clearInterval(this.webhookHealthcheckInterval);
			this.webhookHealthcheckInterval = null;
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
		const nextDatabaseBackupEnabled =
			data.databaseBackupEnabled ?? currentSettings.databaseBackupEnabled;
		const nextDailySummaryChatId =
			data.dailySummaryChatId ?? currentSettings.dailySummaryChatId;
		const nextDatabaseBackupThreadId =
			data.databaseBackupThreadId !== undefined
				? data.databaseBackupThreadId
				: currentSettings.databaseBackupThreadId;
		const nextSupportThreadId =
			data.supportThreadId !== undefined
				? data.supportThreadId
				: currentSettings.supportThreadId;
		const nextPaymentsThreadId =
			data.paymentsThreadId !== undefined
				? data.paymentsThreadId
				: currentSettings.paymentsThreadId;
		const nextReportsThreadId =
			data.reportsThreadId !== undefined
				? data.reportsThreadId
				: currentSettings.reportsThreadId;
		const nextDailySummaryTime =
			data.dailySummaryTime ?? currentSettings.dailySummaryTime;
		const nextDatabaseBackupTime =
			data.databaseBackupTime ?? currentSettings.databaseBackupTime;

		this.ensureScheduleTimesSeparated(
			nextDailySummaryTime,
			nextDatabaseBackupTime
		);

		if (
			!nextDailySummaryChatId.trim() &&
			[
				nextSupportThreadId,
				nextDatabaseBackupThreadId,
				nextPaymentsThreadId,
				nextReportsThreadId
			].some(Boolean)
		) {
			throw new BadRequestException(
				'Укажите ID Telegram-группы для настроенных топиков'
			);
		}

		const updatesDailySummaryDelivery =
			'dailySummaryEnabled' in data ||
			'dailySummaryChatId' in data ||
			'dailySummaryTime' in data ||
			'reportsThreadId' in data;
		const updatesDatabaseBackupDelivery =
			'databaseBackupEnabled' in data ||
			'dailySummaryChatId' in data ||
			'databaseBackupTime' in data ||
			'databaseBackupThreadId' in data;

		if (updatesDailySummaryDelivery && nextDailySummaryEnabled) {
			if (!nextDailySummaryChatId.trim()) {
				throw new BadRequestException(
					'Укажите ID Telegram-группы для отправки отчётов'
				);
			}

			if (!nextReportsThreadId) {
				throw new BadRequestException('Укажите ID топика Reports');
			}
		}

		if (updatesDatabaseBackupDelivery && nextDatabaseBackupEnabled) {
			if (!nextDailySummaryChatId.trim()) {
				throw new BadRequestException(
					'Укажите ID Telegram-группы для отправки backup'
				);
			}

			if (!nextDatabaseBackupThreadId) {
				throw new BadRequestException('Укажите ID топика Backups');
			}
		}

		const settings = await this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: data,
			create: {
				id: 'singleton',
				...data
			}
		});

		if ('dailySummaryTime' in data || 'dailySummaryEnabled' in data) {
			this.rescheduleDailySummary();
		}

		if ('databaseBackupTime' in data || 'databaseBackupEnabled' in data) {
			this.rescheduleDailyDatabaseBackup();
		}

		return this.serializeSettings(settings);
	}

	async reinstallWebhook(bot: TelegramWebhookBot) {
		const config = this.getWebhookConfig(bot);
		const webhookUrl = this.getWebhookUrl(config.path);

		if (!config.token?.trim()) {
			throw new BadRequestException(this.getBotNotConfiguredError(bot));
		}

		try {
			await this.deleteTelegramWebhook(config, true);
			await this.setTelegramWebhook(config, true);
		} catch (error) {
			throw new BadRequestException(
				`Не удалось установить webhook ${config.title}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}

		return {
			bot: config.bot,
			title: config.title,
			webhookUrl,
			dropPendingUpdates: true,
			allowedUpdates: config.allowedUpdates,
			secretConfigured: Boolean(config.secret?.trim()),
			installedAt: new Date().toISOString()
		};
	}

	async reinstallWebhooks() {
		const [info, auth, support] = await Promise.all([
			this.reinstallWebhook('info'),
			this.reinstallWebhook('auth'),
			this.reinstallWebhook('support')
		]);

		return { items: [info, auth, support] };
	}

	async getWebhookStatuses() {
		const configs: TelegramWebhookConfig[] = [
			this.getWebhookConfig('info'),
			this.getWebhookConfig('auth'),
			this.getWebhookConfig('support')
		];

		const items = await Promise.all(
			configs.map(config => this.getSyncedWebhookStatus(config))
		);

		return { items };
	}

	getWebhookHealth() {
		const webhookHost = this.getConfiguredWebhookHost();

		return {
			ok: Boolean(webhookHost),
			mode: process.env.MODE?.trim() || null,
			webhookHostConfigured: Boolean(webhookHost),
			webhookHost: webhookHost || null,
			expectedWebhooks: webhookHost
				? {
						info: `${webhookHost}/api/telegram-bot/webhook`,
						auth: `${webhookHost}/api/telegram-auth/webhook`,
						support: `${webhookHost}/api/telegram-bot/support-webhook`
					}
				: null,
			checkedAt: new Date().toISOString()
		};
	}

	async createAndSendDatabaseBackup(trigger: 'manual' | 'scheduled') {
		if (trigger === 'manual') {
			const settings = await this.getOrCreateSettings();
			this.getDatabaseBackupDestination(settings);
		}

		const result = await this.createDatabaseBackupFile();

		try {
			const sent = await this.sendDatabaseBackupFile(
				result.filePath,
				trigger
			);

			return {
				...result,
				sent
			};
		} finally {
			await this.deleteTempFile(result.filePath);
		}
	}

	async restoreDatabaseBackup(
		file: Express.Multer.File | undefined,
		confirmation: string
	) {
		if (this.databaseRestoreInProgress) {
			throw new BadRequestException('Восстановление базы уже выполняется');
		}

		if (confirmation !== this.DATABASE_RESTORE_CONFIRMATION) {
			throw new BadRequestException(
				`Введите подтверждение: ${this.DATABASE_RESTORE_CONFIRMATION}`
			);
		}

		if (!file?.buffer?.length) {
			throw new BadRequestException('Файл backup не передан');
		}

		if (file.size > DATABASE_BACKUP_MAX_FILE_SIZE_BYTES) {
			throw new BadRequestException(
				'Файл backup должен быть меньше 49 МБ'
			);
		}

		const originalName = file.originalname || 'database-backup.dump';
		const extension = originalName.toLowerCase().split('.').pop();

		if (extension !== 'dump') {
			throw new BadRequestException('Загрузите backup в формате .dump');
		}

		this.databaseRestoreInProgress = true;
		const backupPath = await this.writeUploadedBackupFile(file);
		const database = this.getPostgresCommandConnection();

		try {
			await this.prisma.$disconnect();
			await this.runPostgresCommand('pg_restore', [
				'--exit-on-error',
				'--clean',
				'--if-exists',
				'--no-owner',
				'--no-privileges',
				'--schema',
				database.schema,
				'--dbname',
				database.url,
				backupPath
			]);

			return {
				restored: true,
				fileName: originalName,
				fileSize: file.size,
				restoredAt: new Date().toISOString()
			};
		} finally {
			await this.prisma.$connect();
			await this.deleteTempFile(backupPath);
			this.databaseRestoreInProgress = false;
		}
	}

	async sendInfoBotMessage(
		chatId: string,
		text: string,
		options?: { parseMode?: 'HTML' | null; messageThreadId?: number }
	) {
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();

		if (!token) {
			throw new Error('Info_bot token is not configured');
		}

		await this.sendTelegramMessage(token, chatId, text, options);
	}

	async sendPaymentSucceededNotification(
		data: PaymentSucceededNotification
	) {
		const settings = await this.getOrCreateSettings();
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.paymentsThreadId;
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();

		if (!chatId) {
			throw new BadRequestException(
				'Не настроен ID Telegram-группы для уведомлений о платежах'
			);
		}

		if (!messageThreadId) {
			throw new BadRequestException('Не настроен ID топика Payments');
		}

		if (!token) {
			throw new BadRequestException(
				TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED
			);
		}

		const text = [
			'<b>Новый успешный платёж</b>',
			'',
			`<b>Сумма:</b> ${this.escapeTelegramHtml(data.amount)} ₽`,
			`<b>Тариф:</b> ${this.escapeTelegramHtml(this.getPaymentPlanLabel(data.plan))}`,
			`<b>Период:</b> ${this.escapeTelegramHtml(this.getPaymentBillingPeriodLabel(data.billingPeriod))}`,
			`<b>Пользователь:</b> ${this.escapeTelegramHtml(data.userName || '—')}`,
			`<b>Email:</b> ${this.escapeTelegramHtml(data.email || '—')}`,
			`<b>Телефон:</b> ${this.escapeTelegramHtml(data.phone || '—')}`,
			`<b>ID пользователя:</b> <code>${this.escapeTelegramHtml(data.userId)}</code>`,
			`<b>ID платежа:</b> <code>${this.escapeTelegramHtml(data.paymentId)}</code>`,
			`<b>ID YooKassa:</b> <code>${this.escapeTelegramHtml(data.yookassaId)}</code>`,
			`<b>Оплачен:</b> ${this.escapeTelegramHtml(this.formatMoscowDateTime(data.succeededAt))} МСК`
		].join('\n');

		await this.sendTelegramMessage(token, chatId, text, {
			messageThreadId
		});
	}

	async getNotificationStatus(userId: string) {
		const [channel, pendingRequest] = await Promise.all([
			this.prisma.telegramNotificationChannel.findUnique({
				where: { userId }
			}),
			this.getActiveNotificationRequestByUserId(userId)
		]);

		return this.serializeNotificationStatus(channel, pendingRequest);
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

	async cancelNotificationBinding(userId: string) {
		await this.prisma.verificationChallenge.deleteMany({
			where: {
				userId,
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
			}
		});

		return { cancelled: true };
	}

	async disconnectNotificationChannel(userId: string) {
		const now = new Date();

		await Promise.all([
			this.prisma.telegramNotificationChannel.updateMany({
				where: { userId },
				data: {
					isActive: false,
					disabledAt: now
				}
			}),
			this.prisma.verificationChallenge.deleteMany({
				where: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
				}
			})
		]);

		return { disconnected: true };
	}

	async handleWebhook(
		update: TelegramInfoBotWebhookUpdate,
		secret?: string
	) {
		this.ensureNotificationWebhookSecret(secret);

		const message = update.message;

		if (message) {
			this.enqueueWebhookTask('Info_bot', update.update_id, () =>
				this.handleNotificationMessage(message)
			);
		}

		return true;
	}

	async handleSupportWebhook(
		update: TelegramSupportBotWebhookUpdate,
		secret?: string
	) {
		this.ensureSupportWebhookSecret(secret);

		const message = update.message;

		if (message) {
			this.enqueueWebhookTask('Support_bot', update.update_id, () =>
				this.handleSupportMessage(message)
			);
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

	private enqueueWebhookTask(
		botTitle: string,
		updateId: number | undefined,
		task: () => Promise<void>
	) {
		setImmediate(() => {
			void task().catch(error => {
				this.logger.warn(
					`${botTitle} webhook handling failed${
						updateId ? ` for update ${updateId}` : ''
					}: ${error instanceof Error ? error.message : String(error)}`
				);
			});
		});
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

	private getWebhookConfig(
		bot: TelegramWebhookBot
	): TelegramWebhookConfig {
		if (bot === 'auth') {
			return {
				bot,
				title: 'Auth_bot',
				token: process.env.TELEGRAM_AUTH_BOT_TOKEN,
				username: process.env.TELEGRAM_AUTH_BOT_USERNAME?.trim().replace(
					/^@/,
					''
				),
				secret: process.env.TELEGRAM_AUTH_BOT_WEBHOOK_SECRET,
				path: 'telegram-auth/webhook',
				allowedUpdates: ['message', 'callback_query']
			};
		}

		if (bot === 'support') {
			return {
				bot,
				title: 'Support_bot',
				token: process.env.TELEGRAM_SUPPORT_BOT_TOKEN,
				username: this.getSupportBotUsername(),
				secret: process.env.TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET,
				path: 'telegram-bot/support-webhook',
				allowedUpdates: ['message']
			};
		}

		if (bot !== 'info') {
			throw new BadRequestException('Неизвестный Telegram-бот');
		}

		return {
			bot,
			title: 'Info_bot',
			token: process.env.TELEGRAM_INFO_BOT_TOKEN,
			username: process.env.TELEGRAM_INFO_BOT_USERNAME?.trim().replace(
				/^@/,
				''
			),
			secret: process.env.TELEGRAM_INFO_BOT_WEBHOOK_SECRET,
			path: 'telegram-bot/webhook',
			allowedUpdates: ['message']
		};
	}

	private getWebhookUrl(path: string) {
		const host = this.getConfiguredWebhookHost();

		if (!host) {
			throw new BadRequestException(
				process.env.MODE === 'production'
					? 'Не настроен TELEGRAM_WEBHOOK_HOST для production'
					: 'Не настроен хост webhook Telegram'
			);
		}

		return `${host}/api/${path}`;
	}

	private getConfiguredWebhookHost() {
		const explicitHost = process.env.TELEGRAM_WEBHOOK_HOST?.trim();

		if (explicitHost) {
			return explicitHost.replace(/\/+$/, '');
		}

		if (process.env.MODE === 'production') {
			return '';
		}

		return (process.env.PRODUCTION_HOST ?? '').trim().replace(/\/+$/, '');
	}

	private async ensureWebhooksOnStartup() {
		const configs: TelegramWebhookConfig[] = [
			this.getWebhookConfig('info'),
			this.getWebhookConfig('auth'),
			this.getWebhookConfig('support')
		];

		await Promise.all(
			configs.map(async config => {
				if (!config.token?.trim()) {
					return;
				}

				try {
					await this.setTelegramWebhook(config, false);
				} catch (error) {
					this.logger.warn(
						`Telegram webhook ${config.title} startup check failed: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				}
			})
		);
	}

	private scheduleWebhookHealthcheck() {
		this.webhookHealthcheckInterval = setInterval(() => {
			void this.syncWebhookUrlsIfNeeded();
		}, this.TELEGRAM_WEBHOOK_HEALTHCHECK_INTERVAL_MS);

		this.webhookHealthcheckInterval.unref?.();
	}

	private async syncWebhookUrlsIfNeeded() {
		if (this.webhookHealthcheckInProgress) {
			return;
		}

		this.webhookHealthcheckInProgress = true;
		const configs: TelegramWebhookConfig[] = [
			this.getWebhookConfig('info'),
			this.getWebhookConfig('auth'),
			this.getWebhookConfig('support')
		];

		try {
			await Promise.all(
				configs.map(async config => {
					if (!config.token?.trim()) {
						return;
					}

					const status = await this.getWebhookStatus(config);

					if (!this.shouldRestoreWebhookUrl(status)) {
						return;
					}

					try {
						await this.setTelegramWebhook(config, false);
						this.logger.warn(
							`Telegram webhook ${config.title} URL restored.`
						);
					} catch (error) {
						this.logger.warn(
							`Telegram webhook ${config.title} URL restore failed: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				})
			);
		} finally {
			this.webhookHealthcheckInProgress = false;
		}
	}

	private async getSyncedWebhookStatus(config: TelegramWebhookConfig) {
		const status = await this.getWebhookStatus(config);

		if (!this.shouldRestoreWebhookUrl(status)) {
			return status;
		}

		try {
			await this.setTelegramWebhook(config, false);
			this.logger.warn(`Telegram webhook ${config.title} URL restored.`);
			return this.getWebhookStatus(config);
		} catch (error) {
			return {
				...status,
				error: `Не удалось восстановить webhook URL: ${
					error instanceof Error ? error.message : String(error)
				}`
			};
		}
	}

	private shouldRestoreWebhookUrl(status: {
		configured: boolean;
		ok: boolean;
		webhookMatchesExpected: boolean;
		error: string | null;
	}) {
		return (
			status.configured &&
			status.ok &&
			!status.error &&
			!status.webhookMatchesExpected
		);
	}

	private async setTelegramWebhook(
		config: TelegramWebhookConfig,
		dropPendingUpdates: boolean
	) {
		const token = config.token?.trim();

		if (!token) {
			throw new Error(this.getBotNotConfiguredError(config.bot));
		}

		await this.fetchTelegramApi(
			token,
			'setWebhook',
			{
				url: this.getWebhookUrl(config.path),
				drop_pending_updates: dropPendingUpdates,
				max_connections: this.TELEGRAM_WEBHOOK_MAX_CONNECTIONS,
				allowed_updates: config.allowedUpdates,
				...(config.secret?.trim()
					? { secret_token: config.secret.trim() }
					: {})
			},
			this.TELEGRAM_API_STATUS_TIMEOUT_MS
		);
	}

	private async deleteTelegramWebhook(
		config: TelegramWebhookConfig,
		dropPendingUpdates: boolean
	) {
		const token = config.token?.trim();

		if (!token) {
			throw new Error(this.getBotNotConfiguredError(config.bot));
		}

		await this.fetchTelegramApi(
			token,
			'deleteWebhook',
			{
				drop_pending_updates: dropPendingUpdates
			},
			this.TELEGRAM_API_STATUS_TIMEOUT_MS
		);
	}

	private async getWebhookStatus(config: TelegramWebhookConfig) {
		let expectedWebhookUrl: string | null = null;

		try {
			expectedWebhookUrl = this.getWebhookUrl(config.path);
		} catch (error) {
			return {
				bot: config.bot,
				title: config.title,
				configured: Boolean(config.token?.trim()),
				ok: false,
				expectedWebhookUrl: null,
				webhookUrl: null,
				webhookMatchesExpected: false,
				pendingUpdateCount: null,
				lastErrorAt: null,
				lastErrorMessage: null,
				allowedUpdates: null,
				secretConfigured: Boolean(config.secret?.trim()),
				configuredUsername: config.username || null,
				actualUsername: null,
				usernameMatchesConfigured: null,
				error:
					error instanceof Error
						? error.message
						: 'Не настроен хост webhook Telegram'
			};
		}

		const token = config.token?.trim();

		if (!token) {
			return {
				bot: config.bot,
				title: config.title,
				configured: false,
				ok: false,
				expectedWebhookUrl,
				webhookUrl: null,
				webhookMatchesExpected: false,
				pendingUpdateCount: null,
				lastErrorAt: null,
				lastErrorMessage: null,
				allowedUpdates: null,
				secretConfigured: Boolean(config.secret?.trim()),
				configuredUsername: config.username || null,
				actualUsername: null,
				usernameMatchesConfigured: null,
				error: this.getBotNotConfiguredError(config.bot)
			};
		}

		try {
			const [webhookInfo, botInfo] = await Promise.all([
				this.fetchTelegramApi<TelegramWebhookInfo>(
					token,
					'getWebhookInfo',
					undefined,
					this.TELEGRAM_API_STATUS_TIMEOUT_MS
				),
				this.fetchTelegramApi<TelegramBotInfo>(
					token,
					'getMe',
					undefined,
					this.TELEGRAM_API_STATUS_TIMEOUT_MS
				)
			]);
			const result = webhookInfo.result;
			const webhookUrl = result?.url || null;
			const lastErrorDate = result?.last_error_date;
			const actualUsername = botInfo.result?.username ?? null;

			return {
				bot: config.bot,
				title: config.title,
				configured: true,
				ok: Boolean(webhookInfo.ok),
				expectedWebhookUrl,
				webhookUrl,
				webhookMatchesExpected: webhookUrl === expectedWebhookUrl,
				pendingUpdateCount: result?.pending_update_count ?? 0,
				lastErrorAt: lastErrorDate
					? new Date(lastErrorDate * 1000).toISOString()
					: null,
				lastErrorMessage: result?.last_error_message ?? null,
				allowedUpdates: result?.allowed_updates ?? null,
				secretConfigured: Boolean(config.secret?.trim()),
				configuredUsername: config.username || null,
				actualUsername,
				usernameMatchesConfigured: config.username
					? actualUsername === config.username
					: null,
				error: webhookInfo.ok ? null : (webhookInfo.description ?? null)
			};
		} catch (error) {
			return {
				bot: config.bot,
				title: config.title,
				configured: true,
				ok: false,
				expectedWebhookUrl,
				webhookUrl: null,
				webhookMatchesExpected: false,
				pendingUpdateCount: null,
				lastErrorAt: null,
				lastErrorMessage: null,
				allowedUpdates: null,
				secretConfigured: Boolean(config.secret?.trim()),
				configuredUsername: config.username || null,
				actualUsername: null,
				usernameMatchesConfigured: null,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	private getBotNotConfiguredError(bot: TelegramWebhookBot) {
		if (bot === 'auth') {
			return TELEGRAM_AUTH_NOT_CONFIGURED;
		}

		if (bot === 'support') {
			return TELEGRAM_SUPPORT_BOT_NOT_CONFIGURED;
		}

		return TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED;
	}

	private getSettingsPatch(dto: UpdateTelegramBotSettingsDto) {
		return {
			...(typeof dto.dailySummaryEnabled === 'boolean'
				? { dailySummaryEnabled: dto.dailySummaryEnabled }
				: {}),
			...(typeof dto.dailySummaryChatId === 'string'
				? { dailySummaryChatId: dto.dailySummaryChatId.trim() }
				: {}),
			...(dto.supportThreadId === null ||
			typeof dto.supportThreadId === 'number'
				? { supportThreadId: dto.supportThreadId }
				: {}),
			...(dto.databaseBackupThreadId === null ||
			typeof dto.databaseBackupThreadId === 'number'
				? { databaseBackupThreadId: dto.databaseBackupThreadId }
				: {}),
			...(dto.paymentsThreadId === null ||
			typeof dto.paymentsThreadId === 'number'
				? { paymentsThreadId: dto.paymentsThreadId }
				: {}),
			...(dto.reportsThreadId === null ||
			typeof dto.reportsThreadId === 'number'
				? { reportsThreadId: dto.reportsThreadId }
				: {}),
			...(typeof dto.dailySummaryTime === 'string'
				? {
						dailySummaryTime: this.normalizeScheduleTime(
							dto.dailySummaryTime,
							this.DEFAULT_DAILY_SUMMARY_TIME
						)
					}
				: {}),
			...(typeof dto.databaseBackupEnabled === 'boolean'
				? { databaseBackupEnabled: dto.databaseBackupEnabled }
				: {}),
			...(typeof dto.databaseBackupTime === 'string'
				? {
						databaseBackupTime: this.normalizeScheduleTime(
							dto.databaseBackupTime,
							this.DEFAULT_DATABASE_BACKUP_TIME
						)
					}
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
		const webhookHost = this.getConfiguredWebhookHost();
		const dailySummaryTime = this.normalizeScheduleTime(
			settings.dailySummaryTime,
			this.DEFAULT_DAILY_SUMMARY_TIME
		);
		const databaseBackupTime = this.normalizeScheduleTime(
			settings.databaseBackupTime,
			this.DEFAULT_DATABASE_BACKUP_TIME
		);

		return {
			dailySummaryEnabled: settings.dailySummaryEnabled,
			dailySummaryChatId: settings.dailySummaryChatId,
			supportThreadId: settings.supportThreadId,
			databaseBackupThreadId: settings.databaseBackupThreadId,
			paymentsThreadId: settings.paymentsThreadId,
			reportsThreadId: settings.reportsThreadId,
			dailySummaryTime,
			dailySummaryTimeLabel: `${dailySummaryTime} МСК`,
			dailySummaryLastSentPeriodStart:
				settings.dailySummaryLastSentPeriodStart?.toISOString() ?? null,
			dailySummaryLastSentAt:
				settings.dailySummaryLastSentAt?.toISOString() ?? null,
			databaseBackupEnabled: settings.databaseBackupEnabled,
			databaseBackupTime,
			databaseBackupTimeLabel: `${databaseBackupTime} МСК`,
			databaseBackupLastSentPeriodStart:
				settings.databaseBackupLastSentPeriodStart?.toISOString() ?? null,
			databaseBackupLastSentAt:
				settings.databaseBackupLastSentAt?.toISOString() ?? null,
			databaseRestoreConfirmation: this.DATABASE_RESTORE_CONFIRMATION,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername()),
			authTelegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_AUTH_BOT_TOKEN?.trim()
			),
			authTelegramBotUsernameConfigured: Boolean(
				process.env.TELEGRAM_AUTH_BOT_USERNAME?.trim()
			),
			supportTelegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_SUPPORT_BOT_TOKEN?.trim()
			),
			telegramWebhookHostConfigured: Boolean(webhookHost),
			telegramWebhookHost: webhookHost || null,
			telegramWebhookHealthUrl: webhookHost
				? `${webhookHost}/api/telegram-bot/webhook-health`
				: null,
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private serializeNotificationStatus(
		channel: TelegramNotificationChannel | null,
		pendingRequest?: VerificationChallenge | null
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
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername()),
			pendingRequest: pendingRequest
				? {
						requestId: pendingRequest.value,
						botUrl: `https://t.me/${this.getInfoBotUsername()}?start=${pendingRequest.value}`,
						expiresAt: pendingRequest.expiresAt.toISOString()
					}
				: null
		};
	}

	private async handleNotificationMessage(message: TelegramMessage) {
		const chatId = String(message.chat.id);
		const requestId = this.extractNotificationRequestId(message.text);

		if (!requestId && !message.text?.startsWith('/start')) {
			if (!message.chat.type || message.chat.type === 'private') {
				await this.sendInfoBotMessage(
					chatId,
					'Чтобы подключить уведомления, откройте профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений. Если ссылка не открылась, отправьте сюда код подключения из профиля.'
				);
			}

			return;
		}

		if (message.chat.type && message.chat.type !== 'private') {
			await this.sendInfoBotMessage(
				chatId,
				'Подключите уведомления winwidget.ru в личном чате с Info_bot.'
			);
			return;
		}

		if (!requestId) {
			await this.handleNotificationStartWithoutRequest(message, chatId);
			return;
		}

		const request = await this.getActiveNotificationRequest(requestId);

		if (!request?.userId) {
			this.logger.warn(
				`Telegram notification binding request not found: ${this.maskRequestId(requestId)}`
			);

			if (
				await this.handleNotificationStartWithoutRequest(
					message,
					chatId,
					'Ссылка подключения уведомлений истекла. Если Telegram уже привязан как способ входа, мы подключим уведомления автоматически.'
				)
			) {
				return;
			}

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

		await this.upsertNotificationChannel({
			userId: request.userId,
			message,
			chatId,
			telegramUserId,
			connectedAt: now
		});

		await this.prisma.verificationChallenge.delete({
			where: {
				id: request.id
			}
		});

		await this.sendInfoBotMessage(
			chatId,
			'Telegram-уведомления winwidget.ru подключены. Напоминания о подписке будут приходить сюда.'
		);
	}

	private async handleNotificationStartWithoutRequest(
		message: TelegramMessage,
		chatId: string,
		intro?: string
	) {
		const telegramUserId = message.from?.id
			? String(message.from.id)
			: null;

		if (!telegramUserId) {
			await this.sendInfoBotMessage(
				chatId,
				'Чтобы подключить уведомления, откройте профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений.'
			);
			return Boolean(intro);
		}

		const identity = await this.prisma.authIdentity.findUnique({
			where: {
				type_value: {
					type: AuthIdentityType.TELEGRAM,
					value: telegramUserId
				}
			},
			select: {
				userId: true
			}
		});

		if (!identity) {
			await this.sendInfoBotMessage(
				chatId,
				intro
					? `${intro}\n\nЧтобы подключить уведомления к профилю без Telegram-входа, вернитесь в профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений.`
					: 'Чтобы подключить уведомления, откройте профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений.'
			);
			return Boolean(intro);
		}

		const linkedChannel =
			await this.prisma.telegramNotificationChannel.findFirst({
				where: {
					OR: [{ chatId }, { telegramUserId }]
				}
			});

		if (linkedChannel && linkedChannel.userId !== identity.userId) {
			await this.sendInfoBotMessage(
				chatId,
				'Этот Telegram уже подключён к другому профилю winwidget.ru.'
			);
			return true;
		}

		await this.upsertNotificationChannel({
			userId: identity.userId,
			message,
			chatId,
			telegramUserId,
			connectedAt: new Date()
		});

		await this.sendInfoBotMessage(
			chatId,
			'Telegram-уведомления winwidget.ru подключены. Теперь сервисные сообщения будут приходить сюда.'
		);

		return true;
	}

	private async upsertNotificationChannel({
		userId,
		message,
		chatId,
		telegramUserId,
		connectedAt
	}: {
		userId: string;
		message: TelegramMessage;
		chatId: string;
		telegramUserId: string | null;
		connectedAt: Date;
	}) {
		await this.prisma.telegramNotificationChannel.upsert({
			where: {
				userId
			},
			update: {
				chatId,
				telegramUserId,
				username: message.from?.username ?? null,
				firstName: message.from?.first_name ?? null,
				lastName: message.from?.last_name ?? null,
				isActive: true,
				connectedAt,
				disabledAt: null
			},
			create: {
				userId,
				chatId,
				telegramUserId,
				username: message.from?.username ?? null,
				firstName: message.from?.first_name ?? null,
				lastName: message.from?.last_name ?? null,
				isActive: true,
				connectedAt
			}
		});
	}

	private async handleSupportMessage(message: TelegramMessage) {
		if (message.from?.is_bot) {
			return;
		}

		if (
			message.chat.type === 'group' ||
			message.chat.type === 'supergroup'
		) {
			await this.handleSupportAdminReply(message);
			return;
		}

		if (message.chat.type && message.chat.type !== 'private') {
			return;
		}

		await this.handleSupportUserMessage(message);
	}

	private async handleSupportUserMessage(message: TelegramMessage) {
		const userChatId = String(message.chat.id);
		const settings = await this.getOrCreateSettings();
		const adminChatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.supportThreadId;

		if (!adminChatId || !messageThreadId) {
			await this.sendSupportBotMessage(
				userChatId,
				'Служба поддержки временно недоступна. Пожалуйста, попробуйте позже.'
			);
			return;
		}

		if (message.text?.startsWith('/start')) {
			await this.sendSupportBotMessage(
				userChatId,
				'Вас приветствует служба поддрежки сервиса winwdiget.ru! Спасибо что пользуетесь нашим сервисом. Напишите ваш вопрос и мы ответим вам в ближайшее время.'
			);
			return;
		}

		if (!message.message_id) {
			await this.sendSupportBotMessage(
				userChatId,
				'Не удалось отправить сообщение. Пожалуйста, отправьте его ещё раз.'
			);
			return;
		}

		const copiedMessage = await this.copySupportBotMessage(
			adminChatId,
			userChatId,
			message.message_id,
			{ messageThreadId }
		);

		await this.saveSupportMessageMapping({
			adminChatId,
			adminMessageId: copiedMessage.message_id,
			message
		});

		const contextMessage = await this.sendSupportBotMessage(
			adminChatId,
			this.getSupportContextText(message),
			{
				reply_to_message_id: copiedMessage.message_id,
				messageThreadId
			}
		);

		await this.saveSupportMessageMapping({
			adminChatId,
			adminMessageId: contextMessage.message_id,
			message
		});

		await this.sendSupportBotMessage(
			userChatId,
			'Сообщение передано команде поддержки. Ответим в текущий чат в ближайшее время.'
		);
	}

	private async handleSupportAdminReply(message: TelegramMessage) {
		const replyToMessageId = message.reply_to_message?.message_id;

		if (!replyToMessageId || !message.message_id) {
			return;
		}

		const adminChatId = String(message.chat.id);
		const settings = await this.getOrCreateSettings();
		const configuredAdminChatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.supportThreadId;

		if (
			!configuredAdminChatId ||
			!messageThreadId ||
			adminChatId !== configuredAdminChatId ||
			message.message_thread_id !== messageThreadId
		) {
			return;
		}

		const supportMessage =
			await this.prisma.telegramSupportMessage.findUnique({
				where: {
					adminChatId_adminMessageId: {
						adminChatId,
						adminMessageId: replyToMessageId
					}
				}
			});

		if (!supportMessage) {
			return;
		}

		try {
			await this.copySupportBotMessage(
				supportMessage.userChatId,
				adminChatId,
				message.message_id
			);
			await this.sendSupportBotMessage(
				adminChatId,
				'Ответ отправлен пользователю.',
				{
					reply_to_message_id: message.message_id,
					messageThreadId
				}
			);
		} catch (error) {
			await this.sendSupportBotMessage(
				adminChatId,
				'Не удалось отправить ответ пользователю. Возможно, пользователь заблокировал бота.',
				{
					reply_to_message_id: message.message_id,
					messageThreadId
				}
			).catch(() => undefined);
			throw error;
		}
	}

	private async saveSupportMessageMapping({
		adminChatId,
		adminMessageId,
		message
	}: {
		adminChatId: string;
		adminMessageId: number;
		message: TelegramMessage;
	}) {
		await this.prisma.telegramSupportMessage.upsert({
			where: {
				adminChatId_adminMessageId: {
					adminChatId,
					adminMessageId
				}
			},
			update: {
				userChatId: String(message.chat.id),
				telegramUserId: message.from?.id ? String(message.from.id) : null,
				username: message.from?.username ?? null,
				firstName: message.from?.first_name ?? null,
				lastName: message.from?.last_name ?? null,
				text: message.text ?? message.caption ?? null
			},
			create: {
				adminChatId,
				adminMessageId,
				userChatId: String(message.chat.id),
				telegramUserId: message.from?.id ? String(message.from.id) : null,
				username: message.from?.username ?? null,
				firstName: message.from?.first_name ?? null,
				lastName: message.from?.last_name ?? null,
				text: message.text ?? message.caption ?? null
			}
		});
	}

	private getSupportContextText(message: TelegramMessage) {
		const fullName = [message.from?.first_name, message.from?.last_name]
			.filter(Boolean)
			.join(' ')
			.trim();
		const username = message.from?.username
			? `@${message.from.username}`
			: null;
		const name = username || fullName || 'Без имени';
		const telegramUserId = message.from?.id
			? String(message.from.id)
			: 'неизвестен';
		const preview =
			message.text || message.caption || 'Сообщение без текста';

		return [
			'Новое обращение в поддержку winwidget.ru',
			`Пользователь: ${name}`,
			`Telegram ID: ${telegramUserId}`,
			`Chat ID: ${String(message.chat.id)}`,
			'',
			'Ответьте reply на это сообщение или на сообщение пользователя выше.',
			'',
			`Текст: ${preview}`
		].join('\n');
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

	private async getActiveNotificationRequestByUserId(userId: string) {
		const request = await this.prisma.verificationChallenge.findUnique({
			where: {
				userId_type_purpose: {
					userId,
					type: VerificationChallengeType.TELEGRAM,
					purpose: VerificationChallengePurpose.BIND_TELEGRAM_NOTIFICATIONS
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

	private extractNotificationRequestId(text?: string) {
		return text?.match(/\b[a-f0-9]{32}\b/i)?.[0]?.toLowerCase() ?? null;
	}

	private maskRequestId(requestId: string) {
		return `${requestId.slice(0, 8)}...`;
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
		if (!process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()) {
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
		const expected = process.env.TELEGRAM_INFO_BOT_WEBHOOK_SECRET?.trim();

		if (expected && secret !== expected) {
			throw new UnauthorizedException(
				TELEGRAM_NOTIFICATION_WEBHOOK_SECRET_INVALID
			);
		}
	}

	private ensureSupportWebhookSecret(secret?: string) {
		const expected =
			process.env.TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET?.trim();

		if (expected && secret !== expected) {
			throw new UnauthorizedException(
				TELEGRAM_SUPPORT_WEBHOOK_SECRET_INVALID
			);
		}
	}

	private getSupportBotToken() {
		const token = process.env.TELEGRAM_SUPPORT_BOT_TOKEN?.trim();

		if (!token) {
			throw new BadRequestException(TELEGRAM_SUPPORT_BOT_NOT_CONFIGURED);
		}

		return token;
	}

	private getSupportBotUsername() {
		return (
			process.env.TELEGRAM_SUPPORT_BOT_USERNAME?.trim().replace(
				/^@/,
				''
			) ||
			process.env.TELEGRAM_SUPPORT_USERNAME?.trim().replace(/^@/, '') ||
			''
		);
	}

	private getInfoBotUsername() {
		return (
			process.env.TELEGRAM_INFO_BOT_USERNAME?.trim().replace(/^@/, '') ??
			''
		);
	}

	private rescheduleDailySummary() {
		if (this.summaryTimeout) {
			clearTimeout(this.summaryTimeout);
			this.summaryTimeout = null;
		}

		void this.scheduleDailySummary();
	}

	private rescheduleDailyDatabaseBackup() {
		if (this.databaseBackupTimeout) {
			clearTimeout(this.databaseBackupTimeout);
			this.databaseBackupTimeout = null;
		}

		void this.scheduleDailyDatabaseBackup();
	}

	private async scheduleDailySummary() {
		const settings = await this.getOrCreateSettings();
		const scheduleTime = this.getScheduleTimeParts(
			settings.dailySummaryTime,
			this.DEFAULT_DAILY_SUMMARY_TIME
		);
		const nextRun = this.getNextMoscowRunDate(
			scheduleTime.hour,
			scheduleTime.minute
		);
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);
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
				void this.scheduleDailySummary();
			}
		}, delay);

		this.summaryTimeout.unref?.();
	}

	private async sendMissedDailySummaryIfNeeded() {
		if (!(await this.shouldRunStartupDailySummary())) {
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
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.reportsThreadId;

		if (!settings.dailySummaryEnabled) {
			return false;
		}

		if (!chatId) {
			this.logger.warn(
				'Telegram daily summary skipped: group chat ID is not configured.'
			);
			return false;
		}

		if (!messageThreadId) {
			this.logger.warn(
				'Telegram daily summary skipped: reportsThreadId is not configured.'
			);
			return false;
		}

		if (!token) {
			this.logger.warn(
				'Telegram daily summary skipped: Info_bot token is not configured.'
			);
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

		await this.sendTelegramMessage(token, chatId, text, {
			messageThreadId
		});

		await this.prisma.telegramBotSettings.update({
			where: { id: 'singleton' },
			data: {
				dailySummaryLastSentPeriodStart: period.start,
				dailySummaryLastSentAt: new Date()
			}
		});

		return true;
	}

	private async scheduleDailyDatabaseBackup() {
		const settings = await this.getOrCreateSettings();
		const scheduleTime = this.getScheduleTimeParts(
			settings.databaseBackupTime,
			this.DEFAULT_DATABASE_BACKUP_TIME
		);
		const nextRun = this.getNextMoscowRunDate(
			scheduleTime.hour,
			scheduleTime.minute
		);
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);
		this.databaseBackupTimeout = setTimeout(async () => {
			try {
				const sent = await this.sendDailyDatabaseBackupIfEnabled();
				this.logger.log(
					sent
						? 'Telegram database backup sent.'
						: 'Telegram database backup skipped.'
				);
			} catch (error) {
				this.logger.error(
					`Telegram database backup failed: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			} finally {
				void this.scheduleDailyDatabaseBackup();
			}
		}, delay);

		this.databaseBackupTimeout.unref?.();
	}

	private async sendMissedDailyDatabaseBackupIfNeeded() {
		if (!(await this.shouldRunStartupDailyDatabaseBackup())) {
			return;
		}

		try {
			const sent = await this.sendDailyDatabaseBackupIfEnabled();
			this.logger.log(
				sent
					? 'Missed Telegram database backup sent on startup.'
					: 'No missed Telegram database backup to send on startup.'
			);
		} catch (error) {
			this.logger.error(
				`Telegram database backup startup check failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async sendDailyDatabaseBackupIfEnabled() {
		const settings = await this.getOrCreateSettings();
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.databaseBackupThreadId;

		if (!settings.databaseBackupEnabled) {
			return false;
		}

		if (!chatId) {
			this.logger.warn(
				'Telegram database backup skipped: group chat ID is not configured.'
			);
			return false;
		}

		if (!messageThreadId) {
			this.logger.warn(
				'Telegram database backup skipped: databaseBackupThreadId is not configured.'
			);
			return false;
		}

		if (!token) {
			this.logger.warn(
				'Telegram database backup skipped: Info_bot token is not configured.'
			);
			return false;
		}

		const period = this.getPreviousMoscowDayPeriod();

		if (
			settings.databaseBackupLastSentPeriodStart?.getTime() ===
			period.start.getTime()
		) {
			return false;
		}

		const result = await this.createAndSendDatabaseBackup('scheduled');

		await this.prisma.telegramBotSettings.update({
			where: { id: 'singleton' },
			data: {
				databaseBackupLastSentPeriodStart: period.start,
				databaseBackupLastSentAt: new Date()
			}
		});

		return result.sent;
	}

	private async createDatabaseBackupFile() {
		if (this.databaseBackupInProgress) {
			throw new BadRequestException('Backup базы уже выполняется');
		}

		this.databaseBackupInProgress = true;
		const directory = await this.ensureDatabaseBackupTempDir();
		const createdAt = new Date();
		const fileName = `winwidget-db-${createdAt.toISOString().replace(/[:.]/g, '-')}.dump`;
		const filePath = join(directory, fileName);
		const database = this.getPostgresCommandConnection();

		try {
			await this.runPostgresCommand('pg_dump', [
				'--format=custom',
				'--no-owner',
				'--no-privileges',
				'--schema',
				database.schema,
				'--file',
				filePath,
				database.url
			]);

			const fileStat = await stat(filePath);

			if (fileStat.size > DATABASE_BACKUP_MAX_FILE_SIZE_BYTES) {
				throw new BadRequestException(
					'Backup создан, но он больше 49 МБ и не может быть отправлен Telegram-ботом'
				);
			}

			return {
				filePath,
				fileName,
				fileSize: fileStat.size,
				createdAt: createdAt.toISOString()
			};
		} finally {
			this.databaseBackupInProgress = false;
		}
	}

	private async sendDatabaseBackupFile(
		filePath: string,
		trigger: 'manual' | 'scheduled'
	) {
		const settings = await this.getOrCreateSettings();
		const { token, chatId, messageThreadId } =
			this.getDatabaseBackupDestination(settings);

		await this.sendTelegramDocument(
			token,
			chatId,
			filePath,
			[
				'<b>Backup базы данных WinWidget</b>',
				`Создано: ${this.formatMoscowDateTime(new Date())} МСК`,
				`Тип: ${trigger === 'manual' ? 'ручной' : 'ежедневный'}`
			].join('\n'),
			messageThreadId
		);

		return true;
	}

	private getDatabaseBackupDestination(settings: TelegramBotSettings) {
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.databaseBackupThreadId;

		if (!chatId) {
			throw new BadRequestException(
				'Не настроен ID Telegram-группы для отправки backup'
			);
		}

		if (!messageThreadId) {
			throw new BadRequestException('Не настроен ID топика Backups');
		}

		if (!token) {
			throw new BadRequestException(
				TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED
			);
		}

		return { token, chatId, messageThreadId };
	}

	private async writeUploadedBackupFile(file: Express.Multer.File) {
		const directory = await this.ensureDatabaseBackupTempDir();
		const safeName = basename(file.originalname || 'database-backup.dump');
		const filePath = join(
			directory,
			`restore-${randomUUID()}-${safeName}`
		);

		await writeFile(filePath, file.buffer);

		return filePath;
	}

	private async ensureDatabaseBackupTempDir() {
		const directory = join(tmpdir(), 'winwidget-db-backups');
		await mkdir(directory, { recursive: true });
		return directory;
	}

	private async deleteTempFile(filePath: string) {
		await unlink(filePath).catch(() => undefined);
	}

	private async runPostgresCommand(command: string, args: string[]) {
		try {
			await execFileAsync(command, args, {
				timeout: this.DATABASE_BACKUP_TIMEOUT_MS,
				maxBuffer: 1024 * 1024
			});
		} catch (error) {
			const message = this.getPostgresCommandErrorMessage(command, error);
			throw new BadRequestException(message);
		}
	}

	private getPostgresCommandErrorMessage(command: string, error: unknown) {
		if (this.isMissingExecutableError(error)) {
			return `На сервере не найден ${command}. Установите PostgreSQL client tools (postgresql-client/libpq) или пересоберите backend Docker-образ.`;
		}

		return error instanceof Error
			? error.message
			: 'PostgreSQL command failed';
	}

	private isMissingExecutableError(error: unknown) {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ENOENT'
		);
	}

	private getPostgresCommandConnection() {
		const rawDatabaseUrl = this.getDatabaseUrl();
		const url = new URL(rawDatabaseUrl);

		const schema = url.searchParams.get('schema')?.trim() || 'public';

		url.searchParams.delete('schema');

		return {
			url: url.toString(),
			schema
		};
	}

	private getDatabaseUrl() {
		const mode = process.env.MODE?.trim().toLowerCase() ?? 'development';
		const databaseUrlKey =
			mode === 'production'
				? 'DATABASE_URL_PRODUCTION'
				: 'DATABASE_URL_DEVELOPMENT';
		const databaseUrl = process.env[databaseUrlKey]?.trim();

		if (!databaseUrl || databaseUrl === 'change_me') {
			throw new BadRequestException(
				`Не настроена переменная ${databaseUrlKey}`
			);
		}

		return databaseUrl;
	}

	private async collectDailySummaryStats(period: DailySummaryPeriod) {
		const range = {
			gte: period.start,
			lt: period.end
		};
		const now = new Date();
		const dayMs = 24 * 60 * 60 * 1000;
		const previousDayRange = {
			gte: new Date(period.start.getTime() - dayMs),
			lt: period.start
		};
		const last7DaysRange = {
			gte: new Date(period.end.getTime() - 7 * dayMs),
			lt: period.end
		};
		const stalePendingBefore = new Date(now.getTime() - dayMs);
		const todayEndsAt = new Date(now.getTime() + dayMs);
		const soonEndsAt3d = new Date(now.getTime() + 3 * dayMs);
		const soonEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
		const moscowOffsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedPeriodStart = new Date(
			period.start.getTime() + moscowOffsetMs
		);
		shiftedPeriodStart.setUTCDate(1);
		shiftedPeriodStart.setUTCHours(0, 0, 0, 0);
		const currentMonthStart = new Date(
			shiftedPeriodStart.getTime() - moscowOffsetMs
		);

		const [
			totalUsersCount,
			usersWithUserRoleCount,
			usersWithAdminRoleCount,
			usersWithDevRoleCount,
			newUsersCount,
			previousDayNewUsersCount,
			newUsersCount7d,
			succeededPayments,
			previousDaySucceededPayments,
			currentMonthSucceededPayments,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			stalePendingPaymentsCount,
			cancelledPaymentsCount,
			wheelLeadsCount,
			quizLeadsCount,
			callbackLeadsCount,
			countdownTimerLeadsCount,
			stopOfferLeadsCount,
			onlineConsultantLeadsCount,
			calculatorLeadsCount,
			previousDayWheelLeadsCount,
			previousDayQuizLeadsCount,
			previousDayCallbackLeadsCount,
			previousDayCountdownTimerLeadsCount,
			previousDayStopOfferLeadsCount,
			previousDayOnlineConsultantLeadsCount,
			previousDayCalculatorLeadsCount,
			wheelLeadsCount7d,
			quizLeadsCount7d,
			callbackLeadsCount7d,
			countdownTimerLeadsCount7d,
			stopOfferLeadsCount7d,
			onlineConsultantLeadsCount7d,
			calculatorLeadsCount7d,
			expiringSubscriptionsTodayCount,
			expiringSubscriptions3dCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutContactsCount
		] = await Promise.all([
			this.prisma.user.count(),
			this.prisma.user.count({ where: { rights: { has: Role.USER } } }),
			this.prisma.user.count({ where: { rights: { has: Role.ADMIN } } }),
			this.prisma.user.count({ where: { rights: { has: Role.DEV } } }),
			this.prisma.user.count({
				where: { createdAt: range }
			}),
			this.prisma.user.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.user.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: range
				},
				select: { amount: true, userId: true, updatedAt: true },
				orderBy: { updatedAt: 'asc' }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: previousDayRange
				},
				select: { amount: true }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: {
						gte: currentMonthStart,
						lt: period.end
					}
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
					status: PaymentStatus.PENDING,
					createdAt: { lt: stalePendingBefore }
				}
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
			this.prisma.stopOfferLead.count({ where: { createdAt: range } }),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: range }
			}),
			this.prisma.calculatorLead.count({ where: { createdAt: range } }),
			this.prisma.lead.count({ where: { createdAt: previousDayRange } }),
			this.prisma.quizLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.callbackLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.stopOfferLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.calculatorLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.lead.count({ where: { createdAt: last7DaysRange } }),
			this.prisma.quizLead.count({ where: { createdAt: last7DaysRange } }),
			this.prisma.callbackLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.stopOfferLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.calculatorLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: { gte: now, lt: todayEndsAt }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: { gte: now, lt: soonEndsAt3d }
				}
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
			countdownTimerLeadsCount +
			stopOfferLeadsCount +
			onlineConsultantLeadsCount +
			calculatorLeadsCount;
		const previousDayLeadsTotal =
			previousDayWheelLeadsCount +
			previousDayQuizLeadsCount +
			previousDayCallbackLeadsCount +
			previousDayCountdownTimerLeadsCount +
			previousDayStopOfferLeadsCount +
			previousDayOnlineConsultantLeadsCount +
			previousDayCalculatorLeadsCount;
		const leadsTotal7d =
			wheelLeadsCount7d +
			quizLeadsCount7d +
			callbackLeadsCount7d +
			countdownTimerLeadsCount7d +
			stopOfferLeadsCount7d +
			onlineConsultantLeadsCount7d +
			calculatorLeadsCount7d;
		const currentPaymentUserIds = [
			...new Set(succeededPayments.map(payment => payment.userId))
		];
		const usersWithPreviousPayments = currentPaymentUserIds.length
			? await this.prisma.payment.findMany({
					where: {
						status: PaymentStatus.SUCCEEDED,
						updatedAt: { lt: period.start },
						userId: { in: currentPaymentUserIds }
					},
					select: { userId: true },
					distinct: ['userId']
				})
			: [];
		const usersWithPreviousPaymentIds = new Set(
			usersWithPreviousPayments.map(payment => payment.userId)
		);
		let firstPaymentsCount = 0;
		let repeatPaymentsCount = 0;

		for (const payment of succeededPayments) {
			if (usersWithPreviousPaymentIds.has(payment.userId)) {
				repeatPaymentsCount += 1;
				continue;
			}

			firstPaymentsCount += 1;
			usersWithPreviousPaymentIds.add(payment.userId);
		}

		const succeededPaymentsAmount =
			this.getPaymentsAmount(succeededPayments);

		return {
			period,
			generatedAtLabel: this.formatMoscowDateTime(new Date()),
			totalUsersCount,
			usersByRole: {
				user: usersWithUserRoleCount,
				admin: usersWithAdminRoleCount,
				dev: usersWithDevRoleCount
			},
			newUsersCount,
			previousDayNewUsersCount,
			averageNewUsersCount7d: newUsersCount7d / 7,
			succeededPaymentsCount: succeededPayments.length,
			succeededPaymentsAmount,
			previousDaySucceededPaymentsAmount: this.getPaymentsAmount(
				previousDaySucceededPayments
			),
			currentMonthSucceededPaymentsAmount: this.getPaymentsAmount(
				currentMonthSucceededPayments
			),
			firstPaymentsCount,
			repeatPaymentsCount,
			averagePaymentAmount: succeededPayments.length
				? succeededPaymentsAmount / succeededPayments.length
				: null,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			stalePendingPaymentsCount,
			cancelledPaymentsCount,
			leads: {
				total: leadsTotal,
				previousDayTotal: previousDayLeadsTotal,
				averageTotal7d: leadsTotal7d / 7,
				wheel: wheelLeadsCount,
				quiz: quizLeadsCount,
				callback: callbackLeadsCount,
				countdownTimer: countdownTimerLeadsCount,
				stopOffer: stopOfferLeadsCount,
				onlineConsultant: onlineConsultantLeadsCount,
				calculator: calculatorLeadsCount
			},
			expiringSubscriptionsTodayCount,
			expiringSubscriptions3dCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutContactsCount
		};
	}

	private buildDailySummaryMessage(stats: DailySummaryStats) {
		return [
			'<b>Ежедневная сводка WinWidget</b>',
			`${this.formatMoscowDate(stats.period.start)} · МСК`,
			'',
			'<b>Итоги дня</b>',
			`👤 Регистрации: ${stats.newUsersCount} (вчера: ${stats.previousDayNewUsersCount} · среднее за 7 дней: ${this.formatAverage(stats.averageNewUsersCount7d)})`,
			`💳 Выручка: ${this.formatMoney(stats.succeededPaymentsAmount)} (вчера: ${this.formatMoney(stats.previousDaySucceededPaymentsAmount)} · за месяц: ${this.formatMoney(stats.currentMonthSucceededPaymentsAmount)})`,
			`🎯 Лиды: ${stats.leads.total} (вчера: ${stats.leads.previousDayTotal} · среднее за 7 дней: ${this.formatAverage(stats.leads.averageTotal7d)})`,
			'',
			'<b>Пользователи</b>',
			`- Всего: ${stats.totalUsersCount}`,
			`- С ролью USER: ${stats.usersByRole.user}`,
			`- С ролью ADMIN: ${stats.usersByRole.admin}`,
			`- С ролью DEV: ${stats.usersByRole.dev}`,
			'',
			'<b>Платежи</b>',
			`- Успешные: ${stats.succeededPaymentsCount}`,
			`- Первые оплаты: ${stats.firstPaymentsCount}`,
			`- Повторные оплаты: ${stats.repeatPaymentsCount}`,
			`- Средний чек: ${stats.averagePaymentAmount === null ? '—' : this.formatMoney(stats.averagePaymentAmount)}`,
			`- Создано pending: ${stats.pendingPaymentsCount}`,
			`- Pending сейчас: ${stats.currentPendingPaymentsCount}`,
			`- Отменённые: ${stats.cancelledPaymentsCount}`,
			'',
			'<b>Лиды</b>',
			`- Всего: ${stats.leads.total}`,
			`- Колесо: ${stats.leads.wheel}`,
			`- Квизы: ${stats.leads.quiz}`,
			`- Обратный звонок: ${stats.leads.callback}`,
			`- Таймеры: ${stats.leads.countdownTimer}`,
			`- Стоп-офферы: ${stats.leads.stopOffer}`,
			`- Онлайн-консультанты: ${stats.leads.onlineConsultant}`,
			`- Калькуляторы стоимости: ${stats.leads.calculator}`,
			'',
			'<b>Подписки</b>',
			`- Истекают в ближайшие 24 часа: ${stats.expiringSubscriptionsTodayCount}`,
			`- Истекают в ближайшие 3 дня: ${stats.expiringSubscriptions3dCount}`,
			`- Истекают в ближайшие 7 дней: ${stats.expiringSubscriptionsCount}`,
			`- Истекли, но ещё ACTIVE: ${stats.expiredActiveSubscriptionsCount}`,
			'',
			'<b>Требует внимания</b>',
			`- Pending более 24 часов: ${stats.stalePendingPaymentsCount}${stats.stalePendingPaymentsCount ? ' ⚠️' : ''}`,
			`- Всего пользователей без email и телефона: ${stats.usersWithoutContactsCount}${stats.usersWithoutContactsCount ? ' ⚠️' : ''}`,
			`- Просроченные ACTIVE-подписки: ${stats.expiredActiveSubscriptionsCount}${stats.expiredActiveSubscriptionsCount ? ' ⚠️' : ''}`,
			'',
			`Сформировано: ${stats.generatedAtLabel} МСК`
		].join('\n');
	}

	private async sendSupportBotMessage(
		chatId: string,
		text: string,
		options?: {
			reply_to_message_id?: number;
			messageThreadId?: number;
		}
	) {
		const data = await this.fetchTelegramApi<{
			ok?: boolean;
			result?: { message_id: number };
		}>(this.getSupportBotToken(), 'sendMessage', {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
			...(options?.reply_to_message_id
				? { reply_to_message_id: options.reply_to_message_id }
				: {}),
			...(options?.messageThreadId
				? { message_thread_id: options.messageThreadId }
				: {})
		});

		if (!data.result?.message_id) {
			throw new Error(
				'Telegram support sendMessage returned no message_id'
			);
		}

		return data.result;
	}

	private async copySupportBotMessage(
		chatId: string,
		fromChatId: string,
		messageId: number,
		options?: { messageThreadId?: number }
	) {
		const data = await this.fetchTelegramApi<{
			ok?: boolean;
			result?: { message_id: number };
		}>(this.getSupportBotToken(), 'copyMessage', {
			chat_id: chatId,
			from_chat_id: fromChatId,
			message_id: messageId,
			...(options?.messageThreadId
				? { message_thread_id: options.messageThreadId }
				: {})
		});

		if (!data.result?.message_id) {
			throw new Error(
				'Telegram support copyMessage returned no message_id'
			);
		}

		return data.result;
	}

	private async sendTelegramDocument(
		token: string,
		chatId: string,
		filePath: string,
		caption: string,
		messageThreadId: number
	) {
		const fileBuffer = await readFile(filePath);
		const formData = new FormData();

		formData.append('chat_id', chatId);
		formData.append('message_thread_id', String(messageThreadId));
		formData.append('caption', caption);
		formData.append('parse_mode', 'HTML');
		formData.append(
			'document',
			new Blob([fileBuffer]),
			basename(filePath)
		);

		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendDocument`,
			{
				method: 'POST',
				signal: AbortSignal.timeout(this.DATABASE_BACKUP_TIMEOUT_MS),
				body: formData
			}
		);
		const data = (await response.json().catch(() => null)) as {
			ok?: boolean;
			description?: string;
		} | null;

		if (!response.ok || !data?.ok) {
			throw new Error(
				`Telegram sendDocument failed: ${data?.description ?? `HTTP ${response.status}`}`
			);
		}
	}

	private async fetchTelegramApi<T>(
		token: string,
		method: string,
		body?: Record<string, unknown>,
		timeoutMs = this.TELEGRAM_SEND_TIMEOUT_MS
	) {
		const response = await fetch(
			`https://api.telegram.org/bot${token}/${method}`,
			{
				method: body ? 'POST' : 'GET',
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				signal: AbortSignal.timeout(timeoutMs),
				body: body ? JSON.stringify(body) : undefined
			}
		);
		const data = (await response.json().catch(() => null)) as
			| (T & { ok?: boolean; description?: string })
			| null;

		if (!response.ok || !data?.ok) {
			throw new Error(
				`Telegram ${method} failed: ${data?.description ?? `HTTP ${response.status}`}`
			);
		}

		return data;
	}

	private async sendTelegramMessage(
		token: string,
		chatId: string,
		text: string,
		options?: { parseMode?: 'HTML' | null; messageThreadId?: number }
	) {
		const parseMode = options?.parseMode === null ? null : 'HTML';
		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: AbortSignal.timeout(this.TELEGRAM_SEND_TIMEOUT_MS),
				body: JSON.stringify({
					chat_id: chatId,
					...(options?.messageThreadId
						? { message_thread_id: options.messageThreadId }
						: {}),
					text,
					...(parseMode ? { parse_mode: parseMode } : {}),
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

	private formatAverage(value: number) {
		return new Intl.NumberFormat('ru-RU', {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1
		}).format(value);
	}

	private getPaymentPlanLabel(plan: Plan) {
		switch (plan) {
			case Plan.TRIAL:
				return 'Тест-драйв';
			case Plan.EASY:
				return 'Easy';
			case Plan.HARD:
				return 'Hard';
			default:
				return plan;
		}
	}

	private getPaymentBillingPeriodLabel(billingPeriod: BillingPeriod) {
		switch (billingPeriod) {
			case BillingPeriod.MONTHLY:
				return 'месяц';
			case BillingPeriod.YEARLY:
				return 'год';
			default:
				return billingPeriod;
		}
	}

	private escapeTelegramHtml(value: string | number) {
		return String(value)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	private formatMoscowDate(date: Date) {
		return date.toLocaleDateString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});
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

	private normalizeScheduleTime(value: string, fallback: string) {
		const trimmed = value.trim();

		if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
			return trimmed;
		}

		return fallback;
	}

	private getScheduleTimeParts(value: string, fallback: string) {
		const normalized = this.normalizeScheduleTime(value, fallback);
		const [hour, minute] = normalized.split(':').map(Number);

		return { hour, minute, normalized };
	}

	private ensureScheduleTimesSeparated(
		dailySummaryTime: string,
		databaseBackupTime: string
	) {
		const summaryMinutes = this.getScheduleTimeMinutes(
			dailySummaryTime,
			this.DEFAULT_DAILY_SUMMARY_TIME
		);
		const backupMinutes = this.getScheduleTimeMinutes(
			databaseBackupTime,
			this.DEFAULT_DATABASE_BACKUP_TIME
		);
		const directGap = Math.abs(summaryMinutes - backupMinutes);
		const gap = Math.min(directGap, 24 * 60 - directGap);

		if (gap < this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES) {
			throw new BadRequestException(
				`Разнесите отправку сводки и backup минимум на ${this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES} минут`
			);
		}
	}

	private getScheduleTimeMinutes(value: string, fallback: string) {
		const { hour, minute } = this.getScheduleTimeParts(value, fallback);
		return hour * 60 + minute;
	}

	private getNextMoscowRunDate(hour: number, minute: number) {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedNextRun = new Date(shiftedNow);

		shiftedNextRun.setUTCHours(hour, minute, 0, 0);

		if (shiftedNextRun.getTime() <= shiftedNow.getTime()) {
			shiftedNextRun.setUTCDate(shiftedNextRun.getUTCDate() + 1);
		}

		return new Date(shiftedNextRun.getTime() - offsetMs);
	}

	private async shouldRunStartupDailySummary() {
		const settings = await this.getOrCreateSettings();
		const scheduleTime = this.getScheduleTimeParts(
			settings.dailySummaryTime,
			this.DEFAULT_DAILY_SUMMARY_TIME
		);

		return this.shouldRunStartupMoscowTask(
			scheduleTime.hour,
			scheduleTime.minute
		);
	}

	private async shouldRunStartupDailyDatabaseBackup() {
		const settings = await this.getOrCreateSettings();
		const scheduleTime = this.getScheduleTimeParts(
			settings.databaseBackupTime,
			this.DEFAULT_DATABASE_BACKUP_TIME
		);

		return this.shouldRunStartupMoscowTask(
			scheduleTime.hour,
			scheduleTime.minute
		);
	}

	private shouldRunStartupMoscowTask(hour: number, minute: number) {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedRun = new Date(shiftedNow);

		shiftedRun.setUTCHours(hour, minute, 0, 0);

		return shiftedNow.getTime() >= shiftedRun.getTime();
	}
}
