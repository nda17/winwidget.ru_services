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
			},
			{
				type: 'PAYMENT_RECEIPT_CANCELLED',
				severity: 'HIGH',
				referenceId: 'receipt-1',
				ownerId: 'user-3',
				title: 'Чек отменён провайдером',
				message: 'Чек provider-receipt-1 отменён',
				alertAt: new Date('2026-08-24T12:00:00.000Z')
			},
			{
				type: 'PAYMENT_RECEIPT_SYNC_FAILED',
				severity: 'HIGH',
				referenceId: 'operation-1',
				ownerId: 'user-4',
				title: 'Синхронизация чека требует внимания',
				message: 'Чек платежа payment-provider-4 не синхронизирован',
				alertAt: new Date('2026-08-24T13:00:00.000Z')
			},
			{
				type: 'PAYMENT_RECEIPT_STALE',
				severity: 'HIGH',
				referenceId: 'payment-5',
				ownerId: 'user-5',
				title: 'У успешного платежа нет чека',
				message: 'Для платежа payment-provider-5 чек не появился',
				alertAt: new Date('2026-08-24T14:00:00.000Z')
			}
		]);
		const service = new BillingAdminAlertsService({
			$queryRaw: queryRaw
		} as never);

		await expect(service.getAlerts()).resolves.toEqual({
			schemaVersion: 1,
			total: 5,
			counts: {
				byType: {
					EXPIRED_ACTIVE_SUBSCRIPTION: 0,
					SUBSCRIPTION_EXPIRES_SOON: 0,
					PENDING_PAYMENT: 1,
					SUCCEEDED_PAYMENT_WITHOUT_ACCESS: 1,
					MULTIPLE_PENDING_PAYMENTS: 0,
					PAYMENT_RECEIPT_CANCELLED: 1,
					PAYMENT_RECEIPT_SYNC_FAILED: 1,
					PAYMENT_RECEIPT_STALE: 1,
					AFFILIATE_REWARD_STALE: 0,
					AFFILIATE_REWARD_PAYMENT_CANCELLED: 0
				},
				bySeverity: { HIGH: 4, MEDIUM: 1, LOW: 0 }
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
				},
				{
					type: 'PAYMENT_RECEIPT_CANCELLED',
					severity: 'HIGH',
					referenceId: 'receipt-1',
					ownerId: 'user-3',
					title: 'Чек отменён провайдером',
					message: 'Чек provider-receipt-1 отменён',
					alertAt: '2026-08-24T12:00:00.000Z'
				},
				{
					type: 'PAYMENT_RECEIPT_SYNC_FAILED',
					severity: 'HIGH',
					referenceId: 'operation-1',
					ownerId: 'user-4',
					title: 'Синхронизация чека требует внимания',
					message: 'Чек платежа payment-provider-4 не синхронизирован',
					alertAt: '2026-08-24T13:00:00.000Z'
				},
				{
					type: 'PAYMENT_RECEIPT_STALE',
					severity: 'HIGH',
					referenceId: 'payment-5',
					ownerId: 'user-5',
					title: 'У успешного платежа нет чека',
					message: 'Для платежа payment-provider-5 чек не появился',
					alertAt: '2026-08-24T14:00:00.000Z'
				}
			]
		});

		const sql = queryRaw.mock.calls[0][0].strings.join(' ');
		expect(sql).toContain('FROM billing.subscriptions');
		expect(sql).toContain('FROM billing.payments');
		expect(sql).toContain('FROM billing.payment_receipts');
		expect(sql).toContain('FROM billing.provider_operations');
		expect(sql).toContain('FROM billing.affiliate_referrals');
		expect(sql).toContain("NOW() - INTERVAL '30 minutes'");
		expect(sql).toContain("NOW() + INTERVAL '7 days'");
		expect(sql).toContain("NOW() - INTERVAL '3 days'");
		expect(sql).toContain('HAVING COUNT(*) > 1');
		expect(sql).toContain("lower(pr.status) = 'canceled'");
		expect(sql).toContain("pr.type IN ('payment', 'refund')");
		expect(sql).toContain('replacement.type = pr.type');
		expect(sql).toContain("lower(replacement.status) = 'succeeded'");
		expect(sql).toContain("jsonb_typeof(pr.raw) = 'object'");
		expect(sql).toContain(
			"jsonb_typeof(pr.raw -> 'payment_id') = 'string'"
		);
		expect(sql).toContain("pr.raw ->> 'payment_id' = p.yookassa_id");
		expect(sql).toContain("jsonb_typeof(pr.raw -> 'items') = 'array'");
		expect(sql).toContain("pr.raw -> 'items' <> '[]'::jsonb");
		expect(sql).toContain(
			"replacement.raw -> 'items' = pr.raw -> 'items'"
		);
		expect(sql).toContain(
			"replacement.raw -> 'settlements' = pr.raw -> 'settlements'"
		);
		expect(sql).toContain("pr.raw -> 'internet' = 'true'::jsonb");
		expect(sql).toContain("pr.type <> 'refund'");
		expect(sql).toContain(
			"jsonb_typeof(pr.raw -> 'refund_id') = 'string'"
		);
		expect(sql).toContain(
			"replacement.raw ->> 'refund_id' = pr.raw ->> 'refund_id'"
		);
		expect(sql).not.toContain('jsonb_array_length');
		expect(sql).not.toContain('replacement.created_at > pr.created_at');
		expect(sql).toContain("po.kind::text = 'SYNC_RECEIPT'");
		expect(sql).toContain("po.status::text IN ('FAILED', 'UNKNOWN')");
		expect(sql).toContain('p.receipt_sync_eligible = TRUE');
		expect(sql).toContain('NOT EXISTS');
		expect(sql).toContain("lower(pr.status) = 'succeeded'");
		expect(sql).toContain("pr.type = 'payment'");
		expect(sql).toContain("lower(pr.status) = 'pending'");
		expect(sql).not.toContain('billing_payment_read_projections');
		expect(sql).not.toContain('billing_subscription_read_projections');
		expect(sql).not.toContain('billing_affiliate_read_projections');
	});
});
