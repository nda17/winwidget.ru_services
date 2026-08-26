import { BadRequestException, Injectable } from '@nestjs/common';
import type {
	Prisma,
	TelegramBotSettings
} from '@prisma/operations-client';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
	OPERATIONS_NOTIFICATION_ROUTING_CHANGED_EVENT_TYPE,
	OPERATIONS_NOTIFICATION_ROUTING_CHANGED_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	DATABASE_BACKUP_DELAY_MINUTES,
	DATABASE_BACKUP_TARGETS
} from '../scheduled-jobs/scheduled-jobs.types';
import { UpdateTelegramSettingsDto } from './telegram-settings.dto';

export const DEFAULT_DATABASE_BACKUP_TIME = '01:45';
export const DEFAULT_REPORTING_SCHEDULE_TIME = '01:50';
export const MIN_TELEGRAM_TASK_TIME_GAP_MINUTES = 5;

export type TelegramSettingsAuditWriter = (
	transaction: Prisma.TransactionClient,
	settings: ReturnType<TelegramSettingsService['serialize']>
) => Promise<unknown>;

@Injectable()
export class TelegramSettingsService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly config: ConfigService,
		private readonly outbox: OperationsOutboxService
	) {}

	async getSettings() {
		const settings = await this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		return this.serialize(settings);
	}

	updateSettings(
		dto: UpdateTelegramSettingsDto,
		writeAudit: TelegramSettingsAuditWriter
	) {
		return this.prisma.$transaction(async transaction => {
			await transaction.telegramBotSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			await transaction.$queryRaw`
				SELECT "id"
				FROM "operations"."telegram_bot_settings"
				WHERE "id" = 'singleton'
				FOR UPDATE
			`;
			const [current, policy] = await Promise.all([
				transaction.telegramBotSettings.findUniqueOrThrow({
					where: { id: 'singleton' }
				}),
				transaction.reportingSchedulePolicy.upsert({
					where: { id: 'singleton' },
					update: {},
					create: { id: 'singleton' }
				})
			]);
			const patch = this.patch(dto);
			const configuredDailySummaryChatId =
				current.dailySummaryChatId.trim();
			if (
				configuredDailySummaryChatId &&
				patch.dailySummaryChatId !== undefined &&
				patch.dailySummaryChatId !== configuredDailySummaryChatId
			) {
				throw new BadRequestException(
					'Общая Telegram-группа изменяется только через отдельную maintenance-процедуру'
				);
			}
			if (
				current.operationalAlertsThreadId !== null &&
				patch.operationalAlertsThreadId !== undefined &&
				patch.operationalAlertsThreadId !==
					current.operationalAlertsThreadId
			) {
				throw new BadRequestException(
					'Топик системных уведомлений изменяется только через отдельную maintenance-процедуру'
				);
			}
			const next = {
				dailySummaryChatId:
					patch.dailySummaryChatId ?? current.dailySummaryChatId,
				databaseBackupThreadId:
					patch.databaseBackupThreadId !== undefined
						? patch.databaseBackupThreadId
						: current.databaseBackupThreadId,
				paymentsThreadId:
					patch.paymentsThreadId !== undefined
						? patch.paymentsThreadId
						: current.paymentsThreadId,
				operationalAlertsThreadId:
					patch.operationalAlertsThreadId !== undefined
						? patch.operationalAlertsThreadId
						: current.operationalAlertsThreadId,
				databaseBackupEnabled:
					patch.databaseBackupEnabled ?? current.databaseBackupEnabled,
				databaseBackupTime:
					patch.databaseBackupTime ?? current.databaseBackupTime
			};
			for (const protectedTime of [
				policy.reservationTime,
				policy.pendingTime
			].filter((value): value is string => Boolean(value))) {
				ensureSchedulesSeparated(protectedTime, next.databaseBackupTime);
			}
			if (
				!next.dailySummaryChatId.trim() &&
				[
					next.databaseBackupThreadId,
					next.paymentsThreadId,
					next.operationalAlertsThreadId
				].some(Boolean)
			) {
				throw new BadRequestException(
					'Укажите ID Telegram-группы для настроенных топиков'
				);
			}
			if (!next.operationalAlertsThreadId) {
				throw new BadRequestException(
					'Укажите ID топика системных уведомлений'
				);
			}
			if (
				next.databaseBackupEnabled &&
				(!next.dailySummaryChatId.trim() || !next.databaseBackupThreadId)
			) {
				throw new BadRequestException(
					'Для backup укажите Telegram-группу и топик Backups'
				);
			}
			const updated = await transaction.telegramBotSettings.update({
				where: { id: 'singleton' },
				data: patch
			});
			const serialized = this.serialize(updated);
			await writeAudit(transaction, serialized);
			if (
				current.operationalAlertsThreadId !==
				updated.operationalAlertsThreadId
			) {
				const eventId = randomUUID();
				await this.outbox.enqueue(transaction, {
					eventId,
					deduplicationKey: `operations-notification-routing:${eventId}`,
					eventType: OPERATIONS_NOTIFICATION_ROUTING_CHANGED_EVENT_TYPE,
					aggregateType: 'telegram-bot-settings',
					aggregateId: 'singleton',
					routingKey: OPERATIONS_NOTIFICATION_ROUTING_CHANGED_ROUTING_KEY,
					payload: {
						schemaVersion: 1,
						eventId,
						operationalAlertsThreadId: updated.operationalAlertsThreadId,
						changedAt: updated.updatedAt.toISOString()
					}
				});
			}
			return serialized;
		});
	}

	serialize(settings: TelegramBotSettings) {
		const databaseBackupTime = normalizeTime(
			settings.databaseBackupTime,
			DEFAULT_DATABASE_BACKUP_TIME
		);
		const schedule = Object.fromEntries(
			DATABASE_BACKUP_TARGETS.map(target => [
				target,
				addMinutes(
					databaseBackupTime,
					DATABASE_BACKUP_DELAY_MINUTES[target]
				)
			])
		) as Record<(typeof DATABASE_BACKUP_TARGETS)[number], string>;
		return {
			dailySummaryChatId: settings.dailySummaryChatId,
			databaseBackupThreadId: settings.databaseBackupThreadId,
			paymentsThreadId: settings.paymentsThreadId,
			operationalAlertsThreadId: settings.operationalAlertsThreadId,
			databaseBackupEnabled: settings.databaseBackupEnabled,
			databaseBackupTime,
			databaseBackupTimeLabel: `${databaseBackupTime} МСК`,
			notificationDeliveryDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES['notification-delivery'],
			notificationDeliveryDatabaseBackupTime:
				schedule['notification-delivery'],
			notificationDeliveryDatabaseBackupTimeLabel: `${schedule['notification-delivery']} МСК`,
			campaignsDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.campaigns,
			campaignsDatabaseBackupTime: schedule.campaigns,
			campaignsDatabaseBackupTimeLabel: `${schedule.campaigns} МСК`,
			reportingDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.reporting,
			reportingDatabaseBackupTime: schedule.reporting,
			reportingDatabaseBackupTimeLabel: `${schedule.reporting} МСК`,
			widgetsDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.widgets,
			widgetsDatabaseBackupTime: schedule.widgets,
			widgetsDatabaseBackupTimeLabel: `${schedule.widgets} МСК`,
			billingDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.billing,
			billingDatabaseBackupTime: schedule.billing,
			billingDatabaseBackupTimeLabel: `${schedule.billing} МСК`,
			identityDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.identity,
			identityDatabaseBackupTime: schedule.identity,
			identityDatabaseBackupTimeLabel: `${schedule.identity} МСК`,
			platformDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.platform,
			platformDatabaseBackupTime: schedule.platform,
			platformDatabaseBackupTimeLabel: `${schedule.platform} МСК`,
			supportDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.support,
			supportDatabaseBackupTime: schedule.support,
			supportDatabaseBackupTimeLabel: `${schedule.support} МСК`,
			operationsDatabaseBackupDelayMinutes:
				DATABASE_BACKUP_DELAY_MINUTES.operations,
			operationsDatabaseBackupTime: schedule.operations,
			operationsDatabaseBackupTimeLabel: `${schedule.operations} МСК`,
			databaseBackupSchedule: schedule,
			databaseBackupLastSentPeriodStart:
				settings.databaseBackupLastSentPeriodStart?.toISOString() ?? null,
			databaseBackupLastSentAt:
				settings.databaseBackupLastSentAt?.toISOString() ?? null,
			telegramBotTokenConfigured:
				this.config
					.get<string>('TELEGRAM_INFO_BOT_CONFIGURED')
					?.trim()
					.toLowerCase() === 'true',
			telegramBotUsernameConfigured: Boolean(
				this.config
					.get<string>('TELEGRAM_INFO_BOT_USERNAME')
					?.trim()
					.replace(/^@/, '')
			),
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private patch(dto: UpdateTelegramSettingsDto) {
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
						databaseBackupTime: normalizeTime(
							dto.databaseBackupTime,
							DEFAULT_DATABASE_BACKUP_TIME
						)
					}
				: {})
		};
	}
}

