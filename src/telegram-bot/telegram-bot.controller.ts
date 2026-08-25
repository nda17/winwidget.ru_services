import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	DATABASE_BACKUP_TARGETS,
	DatabaseBackupTarget
} from '@/maintenance/database-backup.types';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Body,
	BadRequestException,
	ConflictException,
	Controller,
	Get,
	Headers,
	HttpCode,
	NotFoundException,
	Param,
	ParseEnumPipe,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import { isUUID } from 'class-validator';
import { Request } from 'express';

@Controller('telegram-bot')
export class TelegramBotController {
	constructor(
		private readonly telegramBotService: TelegramBotService,
		private readonly adminEventLogService: AdminEventLogService,
		private readonly scheduledTasksService: ScheduledTasksService
	) {}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/settings')
	getSettings() {
		return this.telegramBotService.getSettings();
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch('admin/settings')
	async updateSettings(
		@Body() dto: UpdateTelegramBotSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		let settings;
		try {
			settings = await this.telegramBotService.updateSettings(
				dto,
				(transaction, nextSettings) =>
					this.adminEventLogService.recordInTransaction(transaction, {
						adminId,
						section: 'TELEGRAM_BOT',
						action: 'TELEGRAM_BOT_SETTINGS_UPDATE',
						description: 'Обновлены настройки Telegram-ботов',
						entityType: 'telegram_bot_settings',
						entityId: 'singleton',
						entityLabel: 'Telegram-боты',
						metadata: {
							dailySummaryChatIdConfigured: Boolean(
								nextSettings.dailySummaryChatId.trim()
							),
							databaseBackupThreadIdConfigured: Boolean(
								nextSettings.databaseBackupThreadId
							),
							paymentsThreadIdConfigured: Boolean(
								nextSettings.paymentsThreadId
							),
							operationalAlertsThreadIdConfigured: Boolean(
								nextSettings.operationalAlertsThreadId
							),
							databaseBackupEnabled: nextSettings.databaseBackupEnabled,
							databaseBackupTime: nextSettings.databaseBackupTime,
							telegramBotTokenConfigured:
								nextSettings.telegramBotTokenConfigured,
							telegramBotUsernameConfigured:
								nextSettings.telegramBotUsernameConfigured
						},
						request
					})
			);
		} catch (error) {
			if (
				'databaseBackupTime' in dto &&
				(error instanceof BadRequestException ||
					error instanceof ConflictException)
			) {
				await this.adminEventLogService.record({
					adminId,
					section: 'TELEGRAM_BOT',
					action: 'TELEGRAM_SCHEDULE_SETTINGS_REJECTED',
					description: 'Отклонено изменение расписания backup',
					entityType: 'telegram_schedule_policy',
					entityId: 'singleton',
					entityLabel: 'Backup',
					metadata: {
						reasonCode:
							error instanceof ConflictException
								? 'OWNER_CONFLICT'
								: 'SCHEDULE_VALIDATION_FAILED'
					},
					request
				});
			}
			throw error;
		}
		return settings;
	}

	@HttpCode(202)
	@Auth('ADMIN')
	@Post('admin/database-backups/:target/send')
	async sendDatabaseBackup(
		@Param('target', new ParseEnumPipe(DATABASE_BACKUP_TARGETS))
		target: DatabaseBackupTarget,
		@CurrentUser('id') adminId: string,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@Req() request: Request
	) {
		if (!idempotencyKey || !isUUID(idempotencyKey)) {
			throw new BadRequestException(
				'Заголовок Idempotency-Key должен содержать UUID'
			);
		}

		const targetLabel = this.getDatabaseBackupTargetLabel(target);
		return this.scheduledTasksService.enqueueManualDatabaseBackup(
			target,
			adminId,
			idempotencyKey,
			(transaction, result) =>
				this.adminEventLogService.recordInTransaction(transaction, {
					adminId,
					section: 'TELEGRAM_BOT',
					action: 'TELEGRAM_DATABASE_BACKUP_CREATE',
					description: `Backup ${targetLabel} поставлен в очередь`,
					entityType: 'scheduled_job',
					entityId: result.jobId,
					entityLabel: `Backup PostgreSQL: ${targetLabel}`,
					metadata: {
						target,
						jobId: result.jobId,
						status: result.status,
						queuedAt: result.queuedAt
					},
					request
				})
		);
	}

	private getDatabaseBackupTargetLabel(
		target: DatabaseBackupTarget
	): string {
		return {
			[DATABASE_BACKUP_TARGETS.NOTIFICATION_DELIVERY]:
				'БД Notification Delivery',
			[DATABASE_BACKUP_TARGETS.CAMPAIGNS]: 'БД Campaigns',
			[DATABASE_BACKUP_TARGETS.REPORTING]: 'БД Reporting',
			[DATABASE_BACKUP_TARGETS.WIDGETS]: 'БД Widgets',
			[DATABASE_BACKUP_TARGETS.BILLING]: 'БД Billing',
			[DATABASE_BACKUP_TARGETS.IDENTITY]: 'БД Identity',
			[DATABASE_BACKUP_TARGETS.PLATFORM]: 'БД Platform',
			[DATABASE_BACKUP_TARGETS.SUPPORT]: 'БД Support',
			[DATABASE_BACKUP_TARGETS.OPERATIONS]: 'БД Operations'
		}[target];
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/database-backups/overview')
	getDatabaseBackupOverview() {
		return this.scheduledTasksService.getDatabaseBackupOverview();
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/database-backups/jobs')
	getDatabaseBackupJobs(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('target') target?: string,
		@Query('trigger') trigger?: string,
		@Query('status') status?: string
	) {
		const parsedPage = this.parsePositiveInteger(page, 1, 'page');
		const parsedLimit = this.parsePositiveInteger(limit, 20, 'limit');
		if (parsedLimit > 100) {
			throw new BadRequestException('limit не должен превышать 100');
		}
		if (parsedPage - 1 > Math.floor(2_147_483_647 / parsedLimit)) {
			throw new BadRequestException('page выходит за допустимый диапазон');
		}
		if (
			target &&
			!Object.values(DATABASE_BACKUP_TARGETS).includes(
				target as DatabaseBackupTarget
			)
		) {
			throw new BadRequestException('Некорректная цель database backup');
		}
		if (
			trigger &&
			!Object.values(ScheduledJobRunTrigger).includes(
				trigger as ScheduledJobRunTrigger
			)
		) {
			throw new BadRequestException(
				'Некорректный trigger database backup'
			);
		}
		if (
			status &&
			!Object.values(ScheduledJobRunStatus).includes(
				status as ScheduledJobRunStatus
			)
		) {
			throw new BadRequestException('Некорректный status database backup');
		}

		return this.scheduledTasksService.getDatabaseBackupJobs({
			page: parsedPage,
			limit: parsedLimit,
			...(target ? { target: target as DatabaseBackupTarget } : {}),
			...(trigger ? { trigger: trigger as ScheduledJobRunTrigger } : {}),
			...(status ? { status: status as ScheduledJobRunStatus } : {})
		});
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/database-backups/:target/jobs/active')
	getLatestActiveManualDatabaseBackup(
		@Param('target', new ParseEnumPipe(DATABASE_BACKUP_TARGETS))
		target: DatabaseBackupTarget,
		@CurrentUser('id') adminId: string
	) {
		return this.scheduledTasksService.getLatestActiveManualDatabaseBackup(
			target,
			adminId
		);
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/database-backups/:target/jobs/:jobId')
	async getDatabaseBackupJob(
		@Param('target', new ParseEnumPipe(DATABASE_BACKUP_TARGETS))
		target: DatabaseBackupTarget,
		@Param('jobId', new ParseUUIDPipe()) jobId: string,
		@CurrentUser('id') adminId: string
	) {
		const job = await this.scheduledTasksService.getDatabaseBackupJob(
			target,
			jobId,
			adminId
		);
		if (!job) {
			throw new NotFoundException('Задание backup не найдено');
		}
		return job;
	}

	private parsePositiveInteger(
		value: string | undefined,
		fallback: number,
		field: string
	) {
		if (value === undefined) return fallback;
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw new BadRequestException(
				`${field} должен быть целым числом от 1`
			);
		}
		return parsed;
	}
}
