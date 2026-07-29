import type { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException } from '@nestjs/common';

describe('TelegramBotService webhook URLs', () => {
	const originalMode = process.env.MODE;
	const originalWebhookHost = process.env.TELEGRAM_WEBHOOK_HOST;

	afterEach(() => {
		if (originalMode === undefined) delete process.env.MODE;
		else process.env.MODE = originalMode;

		if (originalWebhookHost === undefined)
			delete process.env.TELEGRAM_WEBHOOK_HOST;
		else process.env.TELEGRAM_WEBHOOK_HOST = originalWebhookHost;
	});

	it('uses the v1 API prefix for every generated webhook URL', () => {
		process.env.MODE = 'production';
		process.env.TELEGRAM_WEBHOOK_HOST = 'https://hooks.example.test/';
		const service = new TelegramBotService({} as PrismaService);

		expect(service.getWebhookHealth().expectedWebhooks).toEqual({
			info: 'https://hooks.example.test/api/v1/telegram-bot/webhook',
			auth: 'https://hooks.example.test/api/v1/telegram-auth/webhook',
			support:
				'https://hooks.example.test/api/v1/telegram-bot/support-webhook'
		});
	});

	it('derives the Notification Delivery backup time across midnight', () => {
		const service = new TelegramBotService({} as PrismaService);

		expect((service as any).addMinutesToTime('23:55', 15)).toBe('00:10');
	});

	it('keeps the summary away from both backup times across midnight', () => {
		const service = new TelegramBotService({} as PrismaService);

		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:08', '23:55')
		).toThrow(BadRequestException);
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:20', '23:55')
		).not.toThrow();
	});
});
