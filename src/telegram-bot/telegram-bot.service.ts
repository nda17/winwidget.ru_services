import {
	CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
	NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES
} from '@/maintenance/database-backup.types';
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
	type TelegramBotSettings,
	type TelegramNotificationChannel,
	type VerificationChallenge,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/client';
import { hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';

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
	private readonly logger = new Logger(TelegramBotService.name);
	private webhookHealthcheckInterval: NodeJS.Timeout | null = null;
	private webhookHealthcheckInProgress = false;

	constructor(private readonly prisma: PrismaService) {}

	async onModuleInit() {
		void this.ensureWebhooksOnStartup();
		this.scheduleWebhookHealthcheck();
	}

	onModuleDestroy() {
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
						info: `${webhookHost}/api/v1/telegram-bot/webhook`,
						auth: `${webhookHost}/api/v1/telegram-auth/webhook`,
						support: `${webhookHost}/api/v1/telegram-bot/support-webhook`
					}
				: null,
			checkedAt: new Date().toISOString()
		};
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

	async sendMessagingOperationalAlert(text: string): Promise<boolean> {
		const settings = await this.getOrCreateSettings();
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.reportsThreadId;
		if (!chatId || !messageThreadId) {
			this.logger.warn(
				'Messaging alert skipped: Reports topic is not configured.'
			);
			return false;
		}
		await this.sendInfoBotMessage(chatId, text, {
			parseMode: 'HTML',
			messageThreadId
		});
		return true;
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

		return `${host}/api/v1/${path}`;
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
		const notificationDeliveryDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES
		);
		const campaignsDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES
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
			notificationDeliveryDatabaseBackupDelayMinutes:
				NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES,
			notificationDeliveryDatabaseBackupTime,
			notificationDeliveryDatabaseBackupTimeLabel: `${notificationDeliveryDatabaseBackupTime} МСК`,
			campaignsDatabaseBackupDelayMinutes:
				CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
			campaignsDatabaseBackupTime,
			campaignsDatabaseBackupTimeLabel: `${campaignsDatabaseBackupTime} МСК`,
			databaseBackupLastSentPeriodStart:
				settings.databaseBackupLastSentPeriodStart?.toISOString() ?? null,
			databaseBackupLastSentAt:
				settings.databaseBackupLastSentAt?.toISOString() ?? null,
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
				? `${webhookHost}/api/v1/telegram-bot/webhook-health`
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
			) || ''
		);
	}

	private getInfoBotUsername() {
		return (
			process.env.TELEGRAM_INFO_BOT_USERNAME?.trim().replace(/^@/, '') ??
			''
		);
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
		const notificationDeliveryBackupMinutes =
			(backupMinutes +
				NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES) %
			(24 * 60);
		const campaignsBackupMinutes =
			(backupMinutes + CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES) %
			(24 * 60);
		const coreGap = this.getCircularTimeGapMinutes(
			summaryMinutes,
			backupMinutes
		);
		const notificationDeliveryGap = this.getCircularTimeGapMinutes(
			summaryMinutes,
			notificationDeliveryBackupMinutes
		);
		const campaignsGap = this.getCircularTimeGapMinutes(
			summaryMinutes,
			campaignsBackupMinutes
		);

		if (
			coreGap < this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES ||
			notificationDeliveryGap < this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES ||
			campaignsGap < this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES
		) {
			throw new BadRequestException(
				`Разнесите отправку сводки и все backup минимум на ${this.MIN_TELEGRAM_TASK_TIME_GAP_MINUTES} минут`
			);
		}
	}

	private getCircularTimeGapMinutes(first: number, second: number) {
		const directGap = Math.abs(first - second);
		return Math.min(directGap, 24 * 60 - directGap);
	}

	private addMinutesToTime(value: string, minutesToAdd: number) {
		const minutes =
			(this.getScheduleTimeMinutes(
				value,
				this.DEFAULT_DATABASE_BACKUP_TIME
			) +
				minutesToAdd) %
			(24 * 60);
		return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
			minutes % 60
		).padStart(2, '0')}`;
	}

	private getScheduleTimeMinutes(value: string, fallback: string) {
		const { hour, minute } = this.getScheduleTimeParts(value, fallback);
		return hour * 60 + minute;
	}
}
