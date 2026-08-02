import { ReportingAnalyticsService } from './reporting-analytics.service';
import { normalizeLegacyPaymentAmount } from '../projections/projection.service';

const ZERO_USERS = {
	total: 0n,
	active30d: 0n,
	new30d: 0n,
	admins: 0n,
	withoutEmail: 0n,
	withoutPhone: 0n,
	withoutContacts: 0n,
	telegramLinked: 0n,
	multiLoginUsers: 0n
};

const ZERO_FINANCE = {
	revenueAllTime: '0',
	revenue30d: '0',
	revenueCurrentMonth: '0',
	succeededPayments30d: 0n,
	pendingPaymentsCurrent: 0n,
	cancelledPayments30d: 0n,
	payingUsersTotal: 0n,
	payingUsers30d: 0n
};

const ZERO_SUBSCRIPTIONS = {
	active: 0n,
	paidActive: 0n,
	trialActive: 0n,
	expiringToday: 0n,
	expiring3d: 0n,
	expiring7d: 0n,
	expiredActive: 0n,
	trialCount: 0n,
	easyCount: 0n,
	hardCount: 0n,
	activeCount: 0n,
	expiredCount: 0n,
	cancelledCount: 0n
};

const NON_EMPTY_GOLDEN = Object.freeze({
	finance: {
		revenueAllTime: 112.5,
		revenue30d: 12.5,
		revenueCurrentMonth: 12.5,
		succeededPayments30d: 2,
		pendingPaymentsCurrent: 1,
		cancelledPayments30d: 1,
		averageCheck30d: 6.25,
		payingUsersTotal: 3,
		payingUsers30d: 2
	},
	subscriptions: {
		active: 5,
		paidActive: 3,
		trialActive: 2,
		expiringToday: 1,
		expiring3d: 2,
		expiring7d: 3,
		expiredActive: 1,
		byPlan: [
			{ plan: 'TRIAL', label: 'Trial', count: 2 },
			{ plan: 'EASY', label: 'Easy', count: 1 },
			{ plan: 'HARD', label: 'Hard', count: 2 }
		],
		byStatus: [
			{ status: 'ACTIVE', label: 'Активные', count: 5 },
			{ status: 'EXPIRED', label: 'Истекшие', count: 4 },
			{ status: 'CANCELLED', label: 'Отменённые', count: 1 }
		]
	},
	leads: {
		total30d: 5,
		previous30d: 2,
		growth30d: 150,
		today: 1,
		allTime: 13,
		byType30d: [
			{ type: 'wheel', label: 'Колесо', count: 4 },
			{ type: 'quiz', label: 'Квизы', count: 1 },
			{ type: 'callback', label: 'Обратный звонок', count: 0 },
			{ type: 'countdownTimer', label: 'Таймеры', count: 0 },
			{ type: 'stopOffer', label: 'Стоп-офферы', count: 0 },
			{
				type: 'onlineConsultant',
				label: 'Онлайн-консультанты',
				count: 0
			},
			{
				type: 'calculator',
				label: 'Калькуляторы стоимости',
				count: 0
			}
		]
	},
	widgets: {
		total: 4,
		active: 3,
		inactive: 1,
		withoutDomain: 2,
		activeWithoutDomain: 1,
		new30d: 2,
		byType: [
			{
				type: 'wheel',
				label: 'Колесо',
				total: 3,
				active: 2,
				inactive: 1,
				withoutDomain: 2,
				activeWithoutDomain: 1,
				new30d: 1
			},
			{
				type: 'quiz',
				label: 'Квизы',
				total: 1,
				active: 1,
				inactive: 0,
				withoutDomain: 0,
				activeWithoutDomain: 0,
				new30d: 1
			},
			...[
				['callback', 'Обратный звонок'],
				['countdownTimer', 'Таймеры'],
				['stopOffer', 'Стоп-офферы'],
				['onlineConsultant', 'Онлайн-консультанты'],
				['calculator', 'Калькуляторы стоимости']
			].map(([type, label]) => ({
				type,
				label,
				total: 0,
				active: 0,
				inactive: 0,
				withoutDomain: 0,
				activeWithoutDomain: 0,
				new30d: 0
			}))
		]
	},
	users: {
		total: 10,
		publicTotal: 8,
		active30d: 7,
		new30d: 3,
		admins: 2,
		withoutEmail: 4,
		withoutPhone: 5,
		withoutContacts: 1,
		telegramLinked: 6
	},
	revenueMonths: [
		{
			periodKey: '2026-06',
			label: 'июнь 2026 г.',
			revenue: 100,
			payments: 1
		},
		{
			periodKey: '2026-07',
			label: 'июль 2026 г.',
			revenue: 12.5,
			payments: 2
		}
	]
});

