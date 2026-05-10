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
	PaymentStatus,
	SubscriptionStatus,
	type TelegramBotSettings,
	type TelegramNotificationChannel,
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
		const nextDailySummaryTime =
			data.dailySummaryTime ?? currentSettings.dailySummaryTime;
		const nextDatabaseBackupTime =
			data.databaseBackupTime ?? currentSettings.databaseBackupTime;

		this.ensureScheduleTimesSeparated(
			nextDailySummaryTime,
			nextDatabaseBackupTime
		);

		if (
			(nextDailySummaryEnabled || nextDatabaseBackupEnabled) &&
			!nextDailySummaryChatId.trim()
		) {
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
		options?: { parseMode?: 'HTML' | null }
	) {
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();

		if (!token) {
			throw new Error('Info_bot token is not configured');
		}

		await this.sendTelegramMessage(token, chatId, text, options);
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
					this.logger.log(
						`Telegram webhook ${config.title} checked on startup.`
					);
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
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername())
		};
	}

	private async handleNotificationMessage(message: TelegramMessage) {
		if (!message.text?.startsWith('/start')) {
			if (!message.chat.type || message.chat.type === 'private') {
				await this.sendInfoBotMessage(
					String(message.chat.id),
					'Чтобы подключить уведомления, откройте профиль winwidget.ru и нажмите кнопку подключения Telegram-уведомлений.'
				);
			}

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

		const settings = await this.getOrCreateSettings();
		const adminChatId = settings.dailySummaryChatId.trim();

		if (!adminChatId) {
			await this.sendSupportBotMessage(
				userChatId,
				'Служба поддержки временно недоступна. Пожалуйста, попробуйте позже.'
			);
			return;
		}

		const copiedMessage = await this.copySupportBotMessage(
			adminChatId,
			userChatId,
			message.message_id
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
				reply_to_message_id: copiedMessage.message_id
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
					reply_to_message_id: message.message_id
				}
			);
		} catch (error) {
			await this.sendSupportBotMessage(
				adminChatId,
				'Не удалось отправить ответ пользователю. Возможно, пользователь заблокировал бота.',
				{
					reply_to_message_id: message.message_id
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
		const moscowTime = new Date(
			nextRun.getTime() + this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000
		);

		this.logger.log(
			`Next Telegram database backup scheduled for ${moscowTime.toISOString().replace('T', ' ').slice(0, 16)} MSK.`
		);

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

		if (!settings.databaseBackupEnabled || !chatId || !token) {
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
		const token = process.env.TELEGRAM_INFO_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();

		if (!token) {
			throw new BadRequestException(
				TELEGRAM_NOTIFICATION_BOT_NOT_CONFIGURED
			);
		}

		if (!chatId) {
			throw new BadRequestException('Укажите ID группы Telegram');
		}

		await this.sendTelegramDocument(
			token,
			chatId,
			filePath,
			[
				'<b>Backup базы данных WinWidget</b>',
				`Создано: ${this.formatMoscowDateTime(new Date())} МСК`,
				`Тип: ${trigger === 'manual' ? 'ручной' : 'ежедневный'}`
			].join('\n')
		);

		return true;
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
			const message =
				error instanceof Error
					? error.message
					: 'PostgreSQL command failed';
			throw new BadRequestException(message);
		}
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

	private async sendSupportBotMessage(
		chatId: string,
		text: string,
		options?: { reply_to_message_id?: number }
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
		messageId: number
	) {
		const data = await this.fetchTelegramApi<{
			ok?: boolean;
			result?: { message_id: number };
		}>(this.getSupportBotToken(), 'copyMessage', {
			chat_id: chatId,
			from_chat_id: fromChatId,
			message_id: messageId
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
		caption: string
	) {
		const fileBuffer = await readFile(filePath);
		const formData = new FormData();

		formData.append('chat_id', chatId);
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
		options?: { parseMode?: 'HTML' | null }
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
