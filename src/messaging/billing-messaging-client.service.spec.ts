import { BillingMessagingClientService } from './billing-messaging-client.service';
import type { ConfigService } from '@nestjs/config';

describe('BillingMessagingClientService', () => {
	const token = 'billing-internal-token-at-least-32-characters';
	const originalFetch = global.fetch;

	const createService = () =>
		new BillingMessagingClientService({
			get: jest.fn((key: string) => {
				if (key === 'BILLING_INTERNAL_BASE_URL') {
					return 'http://127.0.0.1:4800';
				}
				if (key === 'BILLING_INTERNAL_TOKEN') return token;
				return undefined;
			})
		} as unknown as ConfigService);

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('requests the strict Billing overview through the loopback boundary', async () => {
		const body = {
			schemaVersion: 1,
			generatedAt: '2026-08-11T00:00:00.000Z',
			outbox: { PENDING: 1, PROCESSING: 2, PUBLISHED: 3 },
			oldestPendingAt: '2026-08-11T00:00:00.000Z',
			unresolvedFailures: 4,
			retryingFailures: 5,
			deliveredLast24Hours: 6
		};
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue(body)
		});

		await expect(createService().getOverview()).resolves.toEqual(body);
		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4800/internal/v1/billing/messaging/overview',
			expect.objectContaining({
				redirect: 'error',
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token
				})
			})
		);
	});

	it('preserves server pagination and public status filters', async () => {
		const body = {
			schemaVersion: 1,
			items: [],
			total: 0,
			page: 1,
			limit: 40,
			totalPages: 1
		};
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue(body)
		});

		await createService().getFailures(1, 40, {
			consumer: 'auto-renewal-charge',
			status: 'CLOSED'
		});

		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4800/internal/v1/billing/messaging/failures?page=1&limit=40&consumer=auto-renewal-charge&status=CLOSED',
			expect.any(Object)
		);
	});

	it('accepts the exact expanded Billing failure classification evidence', async () => {
		const item = {
			id: '22222222-2222-4222-8222-222222222222',
			eventId: '11111111-1111-4111-8111-111111111111',
			consumer: 'auto-renewal-charge',
			routingKey: 'payment.auto-renewal.charge.requested.v1',
			errorCode: 'PROVIDER_TIMEOUT',
			errorSafe: 'Provider request timed out',
			attempt: 3,
			status: 'OPEN',
			category: 'TRANSIENT',
			normalizedCode: 'PROVIDER_TIMEOUT',
			safeReason: 'Provider request timed out',
			httpStatus: 504,
			providerCode: null,
			retryable: true,
			classificationVersion: 1,
			firstFailedAt: '2026-08-11T00:00:00.000Z',
			failedAt: '2026-08-11T00:01:00.000Z',
			retryingAt: null,
			resolvedAt: null,
			resolution: null,
			resolutionComment: null,
			createdAt: '2026-08-11T00:00:00.000Z',
			updatedAt: '2026-08-11T00:01:00.000Z'
		};
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				items: [item],
				total: 1,
				page: 1,
				limit: 20,
				totalPages: 1
			})
		});

		await expect(createService().getFailures(1, 20, {})).resolves.toEqual(
			expect.objectContaining({ items: [item] })
		);
	});

	it('rejects a response that drifts from the exact failure UUID contract', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({
				schemaVersion: 1,
				items: [
					{
						id: 'not-a-uuid',
						eventId: '11111111-1111-4111-8111-111111111111',
						consumer: 'auto-renewal-charge',
						routingKey: 'payment.auto-renewal.charge.requested.v1',
						errorCode: null,
						errorSafe: null,
						attempt: 1,
						status: 'OPEN',
						category: null,
						normalizedCode: null,
						safeReason: null,
						httpStatus: null,
						providerCode: null,
						retryable: null,
						classificationVersion: null,
						firstFailedAt: null,
						failedAt: '2026-08-11T00:00:00.000Z',
						retryingAt: null,
						resolvedAt: null,
						resolution: null,
						resolutionComment: null,
						createdAt: '2026-08-11T00:00:00.000Z',
						updatedAt: '2026-08-11T00:00:00.000Z'
					}
				],
				total: 1,
				page: 1,
				limit: 20,
				totalPages: 1
			})
		});

		await expect(createService().getFailures(1, 20, {})).rejects.toThrow(
			'Billing вернул некорректный messaging-ответ'
		);
	});
});
