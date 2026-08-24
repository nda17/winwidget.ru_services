import { PlatformMessagingClientService } from '@/messaging/platform-messaging-client.service';
import { BadGatewayException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const TOKEN = 'platform-core-monitor-token-at-least-32-characters';
const NOW = '2026-08-24T12:00:00.000Z';

const config = (values: Record<string, string | undefined> = {}) =>
	({
		get: jest.fn((key: string) => {
			const defaults: Record<string, string> = {
				PLATFORM_INTERNAL_BASE_URL: 'http://127.0.0.1:5000',
				PLATFORM_CORE_TOKEN: TOKEN,
				PLATFORM_INTERNAL_TIMEOUT_MS: '5000'
			};
			return key in values ? values[key] : defaults[key];
		})
	}) as unknown as ConfigService;

const overview = () => ({
	schemaVersion: 1,
	generatedAt: NOW,
	outbox: { PENDING: 1, PROCESSING: 0, PUBLISHED: 4 },
	oldestPendingAt: '2026-08-24T11:59:00.000Z',
	operational: { dueOutbox: 1, staleOutbox: 0 },
	heartbeats: [
		{
			service: 'platform-api',
			status: 'ok',
			activeInstances: 1,
			lastSeenAt: NOW,
			revision: 'a'.repeat(40)
		},
		{
			service: 'platform-outbox-publisher',
			status: 'down',
			activeInstances: 0,
			lastSeenAt: null,
			revision: null
		}
	]
});

describe('PlatformMessagingClientService', () => {
	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(new Date(NOW));
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('uses the exact scoped loopback boundary and validates the response', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(overview()), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);

		await expect(
			new PlatformMessagingClientService(config()).getOverview()
		).resolves.toEqual(overview());
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'http://127.0.0.1:5000/internal/v1/platform/messaging/overview'
		);
		expect(init).toEqual(
			expect.objectContaining({
				redirect: 'error',
				headers: expect.objectContaining({
					Accept: 'application/json',
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('rejects extra fields and stale generatedAt fail-closed', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...overview(),
					generatedAt: '2026-08-24T11:00:00.000Z',
					extra: true
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			)
		);

		await expect(
			new PlatformMessagingClientService(config()).getOverview()
		).rejects.toBeInstanceOf(BadGatewayException);
	});

	it.each([
		['PLATFORM_INTERNAL_BASE_URL', 'https://platform.example.com'],
		['PLATFORM_INTERNAL_BASE_URL', 'http://127.0.0.1:5000/path'],
		['PLATFORM_CORE_TOKEN', 'change_me'],
		[
			'PLATFORM_CORE_TOKEN',
			'change_me_platform_core_token_at_least_32_chars'
		],
		['PLATFORM_CORE_TOKEN', 'ci_platform_core_token_at_least_32_chars'],
		['PLATFORM_INTERNAL_TIMEOUT_MS', '100']
	])('rejects insecure %s=%s at startup', (key, value) => {
		expect(
			() => new PlatformMessagingClientService(config({ [key]: value }))
		).toThrow();
	});
});
