import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
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
			description: 'Обновлены настройки Telegram-бота',
			entityType: 'telegram_bot_settings',
			entityId: 'singleton',
			entityLabel: 'Telegram-бот',
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
}
