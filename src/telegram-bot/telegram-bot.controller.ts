import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	TelegramBotService,
	type TelegramInfoBotWebhookUpdate
} from '@/telegram-bot/telegram-bot.service';
import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Patch,
	Post,
	Req,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

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
			description: 'Обновлены настройки Info_bot',
			entityType: 'telegram_bot_settings',
			entityId: 'singleton',
			entityLabel: 'Info_bot',
			metadata: {
				dailySummaryEnabled: settings.dailySummaryEnabled,
				dailySummaryChatIdConfigured: Boolean(
					settings.dailySummaryChatId.trim()
				),
				telegramBotTokenConfigured: settings.telegramBotTokenConfigured
			},
			request
		});

		return settings;
	}

	@HttpCode(200)
	@Post('webhook')
	handleWebhook(
		@Body() update: TelegramInfoBotWebhookUpdate,
		@Headers('x-telegram-bot-api-secret-token') secret?: string
	) {
		return this.telegramBotService.handleWebhook(update, secret);
	}
}
