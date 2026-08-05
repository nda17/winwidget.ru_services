import {
	WidgetsDeliveryFailuresClientService,
	WidgetsDeliveryInternalApiError
} from '@/messaging/widgets-delivery-failures-client.service';
import { BadGatewayException } from '@nestjs/common';

describe('WidgetsDeliveryFailuresClientService', () => {
	const token = 'w'.repeat(48);
	const previousEnv = {
		baseUrl: process.env.WIDGETS_INTERNAL_BASE_URL,
		token: process.env.WIDGETS_INTERNAL_TOKEN,
		timeout: process.env.WIDGETS_INTERNAL_TIMEOUT_MS
	};
	const failure = {
		id: '22222222-2222-4222-8222-222222222222',
		eventId: '11111111-1111-4111-8111-111111111111',
		integration: 'webhook',
		attempts: 2,
		lastError: 'timeout',
		category: 'TRANSIENT',
		normalizedCode: 'TIMEOUT',
		safeReason: 'Provider request timed out',
		httpStatus: null,
		providerCode: null,
		retryable: true,
		failedAt: '2026-08-05T12:00:00.000Z',
		retryingAt: null,
		resolvedAt: null,
		resolution: null,
		resolutionComment: null,
		source: 'widget',
		entity: { id: 'widget-1', name: 'Колесо' },
		lead: {
			id: 'lead-1',
			contact: null,
			phone: null,
			email: 'owner@example.com',
			url: null,
			createdAt: '2026-08-05T11:59:00.000Z'
		}
	};
	const overview = {
		generatedAt: '2026-08-05T12:00:00.000Z',
		outbox: { PENDING: 1, PUBLISHING: 0, PUBLISHED: 8, FAILED: 0 },
		oldestPendingAt: '2026-08-05T11:59:00.000Z',
		operational: {
			staleOutbox: 0,
			dueOutbox: 1,
			unresolvedFailuresByCategory: {
				TRANSIENT: 1,
				RATE_LIMIT: 0,
				PERMANENT: 0,
				AUTH_CONFIGURATION: 0,
				UNCLASSIFIED: 0
			}
		},
		unresolvedFailures: 1,
		retryingFailures: 0,
		deliveredLast24Hours: 8,
		heartbeats: [
			{
				service: 'widgets-api',
				status: 'ok',
				activeInstances: 1,
				lastSeenAt: '2026-08-05T11:59:55.000Z'
			},
			{
				service: 'widgets-worker',
				status: 'ok',
				activeInstances: 1,
				lastSeenAt: '2026-08-05T11:59:55.000Z',
				lastSuccessfulConsumeAt: '2026-08-05T11:59:50.000Z'
			},
			{
				service: 'widgets-publisher',
				status: 'ok',
				activeInstances: 1,
				lastSeenAt: '2026-08-05T11:59:55.000Z',
				lastSuccessfulPublishAt: '2026-08-05T11:59:45.000Z'
			}
		]
	};

	beforeEach(() => {
		process.env.WIDGETS_INTERNAL_BASE_URL = 'http://127.0.0.1:4700';
		process.env.WIDGETS_INTERNAL_TOKEN = token;
		process.env.WIDGETS_INTERNAL_TIMEOUT_MS = '5000';
	});

	afterEach(() => {
		jest.restoreAllMocks();
		restoreEnv('WIDGETS_INTERNAL_BASE_URL', previousEnv.baseUrl);
		restoreEnv('WIDGETS_INTERNAL_TOKEN', previousEnv.token);
		restoreEnv('WIDGETS_INTERNAL_TIMEOUT_MS', previousEnv.timeout);
	});

	it('strictly validates the service-owned messaging overview', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(overview), { status: 200 })
			);

		await expect(
			new WidgetsDeliveryFailuresClientService().getOverview()
		).resolves.toEqual(overview);
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			'http://127.0.0.1:4700/api/v1/internal/v1/widgets/messaging-overview'
		);

		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					...overview,
					heartbeats: overview.heartbeats.slice(0, 2)
				}),
				{ status: 200 }
			)
		);
		await expect(
			new WidgetsDeliveryFailuresClientService().getOverview()
		).rejects.toBeInstanceOf(BadGatewayException);
	});

	it('requests the Widgets-owned failure page with server-side filters', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [failure],
					total: 1,
					page: 1,
					limit: 40,
					totalPages: 1
				}),
				{ status: 200 }
			)
		);

		await expect(
			new WidgetsDeliveryFailuresClientService().getFailures(1, 40, {
				integration: ' webhook ',
				category: 'TRANSIENT',
				status: 'FAILED'
			})
		).resolves.toEqual(
			expect.objectContaining({ items: [failure], total: 1 })
		);

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(
			'http://127.0.0.1:4700/api/v1/internal/v1/widgets/delivery-failures?page=1&limit=40&integration=webhook&category=TRANSIENT&status=FAILED'
		);
		expect(init).toEqual(
			expect.objectContaining({
				redirect: 'error',
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token,
					'x-request-id': expect.stringMatching(/^[0-9a-f-]{36}$/i),
					'x-correlation-id': expect.stringMatching(/^[0-9a-f-]{36}$/i)
				})
			})
		);
	});

	it('forwards a Core CUID actor and preserves retry/close response shapes', async () => {
		const actorId = 'cm0abc1230000qwertyuiopas';
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: failure.id,
						eventId: failure.eventId,
						integration: 'webhook',
						retryingAt: '2026-08-05T12:01:00.000Z',
						manualRetryCount: 3
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: failure.id,
						eventId: failure.eventId,
						integration: 'webhook',
						resolvedAt: '2026-08-05T12:02:00.000Z',
						resolution: 'CLOSED_NO_RETRY',
						resolutionComment: 'Проверено вручную'
					}),
					{ status: 200 }
				)
			);
		const service = new WidgetsDeliveryFailuresClientService();

		await expect(
			service.retryFailure(failure.id, actorId)
		).resolves.toEqual({
			id: failure.id,
			eventId: failure.eventId,
			integration: 'webhook',
			retryingAt: '2026-08-05T12:01:00.000Z'
		});
		expect(fetchMock.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ actorId })
			})
		);
		await expect(
			service.closeFailure(failure.id, actorId, 'Проверено вручную')
		).resolves.toEqual({
			id: failure.id,
			eventId: failure.eventId,
			integration: 'webhook',
			resolvedAt: '2026-08-05T12:02:00.000Z',
			resolution: 'CLOSED_NO_RETRY',
			resolutionComment: 'Проверено вручную'
		});
		expect(fetchMock.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					actorId,
					comment: 'Проверено вручную'
				})
			})
		);
	});

	it('rejects malformed provider responses and preserves a typed 404', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [{ ...failure, integration: 'email' }],
						total: 1,
						page: 1,
						limit: 20,
						totalPages: 1
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: 'Ошибка не найдена' }), {
					status: 404
				})
			);
		const service = new WidgetsDeliveryFailuresClientService();

		await expect(service.getFailures(1, 20, {})).rejects.toBeInstanceOf(
			BadGatewayException
		);
		await expect(
			service.retryFailure(failure.id, 'cm0abc1230000qwertyuiopas')
		).rejects.toEqual(
			expect.objectContaining<Partial<WidgetsDeliveryInternalApiError>>({
				statusCode: 404,
				message: 'Ошибка не найдена'
			})
		);
	});

	it('rejects non-loopback endpoints before sending credentials', () => {
		process.env.WIDGETS_INTERNAL_BASE_URL = 'https://widgets.example.com';
		expect(() => new WidgetsDeliveryFailuresClientService()).toThrow(
			'WIDGETS_INTERNAL_BASE_URL must be an exact loopback HTTP origin'
		);
	});
});

const restoreEnv = (key: string, value: string | undefined): void => {
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
};
