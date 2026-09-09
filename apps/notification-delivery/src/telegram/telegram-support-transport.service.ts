import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import {
	TelegramApiError,
	TelegramInfoTransportService
} from './telegram-info-transport.service';

// Outbound-only transport. Webhook ownership and the existing bridge stay in Support.
@Injectable()
export class TelegramSupportTransportService extends TelegramInfoTransportService {
	constructor(config: ConfigService) {
		super(config);
	}
	async sendMessage(
		chatId: string,
		text: string,
		options: Parameters<
			TelegramInfoTransportService['sendMessage']
		>[2] = {}
	): Promise<void> {
		if (
			!/^-[1-9][0-9]{0,18}$/.test(chatId) ||
			!Number.isSafeInteger(options.messageThreadId) ||
			Number(options.messageThreadId) < 1 ||
			Number(options.messageThreadId) > 2147483647
		)
			throw new TelegramApiError({
				httpStatus: 400,
				code: 'TELEGRAM_CONFIGURATION_INVALID',
				description: 'Support Telegram group and topic are required'
			});
		await super.sendMessage(chatId, text, options);
	}
	protected getToken(): string {
		const token = this.configService
			.get<string>('TELEGRAM_SUPPORT_BOT_TOKEN')
			?.trim();
		if (!token || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token)) {
			throw new TelegramApiError({
				httpStatus: 401,
				description: 'Support Telegram bot token is not configured'
			});
		}
		return token;
	}
}
