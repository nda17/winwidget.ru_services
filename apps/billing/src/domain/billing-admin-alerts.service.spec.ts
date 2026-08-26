import { BillingAdminAlertsService } from './billing-admin-alerts.service';

describe('BillingAdminAlertsService', () => {
	it('builds alert details and counts from Billing-owned tables', async () => {
		const queryRaw = jest.fn().mockResolvedValue([
			{
				type: 'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
				severity: 'HIGH',
				referenceId: 'payment-1',
				ownerId: 'user-1',
				title: 'Оплата прошла, доступ не активен',
				message: 'Платёж payment-provider-1 успешен',
				alertAt: new Date('2026-08-24T10:00:00.000Z')
			},
			{
				type: 'PENDING_PAYMENT',
				severity: 'MEDIUM',
				referenceId: 'payment-2',
				ownerId: 'user-2',
				title: 'Платёж долго в pending',
				message: 'Платёж payment-provider-2 ожидает',
				alertAt: new Date('2026-08-24T11:00:00.000Z')
			}
		]);
		const service = new BillingAdminAlertsService({
			$queryRaw: queryRaw
		} as never);

		await expect(service.getAlerts()).resolves.toEqual({
			schemaVersion: 1,
			total: 2,
			counts: {
				byType: {
					EXPIRED_ACTIVE_SUBSCRIPTION: 0,
					SUBSCRIPTION_EXPIRES_SOON: 0,
					PENDING_PAYMENT: 1,
					SUCCEEDED_PAYMENT_WITHOUT_ACCESS: 1,
					MULTIPLE_PENDING_PAYMENTS: 0,
					AFFILIATE_REWARD_STALE: 0,
					AFFILIATE_REWARD_PAYMENT_CANCELLED: 0
				},
				bySeverity: { HIGH: 1, MEDIUM: 1, LOW: 0 }
			},
			items: [
				{
					type: 'SUCCEEDED_PAYMENT_WITHOUT_ACCESS',
					severity: 'HIGH',
					referenceId: 'payment-1',
					ownerId: 'user-1',
					title: 'Оплата прошла, доступ не активен',
					message: 'Платёж payment-provider-1 успешен',
					alertAt: '2026-08-24T10:00:00.000Z'
				},
				{
					type: 'PENDING_PAYMENT',
					severity: 'MEDIUM',
					referenceId: 'payment-2',
					ownerId: 'user-2',
					title: 'Платёж долго в pending',
					message: 'Платёж payment-provider-2 ожидает',
					alertAt: '2026-08-24T11:00:00.000Z'
				}
			]
		});

		const sql = queryRaw.mock.calls[0][0].strings.join(' ');
		expect(sql).toContain('FROM billing.subscriptions');
		expect(sql).toContain('FROM billing.payments');
		expect(sql).toContain('FROM billing.affiliate_referrals');
		expect(sql).toContain("NOW() - INTERVAL '30 minutes'");
		expect(sql).toContain("NOW() + INTERVAL '7 days'");
		expect(sql).toContain("NOW() - INTERVAL '3 days'");
		expect(sql).toContain('HAVING COUNT(*) > 1');
		expect(sql).not.toContain('billing_payment_read_projections');
		expect(sql).not.toContain('billing_subscription_read_projections');
		expect(sql).not.toContain('billing_affiliate_read_projections');
	});
});
