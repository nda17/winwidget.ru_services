import {
	TelegramApiError,
	TelegramInfoTransportService
} from '@/telegram-bot/telegram-info-transport.service';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('TelegramInfoTransportService', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	const createService = (apiBaseUrl?: string, mode = 'test') =>
		new TelegramInfoTransportService({
			get: jest.fn((key: string) => {
				if (key === 'TELEGRAM_INFO_BOT_TOKEN') return 'bot-token';
				if (key === 'TELEGRAM_API_BASE_URL') return apiBaseUrl;
				if (key === 'MODE') return mode;
				return undefined;
			})
		} as unknown as ConfigService);

	it('uses the pinned TLS passthrough endpoint without changing the Telegram host', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await createService(
			'https://api.telegram.org:8443',
			'production'
		).sendMessage('123', 'test');

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://api.telegram.org:8443/botbot-token/sendMessage'
		);
	});

	it.each([undefined, 'https://api.telegram.org'])(
		'rejects a direct Telegram endpoint in production: %s',
		async apiBaseUrl => {
			await expect(
				createService(apiBaseUrl, 'production').sendMessage('123', 'test')
			).rejects.toMatchObject<Partial<TelegramApiError>>({
				code: 'TELEGRAM_CONFIGURATION_INVALID'
			});
		}
	);

	it.each([
		'https://example.com',
		'https://api.telegram.org:9443',
		'https://user:password@api.telegram.org:8443',
		'https://api.telegram.org:8443/path'
	])('rejects an untrusted Telegram API endpoint %s', async apiBaseUrl => {
		await expect(
			createService(apiBaseUrl).sendMessage('123', 'test')
		).rejects.toMatchObject<Partial<TelegramApiError>>({
			code: 'TELEGRAM_CONFIGURATION_INVALID',
			httpStatus: 0,
			description: 'Telegram API base URL is not allowed'
		});
	});

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

	it.each([
		['a matching numeric chat', '-100123'],
		['a configured username chat', '@configured_chat']
	])(
		'returns a validated sanitized receipt for %s',
		async (_case, configuredChatId) => {
			const directory = await mkdtemp(
				join(tmpdir(), 'telegram-document-')
			);
			const filePath = join(directory, 'backup.dump');
			await writeFile(filePath, 'dump');
			const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: jest.fn().mockResolvedValue({
					ok: true,
					result: {
						message_id: 41,
						message_thread_id: 42,
						chat: {
							id: -100123,
							username:
								configuredChatId === '@configured_chat'
									? 'configured_chat'
									: undefined
						},
						document: {
							file_id: 'telegram-file-id',
							file_unique_id: 'telegram-file-unique-id',
							file_size: 4,
							file_name: 'backup.dump'
						}
					}
				})
			} as unknown as Response);

			try {
				await expect(
					createService(
						'https://api.telegram.org:8443',
						'production'
					).sendDocument(configuredChatId, filePath, 'Backup', {
						messageThreadId: 42
					})
				).resolves.toEqual({
					messageId: 41,
					chatId: '-100123',
					messageThreadId: 42,
					fileId: 'telegram-file-id',
					fileUniqueId: 'telegram-file-unique-id'
				});
				expect(fetchMock.mock.calls[0][0]).toBe(
					'https://api.telegram.org:8443/botbot-token/sendDocument'
				);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('rejects a document receipt sent to another numeric chat', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'telegram-document-'));
		const filePath = join(directory, 'backup.dump');
		await writeFile(filePath, 'dump');
		jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				ok: true,
				result: {
					message_id: 41,
					message_thread_id: 42,
					chat: { id: -100124 },
					document: {
						file_id: 'telegram-file-id',
						file_unique_id: 'telegram-file-unique-id',
						file_size: 4
					}
				}
			})
		} as unknown as Response);

		try {
			await expect(
				createService().sendDocument('-100123', filePath, 'Backup', {
					messageThreadId: 42
				})
			).rejects.toMatchObject<Partial<TelegramApiError>>({
				code: 'TELEGRAM_INVALID_RESPONSE',
				httpStatus: 502,
				description:
					'Telegram sendDocument returned an invalid document receipt'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a document receipt sent to another username chat', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'telegram-document-'));
		const filePath = join(directory, 'backup.dump');
		await writeFile(filePath, 'dump');
		jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				ok: true,
				result: {
					message_id: 41,
					message_thread_id: 42,
					chat: {
						id: -100123,
						username: 'another_chat'
					},
					document: {
						file_id: 'telegram-file-id',
						file_unique_id: 'telegram-file-unique-id',
						file_size: 4
					}
				}
			})
		} as unknown as Response);

		try {
			await expect(
				createService().sendDocument(
					'@configured_chat',
					filePath,
					'Backup',
					{
						messageThreadId: 42
					}
				)
			).rejects.toMatchObject<Partial<TelegramApiError>>({
				code: 'TELEGRAM_INVALID_RESPONSE',
				httpStatus: 502,
				description:
					'Telegram sendDocument returned an invalid document receipt'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a document receipt with mismatched artifact metadata', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'telegram-document-'));
		const filePath = join(directory, 'backup.dump');
		await writeFile(filePath, 'dump');
		jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				ok: true,
				result: {
					message_id: 41,
					message_thread_id: 42,
					chat: { id: -100123 },
					document: {
						file_id: 'telegram-file-id',
						file_unique_id: 'telegram-file-unique-id',
						file_size: 5
					}
				}
			})
		} as unknown as Response);

		try {
			await expect(
				createService().sendDocument('-100123', filePath, 'Backup', {
					messageThreadId: 42
				})
			).rejects.toMatchObject<Partial<TelegramApiError>>({
				code: 'TELEGRAM_INVALID_RESPONSE',
				httpStatus: 502,
				description:
					'Telegram sendDocument returned an invalid document receipt'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
