import {
	BILLING_DATABASE_BACKUP_DELAY_MINUTES,
	CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
	IDENTITY_DATABASE_BACKUP_DELAY_MINUTES,
	NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES,
	PLATFORM_DATABASE_BACKUP_DELAY_MINUTES,
	REPORTING_DATABASE_BACKUP_DELAY_MINUTES,
	WIDGETS_DATABASE_BACKUP_DELAY_MINUTES
} from '@/maintenance/database-backup.types';
import { PrismaService } from '@/prisma.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import { resolveTelegramApiBaseUrl } from '@/telegram-bot/telegram-info-transport.service';
import {
	BadRequestException,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TelegramBotSettings } from '@prisma/client';

const TELEGRAM_SUPPORT_BOT_NOT_CONFIGURED =
	'Telegram support bot not configured';
const TELEGRAM_SUPPORT_WEBHOOK_SECRET_INVALID =
	'Telegram support webhook secret invalid';

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

export type TelegramSupportBotWebhookUpdate = {
	update_id?: number;
	message?: TelegramMessage;
};

export type TelegramWebhookBot = 'support';

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

export const DEFAULT_REPORTING_SCHEDULE_TIME = '01:50';
export const DEFAULT_DATABASE_BACKUP_TIME = '01:45';
export const MIN_TELEGRAM_TASK_TIME_GAP_MINUTES = 5;

const normalizeScheduleTimeValue = (value: string, fallback: string) => {
	const trimmed = value.trim();
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed) ? trimmed : fallback;
};

const scheduleTimeMinutes = (value: string, fallback: string) => {
	const [hour, minute] = normalizeScheduleTimeValue(value, fallback)
		.split(':')
		.map(Number);
	return hour * 60 + minute;
};

const circularTimeGapMinutes = (first: number, second: number) => {
	const directGap = Math.abs(first - second);
	return Math.min(directGap, 24 * 60 - directGap);
};

export const ensureReportingBackupScheduleSeparated = (
	reportingScheduleTime: string,
	databaseBackupTime: string
) => {
	const summaryMinutes = scheduleTimeMinutes(
		reportingScheduleTime,
		DEFAULT_REPORTING_SCHEDULE_TIME
	);
	const backupMinutes = scheduleTimeMinutes(
		databaseBackupTime,
		DEFAULT_DATABASE_BACKUP_TIME
	);
	const backupSchedule = [
		backupMinutes,
		(backupMinutes + NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES) %
			(24 * 60),
		(backupMinutes + CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + REPORTING_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + WIDGETS_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + BILLING_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + IDENTITY_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + PLATFORM_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60)
	];

	if (
		backupSchedule.some(
			backup =>
				circularTimeGapMinutes(summaryMinutes, backup) <
				MIN_TELEGRAM_TASK_TIME_GAP_MINUTES
		)
	) {
		throw new BadRequestException(
			`Разнесите отправку сводки и все backup минимум на ${MIN_TELEGRAM_TASK_TIME_GAP_MINUTES} минут`
		);
	}
};

