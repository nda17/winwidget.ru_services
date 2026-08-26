import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService', () => {
	it('returns partial alerts and an integration warning when one owner is unavailable', async () => {
		const prisma = {
			operationalAlert: { findMany: jest.fn().mockResolvedValue([]) }
		};
		const federation = {
			getBillingAlerts: jest.fn().mockRejectedValue(new Error('down')),
			getWidgetsAlerts: jest.fn().mockResolvedValue([]),
			getMessagingOverviews: jest.fn().mockResolvedValue([
				{ source: 'billing', value: null, error: 'down' },
				{ source: 'widgets', value: {}, error: null }
			]),
			getIdentitySnapshots: jest.fn()
		};
		const service = new AdminAlertsService(
			prisma as never,
			federation as never
		);

		const result = await service.getAll(1, 20, {});

		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'INTEGRATION_PROBLEM',
					severity: 'HIGH',
					referenceId: 'billing-admin-alerts'
				}),
				expect.objectContaining({
					referenceId: 'billing-messaging'
				})
			])
		);
		expect(result.total).toBe(2);
	});
});
