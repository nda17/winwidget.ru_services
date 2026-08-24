import { ConfigService } from '@nestjs/config';
import {
	TelegramApiError,
	TelegramInfoTransportService
} from './telegram-info-transport.service';

describe('Notification Delivery TelegramInfoTransportService', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	const createService = (
		apiBaseUrl: string | undefined,
		mode = 'production'
	) =>
		new TelegramInfoTransportService(
			new ConfigService({
				MODE: mode,
				TELEGRAM_INFO_BOT_TOKEN: 'bot-token',
				...(apiBaseUrl ? { TELEGRAM_API_BASE_URL: apiBaseUrl } : {})
			})
		);

	it('routes delivery through the pinned HTTPS reverse proxy', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await createService(
			'https://tg.winwidget.ru/telegram-api'
		).sendMessage('123', 'test');

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://tg.winwidget.ru/telegram-api/botbot-token/sendMessage'
		);
	});

	it.each([
		undefined,
		'https://api.telegram.org',
		'https://api.telegram.org:8443',
		'https://example.com',
		'https://tg.winwidget.ru/telegram-api/',
		'https://tg.winwidget.ru/telegram-api?target=other',
		'https://tg.winwidget.ru/telegram-api#fragment'
	])('rejects an untrusted production endpoint: %s', async apiBaseUrl => {
		await expect(
			createService(apiBaseUrl).sendMessage('123', 'test')
		).rejects.toMatchObject<Partial<TelegramApiError>>({
			code: 'TELEGRAM_CONFIGURATION_INVALID'
		});
	});

	it('keeps loopback HTTP available only for isolated tests', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await createService('http://127.0.0.1:12345', 'test').sendMessage(
			'123',
			'test'
		);

		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://127.0.0.1:12345/botbot-token/sendMessage'
		);
	});
});
