import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import {
	DATABASE_BACKUP_TARGETS,
	DatabaseBackupTarget
} from '@/maintenance/database-backup.types';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	TelegramBotService,
	type TelegramWebhookBot,
	type TelegramSupportBotWebhookUpdate
} from '@/telegram-bot/telegram-bot.service';
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
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
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
			settings = await this.telegramBotService.updateSettings(dto);
		} catch (error) {
			if ('databaseBackupTime' in dto) {
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

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_BOT_SETTINGS_UPDATE',
			description: 'Обновлены настройки Telegram-ботов',
			entityType: 'telegram_bot_settings',
			entityId: 'singleton',
			entityLabel: 'Telegram-боты',
			metadata: {
				dailySummaryChatIdConfigured: Boolean(
					settings.dailySummaryChatId.trim()
				),
				supportThreadIdConfigured: Boolean(settings.supportThreadId),
				databaseBackupThreadIdConfigured: Boolean(
					settings.databaseBackupThreadId
				),
				paymentsThreadIdConfigured: Boolean(settings.paymentsThreadId),
				operationalAlertsThreadIdConfigured: Boolean(
					settings.operationalAlertsThreadId
				),
				databaseBackupEnabled: settings.databaseBackupEnabled,
				databaseBackupTime: settings.databaseBackupTime,
				telegramBotTokenConfigured: settings.telegramBotTokenConfigured,
				supportTelegramBotTokenConfigured:
					settings.supportTelegramBotTokenConfigured
			},
			request
		});

		return settings;
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Get('admin/webhooks/status')
	getWebhookStatuses() {
		return this.telegramBotService.getWebhookStatuses();
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Post('admin/webhooks/reinstall')
	async reinstallWebhooks(
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.telegramBotService.reinstallWebhooks();

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_BOT_WEBHOOK_REINSTALL',
			description: 'Переустановлены webhook Telegram-ботов',
			entityType: 'telegram_webhook',
			entityId: 'all',
			entityLabel: 'Support_bot',
			metadata: result,
			request
		});

		return result;
	}

	@HttpCode(200)
	@Auth('ADMIN')
	@Post('admin/webhooks/:bot/reinstall')
	async reinstallWebhook(
		@Param('bot') bot: TelegramWebhookBot,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result = await this.telegramBotService.reinstallWebhook(bot);

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_BOT_WEBHOOK_REINSTALL',
			description: `Переустановлен webhook ${result.title}`,
			entityType: 'telegram_webhook',
			entityId: result.bot,
			entityLabel: result.title,
			metadata: result,
			request
		});

		return result;
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

		const result =
			await this.scheduledTasksService.enqueueManualDatabaseBackup(
				target,
				adminId,
				idempotencyKey
			);

		if (result.created) {
			const targetLabel = {
				[DATABASE_BACKUP_TARGETS.CORE]: 'основной БД',
				[DATABASE_BACKUP_TARGETS.NOTIFICATION_DELIVERY]:
					'БД Notification Delivery',
				[DATABASE_BACKUP_TARGETS.CAMPAIGNS]: 'БД Campaigns',
				[DATABASE_BACKUP_TARGETS.REPORTING]: 'БД Reporting',
				[DATABASE_BACKUP_TARGETS.WIDGETS]: 'БД Widgets',
				[DATABASE_BACKUP_TARGETS.BILLING]: 'БД Billing',
				[DATABASE_BACKUP_TARGETS.IDENTITY]: 'БД Identity'
			}[target];
			await this.adminEventLogService.record({
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
			});
		}

		return result;
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

	@HttpCode(200)
	@Get('webhook-health')
	getWebhookHealth() {
		return this.telegramBotService.getWebhookHealth();
	}

	@HttpCode(200)
	@Post('support-webhook')
	handleSupportWebhook(
		@Body() update: TelegramSupportBotWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegramBotService.handleSupportWebhook(update, secret);
	}
}
