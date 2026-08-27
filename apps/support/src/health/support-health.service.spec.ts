import { ServiceUnavailableException } from '@nestjs/common';
import { SupportHealthService } from './support-health.service';

const databaseId = '11111111-1111-4111-8111-111111111111';
const createdAt = new Date('2026-08-27T10:00:00.000Z');
const updatedAt = new Date('2026-08-27T10:01:00.000Z');

function build(
	options: {
		role?: 'api' | 'worker' | 'outbox-publisher';
		workerReady?: boolean;
		publisherReady?: boolean;
		telegramApiProxyIp?: string;
	} = {}
) {
	const role = options.role ?? 'api';
	const apiEnabled = role === 'api';
	const workerEnabled = role === 'worker';
	const outboxPublisherEnabled = role === 'outbox-publisher';
	const service = new SupportHealthService(
		{
			$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
			serviceIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					serviceName: 'support-service',
					databaseId,
					createdAt,
					updatedAt
				})
			}
		} as never,
		{
			role,
			apiEnabled,
			workerEnabled,
			outboxPublisherEnabled,
			rabbitEnabled: workerEnabled || outboxPublisherEnabled
		} as never,
		{
			botToken: outboxPublisherEnabled ? '' : 'configured',
			botUsername: apiEnabled ? 'support_bot' : '',
			webhookSecret: apiEnabled ? 'configured' : '',
			webhookPublicUrl: apiEnabled ? 'https://example.test/webhook' : '',
			telegramApiBaseUrl: outboxPublisherEnabled
				? ''
				: 'https://tg.winwidget.ru/telegram-api',
			telegramApiProxyIp: outboxPublisherEnabled
				? ''
				: (options.telegramApiProxyIp ?? '185.184.122.62')
		} as never,
		{
			isConnected: jest.fn().mockReturnValue(true),
			isTopologyReady: jest.fn().mockReturnValue(true)
		} as never,
		{
			isReady: jest.fn().mockReturnValue(options.workerReady ?? true)
		} as never,
		{
			isReady: jest.fn().mockReturnValue(options.publisherReady ?? true)
		} as never
	);
	return service;
}

describe('SupportHealthService', () => {
	it('reports the current database identity and pinned Telegram route', async () => {
		await expect(build().readiness()).resolves.toEqual({
			status: 'ready',
			service: 'support',
			role: 'api',
			revision: expect.any(String),
			database: {
				serviceName: 'support-service',
				databaseId,
				createdAt: createdAt.toISOString(),
				updatedAt: updatedAt.toISOString()
			},
			telegram: {
				enabled: true,
				apiBaseUrl: 'https://tg.winwidget.ru/telegram-api',
				proxyPinned: true,
				botTokenConfigured: true,
				botUsernameConfigured: true,
				webhookSecretConfigured: true
			}
		});
	});

	it('requires worker readiness without a historical ownership condition', async () => {
		await expect(
			build({ role: 'worker', workerReady: false }).readiness()
		).rejects.toThrow('Support worker is not ready');
	});

	it('fails closed when an enabled role has incomplete Telegram routing', async () => {
		await expect(
			build({ role: 'worker', telegramApiProxyIp: '' }).readiness()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
