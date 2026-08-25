import type { SupportConfigService } from '../config/support-config.service';
import {
	SupportTelegramError,
	SupportTelegramTransport
} from './support-telegram.transport';

const config = {
	telegramApiBaseUrl: 'https://tg.winwidget.ru/telegram-api',
	botToken: `123456:${'A'.repeat(32)}`,
	botUsername: 'WinWidgetSupportBot',
	webhookPublicUrl:
		'https://tg.winwidget.ru/api/v1/telegram-bot/support-webhook',
	webhookSecret: 'w'.repeat(48)
} as SupportConfigService;

describe('SupportTelegramTransport', () => {
	afterEach(() => jest.restoreAllMocks());

	it('sends every Telegram call through the canonical TLS bridge base', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({ ok: true, result: { message_id: 7 } }),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			)
		);
		const transport = new SupportTelegramTransport(config);

		await expect(transport.sendMessage('42', 'hello')).resolves.toEqual({
			messageId: 7
		});
		expect(fetchMock.mock.calls[0][0]).toBe(
			`${config.telegramApiBaseUrl}/bot${config.botToken}/sendMessage`
		);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			redirect: 'error'
		});
	});

	it('sanitizes transport failures without embedding the bot credential', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockRejectedValue(new Error('socket failed'));
		const transport = new SupportTelegramTransport(config);

		await expect(transport.getMe()).rejects.toEqual(
			expect.objectContaining({
				name: 'SupportTelegramError',
				message: 'Telegram transport request failed',
				retryable: true
			})
		);
		try {
			await transport.getMe();
		} catch (error) {
			expect(error).toBeInstanceOf(SupportTelegramError);
			expect((error as Error).message).not.toContain(config.botToken);
		}
	});
});
