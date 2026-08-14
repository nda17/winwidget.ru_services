import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
	IdentityMessagingClientService,
	IdentityMessagingInternalApiError
} from './identity-messaging-client.service';

const TOKEN = 'core-identity-messaging-token-at-least-32-characters';
const NOW = '2026-08-14T12:00:00.000Z';

const client = (overrides: Record<string, string> = {}) => {
	const values = {
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		IDENTITY_CORE_TOKEN: TOKEN,
		IDENTITY_INTERNAL_TIMEOUT_MS: '5000',
		...overrides
	};
	return new IdentityMessagingClientService({
		get: jest.fn((key: string) => values[key as keyof typeof values])
	} as unknown as ConfigService);
};

describe('IdentityMessagingClientService', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		'http://identity:4900',
		'https://127.0.0.1:4900',
		'http://127.0.0.1:4900/path'
	])('rejects unsafe internal origin %s', value => {
		expect(() => client({ IDENTITY_INTERNAL_BASE_URL: value })).toThrow(
			'exact private loopback'
		);
	});

	it.each([
		'short',
		'change_me',
		'ci_identity_core_token_at_least_32_chars'
	])('rejects weak scoped token %s', value => {
		expect(() => client({ IDENTITY_CORE_TOKEN: value })).toThrow(
			'non-placeholder secret'
		);
	});

	it('uses the Core-scoped credential for exact overview path', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					generatedAt: NOW,
					outbox: { PENDING: 0, PUBLISHING: 0, PUBLISHED: 4, FAILED: 0 },
					oldestPendingAt: null,
					unresolvedFailures: 0,
					retryingFailures: 0,
					deliveredLast24Hours: 2,
					rabbitMqError: null,
					notificationDeliveryError: null,
					widgetsError: null,
					billingError: null,
					heartbeats: [
						{
							service: 'identity-api',
							status: 'ok',
							activeInstances: 1,
							lastSeenAt: NOW
						}
					],
					queues: []
				}),
				{ status: 200 }
			)
		);

		await expect(client().getOverview()).resolves.toMatchObject({
			unresolvedFailures: 0,
			deliveredLast24Hours: 2
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/identity/messaging/overview',
			expect.objectContaining({
				headers: expect.objectContaining({
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('binds filters and actor to list and retry contracts', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [],
						total: 0,
						page: 1,
						limit: 40,
						totalPages: 1
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: 'failure-id',
						eventId: 'event-id',
						integration: 'telegram-destination-unavailable',
						retryingAt: NOW
					}),
					{ status: 200 }
				)
			);

		const service = client();
		await service.getFailures(1, 40, {
			category: 'PERMANENT',
			status: 'FAILED'
		});
		await service.retryFailure('failure-id', 'admin-id');

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'http://127.0.0.1:4900/internal/v1/identity/messaging/failures?page=1&limit=40&consumer=telegram-destination-unavailable&category=PERMANENT&status=FAILED'
		);
		expect(fetchMock.mock.calls[1]?.[1]).toEqual(
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ actorId: 'admin-id' })
			})
		);
	});

	it('maps remote status and invalid schema without leaking response bodies', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ message: 'Ошибка доставки не найдена' }),
					{
						status: 404
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ generatedAt: NOW }), { status: 200 })
			)
			.mockRejectedValueOnce(new Error('offline'));

		await expect(
			client().retryFailure('failure-id', 'admin-id')
		).rejects.toMatchObject({
			statusCode: 404,
			message: 'Ошибка доставки не найдена'
		} satisfies Partial<IdentityMessagingInternalApiError>);
		await expect(client().getOverview()).rejects.toMatchObject({
			response: { message: 'Identity вернул некорректный ответ' }
		});
		await expect(client().getOverview()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
});
