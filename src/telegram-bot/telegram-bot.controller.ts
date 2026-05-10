import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	DATABASE_BACKUP_MAX_FILE_SIZE_BYTES,
	TelegramBotService,
	type TelegramWebhookBot,
	type TelegramInfoBotWebhookUpdate,
	type TelegramSupportBotWebhookUpdate
} from '@/telegram-bot/telegram-bot.service';
import {
	Body,
	Controller,
	ForbiddenException,
	Get,
	Headers,
	HttpCode,
	Param,
	Patch,
	Post,
	Req,
	UploadedFile,
	UseInterceptors,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { IsString } from 'class-validator';
import { Request } from 'express';

class RestoreDatabaseBackupDto {
	@IsString()
	confirmation: string;
}

@Controller('telegram-bot')
export class TelegramBotController {
	constructor(
		private readonly telegramBotService: TelegramBotService,
		private readonly adminEventLogService: AdminEventLogService
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

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Post('admin/database-backup/send')
	async sendDatabaseBackup(
		@CurrentUser('id') adminId: string,
		@Req() request: Request
	) {
		const result =
			await this.telegramBotService.createAndSendDatabaseBackup('manual');

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_DATABASE_BACKUP_CREATE',
			description: 'Создан и отправлен backup базы данных',
			entityType: 'database_backup',
			entityId: result.fileName,
			entityLabel: result.fileName,
			metadata: {
				fileName: result.fileName,
				fileSize: result.fileSize,
				createdAt: result.createdAt
			},
			request
		});

		return result;
	}

	@HttpCode(200)
	@Auth(Role.DEV)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	@Post('admin/database-backup/restore')
	@UseInterceptors(
		FileInterceptor('file', {
			limits: { fileSize: DATABASE_BACKUP_MAX_FILE_SIZE_BYTES }
		})
	)
	async restoreDatabaseBackup(
		@UploadedFile() file: Express.Multer.File | undefined,
		@Body() dto: RestoreDatabaseBackupDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[],
		@Req() request: Request
	) {
		if (!adminRights?.includes(Role.ADMIN)) {
			throw new ForbiddenException(
				'Восстановление БД доступно только админу с ролью DEV'
			);
		}

		await this.adminEventLogService.record({
			adminId,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_DATABASE_RESTORE',
			description: 'Запущено восстановление базы данных из backup',
			entityType: 'database_backup',
			entityId: file?.originalname ?? 'unknown',
			entityLabel: file?.originalname ?? 'unknown',
			metadata: {
				fileName: file?.originalname ?? null,
				fileSize: file?.size ?? null
			},
			request
		});

		return this.telegramBotService.restoreDatabaseBackup(
			file,
			dto.confirmation
		);
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
