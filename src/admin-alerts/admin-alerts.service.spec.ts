import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService detached owner composition', () => {
	it('federates owner alerts and enriches identities without legacy Core tables', async () => {
		const alertAt = new Date('2026-08-05T12:00:00.000Z');
		const queryRaw = jest
			.fn()
			.mockResolvedValueOnce([{ targetUserId: 'user-1' }])
			.mockResolvedValueOnce([
				{
					alert_type: 'WIDGET_INVALID_DOMAIN',
					severity: 'MEDIUM',
					reference_id: 'widget-1',
					target_user_id: 'user-1',
					target_user_name: 'Owner',
					target_user_email: 'owner@example.test',
					target_user_phone: null,
					title: 'Некорректный домен виджета',
					message: 'Некорректный домен',
					alert_at: alertAt
				}
			])
			.mockResolvedValueOnce([{ count: 1 }]);
		const prisma = {
			$queryRaw: queryRaw,
			$transaction: jest.fn((queries: Promise<unknown>[]) =>
				Promise.all(queries)
			)
		};
		const health = {
			getAdminHealth: jest.fn().mockResolvedValue({ checks: [] })
		};
		const widgets = {
			getAdminAlerts: jest.fn().mockResolvedValue([
				{
					type: 'WIDGET_INVALID_DOMAIN',
					severity: 'MEDIUM',
					referenceId: 'widget-1',
					ownerId: 'user-1',
					title: 'Некорректный домен виджета',
					message: 'Некорректный домен',
					alertAt: alertAt.toISOString()
				}
			])
		};
		const identity = {
			getAuditSnapshots: jest.fn().mockResolvedValue(
				new Map([
					[
						'user-1',
						{
							id: 'user-1',
							name: 'Owner',
							email: 'owner@example.test'
						}
					]
				])
			)
		};
		const service = new AdminAlertsService(
			prisma as never,
			health as never,
			widgets as never,
			identity as never
		);

		await expect(service.getAll(1, 20)).resolves.toEqual({
			items: [
				{
					type: 'WIDGET_INVALID_DOMAIN',
					severity: 'MEDIUM',
					referenceId: 'widget-1',
					targetUser: {
						id: 'user-1',
						name: 'Owner',
						email: 'owner@example.test',
						phone: null
					},
					title: 'Некорректный домен виджета',
					message: 'Некорректный домен',
					alertAt: alertAt.toISOString()
				}
			],
			total: 1,
			page: 1,
			limit: 20,
			totalPages: 1
		});

		expect(identity.getAuditSnapshots).toHaveBeenCalledWith(['user-1']);
		const sql = queryRaw.mock.calls
			.map(([query]) => query.strings.join(' '))
			.join(' ');
		expect(sql).toContain('jsonb_to_recordset');
		expect(sql).toContain('billing_subscription_read_projections');
		expect(sql).toContain('billing_payment_read_projections');
		expect(sql).toContain('billing_affiliate_read_projections');
		expect(sql).not.toMatch(/\b(FROM|JOIN)\s+"?User"?\b/i);
		expect(sql).not.toContain('auth_identities');
		expect(sql).not.toContain('USER_WITHOUT_CONTACT');
		expect(sql).not.toContain('ACTIVE_SUBSCRIBER_WITHOUT_CONTACT');
	});
});
