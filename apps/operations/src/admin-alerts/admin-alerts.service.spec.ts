import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService', () => {
	it('accepts receipt recovery alerts from Billing', async () => {
		const prisma = {
			operationalAlert: { findMany: jest.fn().mockResolvedValue([]) }
		};
		const federation = {
			getBillingAlerts: jest.fn().mockResolvedValue(
				[
					'PAYMENT_RECEIPT_CANCELLED',
					'PAYMENT_RECEIPT_SYNC_FAILED',
					'PAYMENT_RECEIPT_STALE'
				].map((type, index) => ({
					type,
					severity: 'HIGH',
					referenceId: `receipt-${index + 1}`,
					ownerId: 'user-1',
					title: 'Чек требует внимания',
					message: 'Требуется ручная проверка',
					alertAt: `2026-08-27T1${index}:00:00.000Z`
				}))
			),
			getWidgetsAlerts: jest.fn().mockResolvedValue([]),
			getMessagingOverviews: jest.fn().mockResolvedValue([]),
			getIdentitySnapshots: jest
				.fn()
				.mockResolvedValue([
					{ id: 'user-1', name: 'Иван', email: 'user@example.test' }
				])
		};
		const service = new AdminAlertsService(
			prisma as never,
			federation as never
		);

		await expect(service.getAll(1, 20, {})).resolves.toMatchObject({
			total: 3,
			items: [
				{
					type: 'PAYMENT_RECEIPT_CANCELLED',
					referenceId: 'receipt-1',
					targetUser: {
						id: 'user-1',
						name: 'Иван',
						email: 'user@example.test'
					}
				},
				{
					type: 'PAYMENT_RECEIPT_SYNC_FAILED',
					referenceId: 'receipt-2'
				},
				{
					type: 'PAYMENT_RECEIPT_STALE',
					referenceId: 'receipt-3'
				}
			]
		});
	});

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
