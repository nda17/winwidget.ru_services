import {
	NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND,
	NotificationDeliveryClientService,
	NotificationDeliveryInternalApiError
} from '@/messaging/notification-delivery-client.service';
import { messagingContextMiddleware } from '@/messaging/messaging-context';
import { BadGatewayException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

describe('NotificationDeliveryClientService', () => {
	const token = 'n'.repeat(48);
	const overview = {
		generatedAt: '2026-07-27T12:00:00.000Z',
		outbox: {
			PENDING: 0,
			PUBLISHING: 0,
			PUBLISHED: 1,
			FAILED: 0
		},
		oldestPendingAt: null,
		operational: {
			staleOutbox: 0,
			dueOutbox: 0,
			unresolvedFailuresByCategory: {
				TRANSIENT: 0,
				RATE_LIMIT: 0,
				PERMANENT: 0,
				AUTH_CONFIGURATION: 0,
				UNCLASSIFIED: 0
			}
		},
		unresolvedFailures: 0,
		retryingFailures: 0,
		deliveredLast24Hours: 1,
		heartbeat: {
			service: 'notification-delivery-worker',
			status: 'ok',
			activeInstances: 1,
			lastSeenAt: '2026-07-27T12:00:00.000Z'
		}
	};
	const failure = {
		id: '22222222-2222-4222-8222-222222222222',
		eventId: '11111111-1111-4111-8111-111111111111',
		integration: 'email',
		attempts: 1,
		lastError: 'timeout',
		category: 'TRANSIENT',
		normalizedCode: 'TIMEOUT',
		safeReason: 'Provider request timed out',
		httpStatus: null,
		providerCode: null,
		retryable: true,
		failedAt: '2026-07-27T12:00:00.000Z',
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
			createdAt: '2026-07-27T11:59:00.000Z'
		}
	};

	const createService = (
		values: Record<string, string | undefined> = {}
	) =>
		new NotificationDeliveryClientService({
			get: jest.fn(
				(key: string) =>
					values[key] ??
					(key === 'NOTIFICATION_DELIVERY_INTERNAL_TOKEN'
						? token
						: undefined)
			)
		} as unknown as ConfigService);

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('sends the internal token only to the configured loopback endpoint', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(overview), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await createService().getOverview();

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(
			'http://127.0.0.1:4401/internal/notification-delivery/overview'
		);
		expect(init?.headers).toMatchObject({
			'x-winwidget-internal-token': token
		});
		expect(init?.headers).toEqual(
			expect.objectContaining({
				'x-request-id': expect.stringMatching(/^[0-9a-f-]{36}$/i),
				'x-correlation-id': expect.stringMatching(/^[0-9a-f-]{36}$/i)
			})
		);
		expect(init?.redirect).toBe('error');
	});

	it('forwards the active request and correlation IDs to the internal service', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(overview), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		const request = {
			headers: {
				'x-request-id': 'admin-request-123',
				'x-correlation-id': 'admin-correlation-456'
			}
		} as unknown as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;

		await new Promise<void>((resolve, reject) => {
			messagingContextMiddleware(request, response, (() => {
				void createService()
					.getOverview()
					.then(() => resolve(), reject);
			}) as NextFunction);
		});

		expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
			expect.objectContaining({
				'x-request-id': 'admin-request-123',
				'x-correlation-id': 'admin-correlation-456'
			})
		);
	});

	it('rejects a non-loopback internal URL before making a request', () => {
		expect(() =>
			createService({
				NOTIFICATION_DELIVERY_INTERNAL_URL:
					'https://delivery.example.com/internal'
			})
		).toThrow(
			'NOTIFICATION_DELIVERY_INTERNAL_URL must be an exact loopback HTTP URL'
		);
	});

	it('rejects placeholder internal tokens', () => {
		expect(() =>
			createService({
				NOTIFICATION_DELIVERY_INTERNAL_TOKEN: 'XYZXYZXYZ'
			})
		).toThrow(
			'NOTIFICATION_DELIVERY_INTERNAL_TOKEN must contain at least 32 characters'
		);
	});

	it('preserves a typed internal API conflict', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ message: 'Повтор уже выполняется' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			createService().retryFailure(
				'11111111-1111-4111-8111-111111111111',
				'admin-id'
			)
		).rejects.toEqual(
			expect.objectContaining<
				Partial<NotificationDeliveryInternalApiError>
			>({
				statusCode: 409,
				message: 'Повтор уже выполняется'
			})
		);
	});

	it('validates the complete overview response before returning it', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					...overview,
					outbox: { ...overview.outbox, FAILED: '0' }
				}),
				{ status: 200 }
			)
		);

		await expect(createService().getOverview()).rejects.toBeInstanceOf(
			BadGatewayException
		);
	});

	it('validates every failure and the pagination response', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [failure],
						total: 1,
						page: 1,
						limit: 20,
						totalPages: 1
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [{ ...failure, attempts: 0 }],
						total: 1,
						page: 1,
						limit: 20,
						totalPages: 1
					}),
					{ status: 200 }
				)
			);

		await expect(createService().getFailures(1, 20, {})).resolves.toEqual(
			expect.objectContaining({ items: [failure], total: 1 })
		);
		await expect(
			createService().getFailures(1, 20, {})
		).rejects.toBeInstanceOf(BadGatewayException);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('accepts the service-owned Daily Summary delivery failure kind', async () => {
		const dailySummaryFailure = {
			...failure,
			integration: NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND
		};
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [dailySummaryFailure],
					total: 1,
					page: 1,
					limit: 20,
					totalPages: 1
				}),
				{ status: 200 }
			)
		);

		await expect(createService().getFailures(1, 20, {})).resolves.toEqual(
			expect.objectContaining({ items: [dailySummaryFailure], total: 1 })
		);
	});

	it('accepts the exact retry and close response contracts', async () => {
		const retryResult = {
			id: failure.id,
			eventId: failure.eventId,
			integration: 'email',
			retryingAt: '2026-07-27T12:00:00.000Z'
		};
		const closeResult = {
			id: failure.id,
			eventId: failure.eventId,
			integration: 'email',
			resolvedAt: '2026-07-27T12:01:00.000Z',
			resolution: 'CLOSED_NO_RETRY',
			resolutionComment: 'Проверено вручную'
		};
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify(retryResult), { status: 200 })
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(closeResult), { status: 200 })
			);
		const service = createService();

		await expect(
			service.retryFailure(failure.id, 'admin-id')
		).resolves.toEqual(retryResult);
		await expect(
			service.closeFailure(failure.id, 'admin-id', 'Проверено вручную')
		).resolves.toEqual(closeResult);
	});

	it.each([
		{
			label: 'retry',
			response: {
				id: failure.id,
				eventId: failure.eventId,
				integration: 'webhook',
				retryingAt: '2026-07-27T12:00:00.000Z'
			},
			call: (service: NotificationDeliveryClientService) =>
				service.retryFailure(failure.id, 'admin-id')
		},
		{
			label: 'close',
			response: {
				id: failure.id,
				eventId: failure.eventId,
				integration: 'email',
				resolvedAt: 'not-a-date',
				resolution: 'CLOSED_NO_RETRY',
				resolutionComment: 'Закрыто вручную'
			},
			call: (service: NotificationDeliveryClientService) =>
				service.closeFailure(failure.id, 'admin-id', 'Закрыто вручную')
		}
	])(
		'rejects a malformed successful $label response',
		async ({ response, call }) => {
			jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(
					new Response(JSON.stringify(response), { status: 200 })
				);

			await expect(call(createService())).rejects.toBeInstanceOf(
				BadGatewayException
			);
		}
	);
});
