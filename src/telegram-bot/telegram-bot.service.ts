import {
	BILLING_DATABASE_BACKUP_DELAY_MINUTES,
	CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
	IDENTITY_DATABASE_BACKUP_DELAY_MINUTES,
	NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES,
	PLATFORM_DATABASE_BACKUP_DELAY_MINUTES,
	REPORTING_DATABASE_BACKUP_DELAY_MINUTES,
	SUPPORT_DATABASE_BACKUP_DELAY_MINUTES,
	WIDGETS_DATABASE_BACKUP_DELAY_MINUTES
} from '@/maintenance/database-backup.types';
import { PrismaService } from '@/prisma.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import { resolveTelegramApiBaseUrl } from '@/telegram-bot/telegram-info-transport.service';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type TelegramBotSettings } from '@prisma/client';

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
		(backupMinutes + PLATFORM_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60),
		(backupMinutes + SUPPORT_DATABASE_BACKUP_DELAY_MINUTES) % (24 * 60)
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
export class TelegramBotService {
	private readonly DEFAULT_DATABASE_BACKUP_TIME =
		DEFAULT_DATABASE_BACKUP_TIME;
	private readonly TELEGRAM_SEND_TIMEOUT_MS = 5_000;
	private readonly logger = new Logger(TelegramBotService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService
	) {}

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

	private getSettingsPatch(dto: UpdateTelegramBotSettingsDto) {
		return {
			...(typeof dto.dailySummaryChatId === 'string'
				? { dailySummaryChatId: dto.dailySummaryChatId.trim() }
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
		const supportDatabaseBackupTime = this.addMinutesToTime(
			databaseBackupTime,
			SUPPORT_DATABASE_BACKUP_DELAY_MINUTES
		);

		return {
			dailySummaryChatId: settings.dailySummaryChatId,
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
			supportDatabaseBackupDelayMinutes:
				SUPPORT_DATABASE_BACKUP_DELAY_MINUTES,
			supportDatabaseBackupTime,
			supportDatabaseBackupTimeLabel: `${supportDatabaseBackupTime} МСК`,
			databaseBackupLastSentPeriodStart:
				settings.databaseBackupLastSentPeriodStart?.toISOString() ?? null,
			databaseBackupLastSentAt:
				settings.databaseBackupLastSentAt?.toISOString() ?? null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_INFO_BOT_TOKEN?.trim()
			),
			telegramBotUsernameConfigured: Boolean(this.getInfoBotUsername()),
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private getInfoBotUsername() {
		return (
			process.env.TELEGRAM_INFO_BOT_USERNAME?.trim().replace(/^@/, '') ??
			''
		);
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
