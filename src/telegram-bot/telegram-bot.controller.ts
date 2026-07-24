import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	TelegramBotService,
	type TelegramWebhookBot,
	type TelegramInfoBotWebhookUpdate,
	type TelegramSupportBotWebhookUpdate
} from '@/telegram-bot/telegram-bot.service';
import {
	Body,
	BadRequestException,
	Controller,
	Get,
	Headers,
	HttpCode,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
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
	@Auth(Role.ADMIN)
	@Get('admin/settings')
	getSettings() {
		return this.telegramBotService.getSettings();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Patch('admin/settings')
	async updateSettings(
		@Body() dto: UpdateTelegramBotSettingsDto,
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const settings = await this.telegramBotService.updateSettings(dto);

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_BOT_SETTINGS_UPDATE',
			description: 'Обновлены настройки Telegram-ботов',
			entityType: 'telegram_bot_settings',
			entityId: 'singleton',
			entityLabel: 'Telegram-боты',
			metadata: {
				dailySummaryEnabled: settings.dailySummaryEnabled,
				dailySummaryChatIdConfigured: Boolean(
					settings.dailySummaryChatId.trim()
				),
				supportThreadIdConfigured: Boolean(settings.supportThreadId),
				databaseBackupThreadIdConfigured: Boolean(
					settings.databaseBackupThreadId
				),
				paymentsThreadIdConfigured: Boolean(settings.paymentsThreadId),
				reportsThreadIdConfigured: Boolean(settings.reportsThreadId),
				dailySummaryTime: settings.dailySummaryTime,
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
	@Auth(Role.ADMIN)
	@Get('admin/webhooks/status')
	getWebhookStatuses() {
		return this.telegramBotService.getWebhookStatuses();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
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
			entityLabel: 'Auth_bot + Info_bot + Support_bot',
			metadata: result,
			request
		});

		return result;
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
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
	@Auth(Role.ADMIN)
	@Post('admin/database-backup/send')
	async sendDatabaseBackup(
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
				adminId,
				idempotencyKey
			);

		if (result.created) {
			await this.adminEventLogService.record({
				adminId,
				section: 'TELEGRAM_BOT',
				action: 'TELEGRAM_DATABASE_BACKUP_CREATE',
				description: 'Backup базы данных поставлен в очередь',
				entityType: 'scheduled_job',
				entityId: result.jobId,
				entityLabel: 'Backup PostgreSQL',
				metadata: {
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
	@Auth(Role.ADMIN)
	@Get('admin/database-backup/jobs/active')
	getLatestActiveManualDatabaseBackup(@CurrentUser('id') adminId: string) {
		return this.scheduledTasksService.getLatestActiveManualDatabaseBackup(
			adminId
		);
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Get('admin/database-backup/jobs/:jobId')
	async getDatabaseBackupJob(
		@Param('jobId', new ParseUUIDPipe()) jobId: string,
		@CurrentUser('id') adminId: string
	) {
		const job = await this.scheduledTasksService.getDatabaseBackupJob(
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
	@Post('webhook')
	handleWebhook(
		@Body() update: TelegramInfoBotWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegramBotService.handleWebhook(update, secret);
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