describe('ReportingAnalyticsService DB aggregate goldens', () => {
	beforeEach(() => {
		process.env.TZ = 'Europe/Moscow';
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-07-31T23:30:00.000Z'));
	});

	afterEach(() => jest.useRealTimers());

	function dashboardService(nonEmpty: boolean) {
		const query = jest.fn();
		query
			.mockResolvedValueOnce([
				nonEmpty
					? {
							...ZERO_FINANCE,
							revenueAllTime: '112.5',
							revenue30d: '12.5',
							revenueCurrentMonth: '12.5',
							succeededPayments30d: 2n,
							pendingPaymentsCurrent: 1n,
							cancelledPayments30d: 1n,
							payingUsersTotal: 3n,
							payingUsers30d: 2n
						}
					: ZERO_FINANCE
			])
			.mockResolvedValueOnce([
				nonEmpty
					? {
							...ZERO_USERS,
							total: 10n,
							active30d: 7n,
							new30d: 3n,
							admins: 2n,
							withoutEmail: 4n,
							withoutPhone: 5n,
							withoutContacts: 1n,
							telegramLinked: 6n
						}
					: ZERO_USERS
			])
			.mockResolvedValueOnce([
				nonEmpty
					? {
							...ZERO_SUBSCRIPTIONS,
							active: 5n,
							paidActive: 3n,
							trialActive: 2n,
							expiringToday: 1n,
							expiring3d: 2n,
							expiring7d: 3n,
							expiredActive: 1n,
							trialCount: 2n,
							easyCount: 1n,
							hardCount: 2n,
							activeCount: 5n,
							expiredCount: 4n,
							cancelledCount: 1n
						}
					: ZERO_SUBSCRIPTIONS
			])
			.mockResolvedValueOnce(
				nonEmpty
					? [
							{
								widgetType: 'wheel',
								total30d: 4n,
								previous30d: 2n,
								today: 1n,
								allTime: 10n
							},
							{
								widgetType: 'quiz',
								total30d: 1n,
								previous30d: 0n,
								today: 0n,
								allTime: 3n
							}
						]
					: []
			)
			.mockResolvedValueOnce(
				nonEmpty
					? [
							{ widgetType: 'wheel', date: '2026-07-31', count: 1n },
							{ widgetType: 'quiz', date: '2026-07-30', count: 2n }
						]
					: []
			)
			.mockResolvedValueOnce(
				nonEmpty
					? [
							{
								widgetType: 'wheel',
								total: 3n,
								active: 2n,
								inactive: 1n,
								withoutDomain: 2n,
								activeWithoutDomain: 1n,
								new30d: 1n
							},
							{
								widgetType: 'quiz',
								total: 1n,
								active: 1n,
								inactive: 0n,
								withoutDomain: 0n,
								activeWithoutDomain: 0n,
								new30d: 1n
							}
						]
					: []
			)
			.mockResolvedValueOnce(
				nonEmpty
					? [
							{ periodKey: '2026-06', revenue: '100', payments: 1n },
							{ periodKey: '2026-07', revenue: '12.5', payments: 2n }
						]
					: []
			);
		return {
			service: new ReportingAnalyticsService({
				$queryRaw: query
			} as never),
			query
		};
	}

	it('preserves a non-empty dashboard golden and explicit UTC buckets', async () => {
		const { service, query } = dashboardService(true);
		const dashboard = await service.getDashboard();
		const golden = {
			finance: dashboard.finance,
			subscriptions: dashboard.subscriptions,
			leads: {
				...dashboard.leads,
				byDay: undefined
			},
			widgets: dashboard.widgets,
			users: dashboard.users,
			revenueMonths: dashboard.charts.revenueByMonth.filter(
				item => item.payments > 0
			)
		};
		delete golden.leads.byDay;
		expect(golden).toEqual(NON_EMPTY_GOLDEN);
		expect(dashboard.leads.byDay.at(-1)).toMatchObject({
			date: '2026-07-31',
			wheel: 1,
			total: 1
		});
		expect(dashboard.leads.byDay.at(-2)).toMatchObject({
			date: '2026-07-30',
			quiz: 2,
			total: 2
		});
		const financeSql = (query.mock.calls[0][0] as string[]).join(' ');
		expect(financeSql).toContain('SUM("normalized_amount")');
	});

	it('keeps the complete empty dashboard shape', async () => {
		const dashboard = await dashboardService(false).service.getDashboard();
		expect(dashboard.generatedAt).toBe('2026-07-31T23:30:00.000Z');
		expect(dashboard.finance).toEqual({
			revenueAllTime: 0,
			revenue30d: 0,
			revenueCurrentMonth: 0,
			succeededPayments30d: 0,
			pendingPaymentsCurrent: 0,
			cancelledPayments30d: 0,
			averageCheck30d: 0,
			payingUsersTotal: 0,
			payingUsers30d: 0
		});
		expect(dashboard.leads.byDay).toHaveLength(30);
		expect(dashboard.widgets.byType).toHaveLength(7);
		expect(dashboard.charts.revenueByMonth).toHaveLength(12);
	});

	it('keeps legacy amount semantics for invalid and comma-decimal source values', () => {
		expect(
			['10', '2,5', 'invalid'].reduce(
				(sum, value) => sum + (normalizeLegacyPaymentAmount(value) || 0),
				0
			)
		).toBe(12.5);
		expect(normalizeLegacyPaymentAmount(' 1 234,50 ')).toBeNull();
		expect(normalizeLegacyPaymentAmount('001.50')).toBe(1.5);
		expect(normalizeLegacyPaymentAmount('1e3')).toBe(1000);
	});

	it('returns aggregate overview and preserves the legacy duplicated final registration month', async () => {
		const overviewQuery = jest.fn().mockResolvedValue([
			{
				...ZERO_USERS,
				total: 9n,
				active30d: 4n,
				new30d: 2n,
				multiLoginUsers: 3n,
				admins: 1n
			}
		]);
		await expect(
			new ReportingAnalyticsService({
				$queryRaw: overviewQuery
			} as never).getOverview()
		).resolves.toEqual({
			totalUsers: 9,
			activeUsers30d: 4,
			newUsers30d: 2,
			multiLoginUsers: 3,
			adminUsers: 1
		});

		const registrations = await new ReportingAnalyticsService({
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ periodKey: '2026-07', count: 5n }])
		} as never).getRegistrationsByMonth();
		expect(registrations).toHaveLength(13);
		expect(registrations.slice(-2)).toEqual([
			{ month: 'July', year: 2026, count: 5 },
			{ month: 'July', year: 2026, count: 5 }
		]);
	});
});