interface ReportingScheduleAuthorityState {
	dailySummaryOwner: string;
	dailySummaryPolicyReservationTime: string;
	dailySummaryPolicyReservationGeneration: bigint;
	dailySummaryPolicyPendingTime: string | null;
	dailySummaryPolicyPendingGeneration: bigint | null;
}

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
	private readonly DEFAULT_DATABASE_BACKUP_TIME =
		DEFAULT_DATABASE_BACKUP_TIME;
	private readonly TELEGRAM_SEND_TIMEOUT_MS = 5_000;
	private readonly TELEGRAM_API_STATUS_TIMEOUT_MS = 10_000;
	private readonly TELEGRAM_WEBHOOK_MAX_CONNECTIONS = 40;
	private readonly TELEGRAM_WEBHOOK_HEALTHCHECK_INTERVAL_MS = 60_000;
	private readonly logger = new Logger(TelegramBotService.name);
	private webhookHealthcheckInterval: NodeJS.Timeout | null = null;
	private webhookHealthcheckInProgress = false;

	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService
	) {}

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
		return this.prisma.$transaction(async transaction => {
			await transaction.telegramBotSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			const lockedSettings = await transaction.$queryRaw<
				Array<{ id: string }>
			>(Prisma.sql`
				SELECT "id"
				FROM "telegram_bot_settings"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`);
			if (lockedSettings.length !== 1) {
				throw new Error('Telegram settings row is missing');
			}
			const currentSettings =
				await transaction.telegramBotSettings.findUniqueOrThrow({
					where: { id: 'singleton' }
				});
			const authorities = await transaction.$queryRaw<
				ReportingScheduleAuthorityState[]
			>(Prisma.sql`
				SELECT
					"daily_summary_owner" AS "dailySummaryOwner",
					"daily_summary_schedule_time" AS "dailySummaryPolicyReservationTime",
					"daily_summary_schedule_generation" AS "dailySummaryPolicyReservationGeneration",
					"daily_summary_policy_pending_time" AS "dailySummaryPolicyPendingTime",
					"daily_summary_policy_pending_generation" AS "dailySummaryPolicyPendingGeneration"
				FROM "reporting_producer_state"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`);
			if (
				authorities.length !== 1 ||
				!['CORE', 'REPORTING'].includes(
					authorities[0].dailySummaryOwner
				) ||
				!/^([01]\d|2[0-3]):[0-5]\d$/.test(
					authorities[0].dailySummaryPolicyReservationTime
				) ||
				authorities[0].dailySummaryPolicyReservationGeneration < 0n ||
				(authorities[0].dailySummaryPolicyPendingTime !== null &&
					(!/^([01]\d|2[0-3]):[0-5]\d$/.test(
						authorities[0].dailySummaryPolicyPendingTime
					) ||
						authorities[0].dailySummaryPolicyPendingGeneration !==
							authorities[0].dailySummaryPolicyReservationGeneration +
								1n)) ||
				(authorities[0].dailySummaryPolicyPendingTime === null) !==
					(authorities[0].dailySummaryPolicyPendingGeneration === null)
			) {
				throw new Error(
					'Daily Summary backup-policy state is missing or invalid'
				);
			}
			return this.updateSettingsLocked(
				transaction,
				dto,
				authorities[0],
				currentSettings
			);
		});
	}

	private async updateSettingsLocked(
		transaction: Prisma.TransactionClient,
		dto: UpdateTelegramBotSettingsDto,
		authority: ReportingScheduleAuthorityState,
		currentSettings: TelegramBotSettings
	) {
		const data = this.getSettingsPatch(dto);
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
		const nextOperationalAlertsThreadId =
			data.operationalAlertsThreadId !== undefined
				? data.operationalAlertsThreadId
				: currentSettings.operationalAlertsThreadId;
		const nextDatabaseBackupTime =
			data.databaseBackupTime ?? currentSettings.databaseBackupTime;

		const schedulesProtectedByCorePolicy = [
			authority.dailySummaryPolicyReservationTime,
			authority.dailySummaryPolicyPendingTime
		].filter((value): value is string => value !== null);
		for (const scheduleTime of schedulesProtectedByCorePolicy) {
			this.ensureScheduleTimesSeparated(
				scheduleTime,
				nextDatabaseBackupTime
			);
		}

		if (
			!nextDailySummaryChatId.trim() &&
			[
				nextSupportThreadId,
				nextDatabaseBackupThreadId,
				nextPaymentsThreadId,
				nextOperationalAlertsThreadId
			].some(Boolean)
		) {
			throw new BadRequestException(
				'Укажите ID Telegram-группы для настроенных топиков'
			);
		}
		if (!nextOperationalAlertsThreadId) {
			throw new BadRequestException(
				'Укажите ID топика системных уведомлений Core'
			);
		}
		const updatesDatabaseBackupDelivery =
			'databaseBackupEnabled' in data ||
			'dailySummaryChatId' in data ||
			'databaseBackupTime' in data ||
			'databaseBackupThreadId' in data;

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

		const settings = await transaction.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: data,
			create: {
				id: 'singleton',
				...data
			}
		});
		return this.serializeSettings(settings);
	}

	async reinstallWebhook(bot: string) {
		const config = this.getWebhookConfig(bot);
		const webhookUrl = this.getWebhookUrl(config.path);

		if (!config.token?.trim()) {
			throw new BadRequestException(this.getBotNotConfiguredError());
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
		return { items: [await this.reinstallWebhook('support')] };
	}

	async getWebhookStatuses() {
		const configs: TelegramWebhookConfig[] = [
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
		const messageThreadId = settings.operationalAlertsThreadId;
		if (!chatId || !messageThreadId) {
			this.logger.warn(
				'Messaging alert skipped: operational alerts topic is not configured.'
			);
			return false;
		}
		await this.sendInfoBotMessage(chatId, text, {
			parseMode: 'HTML',
			messageThreadId
		});
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

	private getWebhookConfig(bot: string): TelegramWebhookConfig {
		if (bot !== 'support') {
			throw new BadRequestException('Неизвестный Telegram-бот');
		}
		return {
			bot: 'support',
			title: 'Support_bot',
			token: process.env.TELEGRAM_SUPPORT_BOT_TOKEN,
			username: this.getSupportBotUsername(),
			secret: process.env.TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET,
			path: 'telegram-bot/support-webhook',
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
			throw new Error(this.getBotNotConfiguredError());
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
			throw new Error(this.getBotNotConfiguredError());
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
				error: this.getBotNotConfiguredError()
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

	private getBotNotConfiguredError() {
		return TELEGRAM_SUPPORT_BOT_NOT_CONFIGURED;
	}

	private getSettingsPatch(dto: UpdateTelegramBotSettingsDto) {
		return {
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
			...(dto.operationalAlertsThreadId === null ||
			typeof dto.operationalAlertsThreadId === 'number'
				? { operationalAlertsThreadId: dto.operationalAlertsThreadId }
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
		const reportingDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			REPORTING_DATABASE_BACKUP_DELAY_MINUTES
		);
		const widgetsDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			WIDGETS_DATABASE_BACKUP_DELAY_MINUTES
		);
		const billingDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			BILLING_DATABASE_BACKUP_DELAY_MINUTES
		);
		const identityDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			IDENTITY_DATABASE_BACKUP_DELAY_MINUTES
		);
		const platformDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			PLATFORM_DATABASE_BACKUP_DELAY_MINUTES
		);

		return {
			dailySummaryChatId: settings.dailySummaryChatId,
			supportThreadId: settings.supportThreadId,
			databaseBackupThreadId: settings.databaseBackupThreadId,
			paymentsThreadId: settings.paymentsThreadId,
			operationalAlertsThreadId: settings.operationalAlertsThreadId,
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
			reportingDatabaseBackupDelayMinutes:
				REPORTING_DATABASE_BACKUP_DELAY_MINUTES,
			reportingDatabaseBackupTime,
			reportingDatabaseBackupTimeLabel: `${reportingDatabaseBackupTime} МСК`,
			widgetsDatabaseBackupDelayMinutes:
				WIDGETS_DATABASE_BACKUP_DELAY_MINUTES,
			widgetsDatabaseBackupTime,
			widgetsDatabaseBackupTimeLabel: `${widgetsDatabaseBackupTime} МСК`,
			billingDatabaseBackupDelayMinutes:
				BILLING_DATABASE_BACKUP_DELAY_MINUTES,
			billingDatabaseBackupTime,
			billingDatabaseBackupTimeLabel: `${billingDatabaseBackupTime} МСК`,
			identityDatabaseBackupDelayMinutes:
				IDENTITY_DATABASE_BACKUP_DELAY_MINUTES,
			identityDatabaseBackupTime,
			identityDatabaseBackupTimeLabel: `${identityDatabaseBackupTime} МСК`,
			platformDatabaseBackupDelayMinutes:
				PLATFORM_DATABASE_BACKUP_DELAY_MINUTES,
			platformDatabaseBackupTime,
			platformDatabaseBackupTimeLabel: `${platformDatabaseBackupTime} МСК`,
			databaseBackupLastSentPeriodStart:
				settings.databaseBackupLastSentPeriodStart?.toISOString() ?? null,
			databaseBackupLastSentAt:
				settings.databaseBackupLastSentAt?.toISOString() ?? null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername()),
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
		const apiBaseUrl = resolveTelegramApiBaseUrl(this.configService);
		const response = await fetch(`${apiBaseUrl}/bot${token}/${method}`, {
			method: body ? 'POST' : 'GET',
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			signal: AbortSignal.timeout(timeoutMs),
			body: body ? JSON.stringify(body) : undefined
		});
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
		const apiBaseUrl = resolveTelegramApiBaseUrl(this.configService);
		const response = await fetch(`${apiBaseUrl}/bot${token}/sendMessage`, {
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
		});

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
		reportingScheduleTime: string,
		databaseBackupTime: string
	) {
		ensureReportingBackupScheduleSeparated(
			reportingScheduleTime,
			databaseBackupTime
		);
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