export const ensureSchedulesSeparated = (
	reportingTime: string,
	backupTime: string
): void => {
	const reportingMinutes = timeMinutes(
		reportingTime,
		DEFAULT_REPORTING_SCHEDULE_TIME
	);
	const backupMinutes = timeMinutes(
		backupTime,
		DEFAULT_DATABASE_BACKUP_TIME
	);
	for (const delay of Object.values(DATABASE_BACKUP_DELAY_MINUTES)) {
		const targetMinutes = (backupMinutes + delay) % (24 * 60);
		const direct = Math.abs(reportingMinutes - targetMinutes);
		const gap = Math.min(direct, 24 * 60 - direct);
		if (gap < MIN_TELEGRAM_TASK_TIME_GAP_MINUTES) {
			throw new BadRequestException(
				`Разнесите отправку сводки и все backup минимум на ${MIN_TELEGRAM_TASK_TIME_GAP_MINUTES} минут`
			);
		}
	}
};

const normalizeTime = (value: string, fallback: string): string => {
	const normalized = value.trim();
	return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)
		? normalized
		: fallback;
};

const timeMinutes = (value: string, fallback: string): number => {
	const [hours, minutes] = normalizeTime(value, fallback)
		.split(':')
		.map(Number);
	return hours * 60 + minutes;
};

const addMinutes = (value: string, increment: number): string => {
	const minutes =
		(timeMinutes(value, DEFAULT_DATABASE_BACKUP_TIME) + increment) %
		(24 * 60);
	return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(
		minutes % 60
	).padStart(2, '0')}`;
};
