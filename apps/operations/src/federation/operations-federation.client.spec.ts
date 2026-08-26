import { ConfigService } from '@nestjs/config';
import { OperationsFederationClient } from './operations-federation.client';

const TOKEN = 'operations-internal-token-is-long-enough';

describe('OperationsFederationClient', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('uses the clean Billing Operations route and production default port', async () => {
		global.fetch = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 1,
					total: 0,
					counts: {},
					items: []
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		) as jest.Mock;
		const client = new OperationsFederationClient(
			new ConfigService({ BILLING_OPERATIONS_TOKEN: TOKEN })
		);

		await expect(client.getBillingAlerts()).resolves.toEqual([]);

		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4800/internal/v1/operations/billing/admin-alerts',
			expect.objectContaining({
				headers: expect.objectContaining({
					'x-winwidget-service': 'operations',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('uses the clean Widgets Operations route', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ items: [] }), { status: 200 })
			) as jest.Mock;
		const client = new OperationsFederationClient(
			new ConfigService({ WIDGETS_OPERATIONS_TOKEN: TOKEN })
		);

		await expect(client.getWidgetsAlerts()).resolves.toEqual([]);

		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:4700/api/v1/internal/v1/operations/widgets/admin-alerts',
			expect.objectContaining({ method: 'POST' })
		);
	});

	it('requires Notification Delivery configuration to be an exact origin', async () => {
		const client = new OperationsFederationClient(
			new ConfigService({
				NOTIFICATION_DELIVERY_INTERNAL_URL:
					'http://127.0.0.1:4401/internal/notification-delivery',
				NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: TOKEN
			})
		);

		const [result] = await client.getMessagingOverviews();

		expect(result.source).toBe('notificationDelivery');
		expect(result.error).toContain(
			'NOTIFICATION_DELIVERY_INTERNAL_URL must be an exact private HTTP origin'
		);
	});
});
