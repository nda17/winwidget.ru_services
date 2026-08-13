import { AdminAlertsService } from './admin-alerts.service';

describe('AdminAlertsService Widgets handoff', () => {
	it('federates service-owned widget alerts without querying legacy Core tables', async () => {
		const alertAt = new Date('2026-08-05T12:00:00.000Z');
		const queryRaw = jest
			.fn()
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
		const service = new AdminAlertsService(
			prisma as never,
			health as never,
			widgets as never
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

		expect(widgets.getAdminAlerts).toHaveBeenCalledTimes(1);
		const sql = queryRaw.mock.calls
			.map(([query]) => query.strings.join(' '))
			.join(' ');
		expect(sql).toContain('jsonb_to_recordset');
		expect(sql).toContain('billing_subscription_read_projections');
		expect(sql).toContain('billing_payment_read_projections');
		expect(sql).toContain('billing_affiliate_read_projections');
		expect(sql).not.toMatch(
			/\b(FROM|JOIN)\s+"?(subscriptions|payments|affiliate_referrals)"?\b/i
		);
		expect(sql).not.toMatch(
			/\bFROM\s+(widgets|quizzes|callbacks|countdown_timers|stop_offers|online_consultants|calculators)\b/i
		);
		const values = queryRaw.mock.calls.flatMap(([query]) => query.values);
		expect(values).toContainEqual(
			expect.stringContaining('WIDGET_INVALID_DOMAIN')
		);
	});
});
