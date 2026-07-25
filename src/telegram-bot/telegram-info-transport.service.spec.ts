import {
	TelegramApiError,
	TelegramInfoTransportService
} from '@/telegram-bot/telegram-info-transport.service';
import type { ConfigService } from '@nestjs/config';

describe('TelegramInfoTransportService', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	const createService = () =>
		new TelegramInfoTransportService({
			get: jest.fn().mockReturnValue('bot-token')
		} as unknown as ConfigService);

	it('returns structured Telegram rate-limit details', async () => {
		jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 429,
			json: jest.fn().mockResolvedValue({
				ok: false,
				error_code: 429,
				description: 'Too Many Requests',
				parameters: { retry_after: 17 }
			})
		} as unknown as Response);

		await expect(
			createService().sendMessage('123', 'test')
		).rejects.toMatchObject<Partial<TelegramApiError>>({
			httpStatus: 429,
			errorCode: 429,
			description: 'Too Many Requests',
			retryAfterMs: 17_000
		});
	});

	it('omits a Telegram topic when messageThreadId is not provided', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await createService().sendMessage('123', 'test', {
			parseMode: null
		});

		const request = fetchMock.mock.calls[0][1] as RequestInit;
		const body = JSON.parse(request.body as string);
		expect(body).toEqual({
			chat_id: '123',
			text: 'test',
			disable_web_page_preview: true
		});
	});

	it('normalizes network failures without exposing the bot URL', async () => {
		jest
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(
				new TypeError(
					'fetch failed for https://api.telegram.org/botsecret/sendMessage'
				)
			);

		const result = createService().sendMessage('123', 'test');

		await expect(result).rejects.toMatchObject<Partial<TelegramApiError>>({
			code: 'TELEGRAM_TRANSPORT_ERROR',
			httpStatus: 0,
			description: 'Telegram transport request failed'
		});
		await expect(result).rejects.not.toThrow(/botsecret/);
	});
});
