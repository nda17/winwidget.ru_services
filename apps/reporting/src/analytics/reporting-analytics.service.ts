import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	REPORTING_LEAD_WIDGET_TYPES,
	REPORTING_WIDGET_TYPES
} from '../projections/reporting-event.contract';
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';

type WidgetType = (typeof REPORTING_WIDGET_TYPES)[number];
type LeadWidgetType = (typeof REPORTING_LEAD_WIDGET_TYPES)[number];
type SqlNumberish = bigint | number | string | null;

interface FinanceRow {
	revenueAllTime: SqlNumberish;
	revenue30d: SqlNumberish;
	revenueCurrentMonth: SqlNumberish;
	succeededPayments30d: SqlNumberish;
	pendingPaymentsCurrent: SqlNumberish;
	cancelledPayments30d: SqlNumberish;
	payingUsersTotal: SqlNumberish;
	payingUsers30d: SqlNumberish;
}

interface UserStatsRow {
	total: SqlNumberish;
	active30d: SqlNumberish;
	new30d: SqlNumberish;
	admins: SqlNumberish;
	withoutEmail: SqlNumberish;
	withoutPhone: SqlNumberish;
	withoutContacts: SqlNumberish;
	telegramLinked: SqlNumberish;
	multiLoginUsers: SqlNumberish;
}

interface SubscriptionStatsRow {
	active: SqlNumberish;
	paidActive: SqlNumberish;
	trialActive: SqlNumberish;
	expiringToday: SqlNumberish;
	expiring3d: SqlNumberish;
	expiring7d: SqlNumberish;
	expiredActive: SqlNumberish;
	trialCount: SqlNumberish;
	easyCount: SqlNumberish;
	hardCount: SqlNumberish;
	activeCount: SqlNumberish;
	expiredCount: SqlNumberish;
	cancelledCount: SqlNumberish;
}

interface LeadStatsRow {
	widgetType: LeadWidgetType;
	total30d: SqlNumberish;
	previous30d: SqlNumberish;
	today: SqlNumberish;
	allTime: SqlNumberish;
}

interface LeadDayRow {
	widgetType: LeadWidgetType;
	date: string;
	count: SqlNumberish;
}

interface WidgetStatsRow {
	widgetType: WidgetType;
	total: SqlNumberish;
	active: SqlNumberish;
	inactive: SqlNumberish;
	withoutDomain: SqlNumberish;
	activeWithoutDomain: SqlNumberish;
	new30d: SqlNumberish;
}

interface RevenueMonthRow {
	periodKey: string;
	revenue: SqlNumberish;
	payments: SqlNumberish;
}

interface RegistrationMonthRow {
	periodKey: string;
	count: SqlNumberish;
}

@Injectable()
export class ReportingAnalyticsService {
	constructor(private readonly prisma: ReportingPrismaService) {}

	async getDashboard() {
		const now = new Date();
		const todayStart = this.startOfUtcDay(now);
		const tomorrowStart = this.addDays(todayStart, 1);
		const last30DaysStart = this.addDays(now, -30);
		const previous30DaysStart = this.addDays(now, -60);
		const currentMonthStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
		);
		const firstRevenueMonthStart = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
		);
		const expiresIn3Days = this.addDays(now, 3);
		const expiresIn7Days = this.addDays(now, 7);
		const leadDayPeriods = this.generateDayPeriods(30, now);
		const revenueMonthPeriods = this.generateMonthPeriods(12, now);

		const [
			financeRows,
			userRows,
			subscriptionRows,
			leadRows,
			leadDayRows,
			widgetRows,
			revenueRows
		] = await Promise.all([
			this.prisma.$queryRaw<FinanceRow[]>`
				SELECT
					COALESCE(SUM("normalized_amount")
						FILTER (WHERE "status" = 'SUCCEEDED'), 0)::TEXT AS "revenueAllTime",
					COALESCE(SUM("normalized_amount")
						FILTER (WHERE "status" = 'SUCCEEDED' AND "source_updated_at" >= ${last30DaysStart}), 0)::TEXT AS "revenue30d",
					COALESCE(SUM("normalized_amount")
						FILTER (WHERE "status" = 'SUCCEEDED' AND "source_updated_at" >= ${currentMonthStart}), 0)::TEXT AS "revenueCurrentMonth",
					COUNT(*) FILTER (WHERE "status" = 'SUCCEEDED' AND "source_updated_at" >= ${last30DaysStart}) AS "succeededPayments30d",
					COUNT(*) FILTER (WHERE "status" = 'PENDING') AS "pendingPaymentsCurrent",
					COUNT(*) FILTER (WHERE "status" = 'CANCELLED' AND "source_updated_at" >= ${last30DaysStart}) AS "cancelledPayments30d",
					COUNT(DISTINCT "user_id") FILTER (WHERE "status" = 'SUCCEEDED') AS "payingUsersTotal",
					COUNT(DISTINCT "user_id") FILTER (WHERE "status" = 'SUCCEEDED' AND "source_updated_at" >= ${last30DaysStart}) AS "payingUsers30d"
				FROM "reporting"."billing_payment_facts"
				WHERE "tombstoned" = FALSE
			`,
			this.userStats(last30DaysStart),
			this.prisma.$queryRaw<SubscriptionStatsRow[]>`
				SELECT
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE') AS "active",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."plan" IN ('EASY', 'HARD')) AS "paidActive",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."plan" = 'TRIAL') AS "trialActive",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."expires_at" >= ${todayStart} AND subscriptions."expires_at" < ${tomorrowStart}) AS "expiringToday",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."expires_at" >= ${now} AND subscriptions."expires_at" < ${expiresIn3Days}) AS "expiring3d",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."expires_at" >= ${now} AND subscriptions."expires_at" < ${expiresIn7Days}) AS "expiring7d",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."expires_at" < ${now}) AS "expiredActive",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."plan" = 'TRIAL') AS "trialCount",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."plan" = 'EASY') AS "easyCount",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE' AND subscriptions."plan" = 'HARD') AS "hardCount",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'ACTIVE') AS "activeCount",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'EXPIRED') AS "expiredCount",
					COUNT(*) FILTER (WHERE subscriptions."status" = 'CANCELLED') AS "cancelledCount"
				FROM "reporting"."billing_subscription_projections" subscriptions
				INNER JOIN "reporting"."identity_user_projections" users
					ON users."id" = subscriptions."user_id"
					AND users."tombstoned" = FALSE
					AND users."deleted_at" IS NULL
				WHERE subscriptions."tombstoned" = FALSE
			`,
			this.prisma.$queryRaw<LeadStatsRow[]>`
				SELECT
					"widget_type" AS "widgetType",
					COUNT(*) FILTER (WHERE "source_created_at" >= ${last30DaysStart}) AS "total30d",
					COUNT(*) FILTER (WHERE "source_created_at" >= ${previous30DaysStart} AND "source_created_at" < ${last30DaysStart}) AS "previous30d",
					COUNT(*) FILTER (WHERE "source_created_at" >= ${todayStart} AND "source_created_at" < ${tomorrowStart}) AS "today",
					COUNT(*) AS "allTime"
				FROM "reporting"."lead_facts"
				WHERE "tombstoned" = FALSE
				GROUP BY "widget_type"
			`,
			this.prisma.$queryRaw<LeadDayRow[]>`
				SELECT
					"widget_type" AS "widgetType",
					TO_CHAR("source_created_at", 'YYYY-MM-DD') AS "date",
					COUNT(*) AS "count"
				FROM "reporting"."lead_facts"
				WHERE "tombstoned" = FALSE
					AND "source_created_at" >= ${leadDayPeriods[0].start}
				GROUP BY "widget_type", TO_CHAR("source_created_at", 'YYYY-MM-DD')
			`,
			this.prisma.$queryRaw<WidgetStatsRow[]>`
				SELECT
					"widget_type" AS "widgetType",
					COUNT(*) AS "total",
					COUNT(*) FILTER (WHERE "is_active" = TRUE) AS "active",
					COUNT(*) FILTER (WHERE "is_active" = FALSE) AS "inactive",
					COUNT(*) FILTER (WHERE "has_install_domain" = FALSE) AS "withoutDomain",
					COUNT(*) FILTER (WHERE "is_active" = TRUE AND "has_install_domain" = FALSE) AS "activeWithoutDomain",
					COUNT(*) FILTER (WHERE "source_created_at" >= ${last30DaysStart}) AS "new30d"
				FROM "reporting"."widget_projections"
				WHERE "tombstoned" = FALSE
				GROUP BY "widget_type"
			`,
			this.prisma.$queryRaw<RevenueMonthRow[]>`
				SELECT
					TO_CHAR("source_updated_at", 'YYYY-MM') AS "periodKey",
					COALESCE(SUM("normalized_amount"), 0)::TEXT AS "revenue",
					COUNT(*) AS "payments"
				FROM "reporting"."billing_payment_facts"
				WHERE "tombstoned" = FALSE
					AND "status" = 'SUCCEEDED'
					AND "source_updated_at" >= ${firstRevenueMonthStart}
				GROUP BY TO_CHAR("source_updated_at", 'YYYY-MM')
			`
		]);

		const finance = this.first(financeRows, 'finance');
		const users = this.first(userRows, 'users');
		const subscriptions = this.first(subscriptionRows, 'subscriptions');
		const leadStats = new Map(leadRows.map(row => [row.widgetType, row]));
		const widgetStats = new Map(
			widgetRows.map(row => [row.widgetType, row])
		);
		const leadDays = new Map(
			leadDayRows.map(row => [
				`${row.date}:${row.widgetType}`,
				this.number(row.count)
			])
		);
		const revenueMonths = new Map(
			revenueRows.map(row => [row.periodKey, row])
		);
		const revenue30d = this.number(finance.revenue30d);
		const succeededPayments30d = this.number(finance.succeededPayments30d);
		const totalLeads30d = this.sumByWidget(leadStats, 'total30d');
		const previousLeads30d = this.sumByWidget(leadStats, 'previous30d');
		const byTypeWidgets = REPORTING_WIDGET_TYPES.map(type => {
			const row = widgetStats.get(type);
			return {
				type,
				label: this.widgetLabel(type),
				total: this.number(row?.total),
				active: this.number(row?.active),
				inactive: this.number(row?.inactive),
				withoutDomain: this.number(row?.withoutDomain),
				activeWithoutDomain: this.number(row?.activeWithoutDomain),
				new30d: this.number(row?.new30d)
			};
		});

		return {
			generatedAt: now.toISOString(),
			finance: {
				revenueAllTime: this.number(finance.revenueAllTime),
				revenue30d,
				revenueCurrentMonth: this.number(finance.revenueCurrentMonth),
				succeededPayments30d,
				pendingPaymentsCurrent: this.number(
					finance.pendingPaymentsCurrent
				),
				cancelledPayments30d: this.number(finance.cancelledPayments30d),
				averageCheck30d: succeededPayments30d
					? revenue30d / succeededPayments30d
					: 0,
				payingUsersTotal: this.number(finance.payingUsersTotal),
				payingUsers30d: this.number(finance.payingUsers30d)
			},
			subscriptions: {
				active: this.number(subscriptions.active),
				paidActive: this.number(subscriptions.paidActive),
				trialActive: this.number(subscriptions.trialActive),
				expiringToday: this.number(subscriptions.expiringToday),
				expiring3d: this.number(subscriptions.expiring3d),
				expiring7d: this.number(subscriptions.expiring7d),
				expiredActive: this.number(subscriptions.expiredActive),
				byPlan: [
					{
						plan: 'TRIAL',
						label: 'Trial',
						count: this.number(subscriptions.trialCount)
					},
					{
						plan: 'EASY',
						label: 'Easy',
						count: this.number(subscriptions.easyCount)
					},
					{
						plan: 'HARD',
						label: 'Hard',
						count: this.number(subscriptions.hardCount)
					}
				],
				byStatus: [
					{
						status: 'ACTIVE',
						label: 'Активные',
						count: this.number(subscriptions.activeCount)
					},
					{
						status: 'EXPIRED',
						label: 'Истекшие',
						count: this.number(subscriptions.expiredCount)
					},
					{
						status: 'CANCELLED',
						label: 'Отменённые',
						count: this.number(subscriptions.cancelledCount)
					}
				]
			},
			leads: {
				total30d: totalLeads30d,
				previous30d: previousLeads30d,
				growth30d: this.growthPercent(totalLeads30d, previousLeads30d),
				today: this.sumByWidget(leadStats, 'today'),
				allTime: this.sumByWidget(leadStats, 'allTime'),
				byType30d: REPORTING_LEAD_WIDGET_TYPES.map(type => ({
					type,
					label: this.widgetLabel(type),
					count: this.number(leadStats.get(type)?.total30d)
				})),
				byDay: leadDayPeriods.map(period => {
					const counts = Object.fromEntries(
						REPORTING_LEAD_WIDGET_TYPES.map(type => [
							type,
							leadDays.get(`${period.date}:${type}`) || 0
						])
					) as Record<LeadWidgetType, number>;
					return {
						date: period.date,
						label: period.label,
						...counts,
						total: REPORTING_LEAD_WIDGET_TYPES.reduce(
							(sum, type) => sum + counts[type],
							0
						)
					};
				})
			},
			widgets: {
				total: byTypeWidgets.reduce((sum, item) => sum + item.total, 0),
				active: byTypeWidgets.reduce((sum, item) => sum + item.active, 0),
				inactive: byTypeWidgets.reduce(
					(sum, item) => sum + item.inactive,
					0
				),
				withoutDomain: byTypeWidgets.reduce(
					(sum, item) => sum + item.withoutDomain,
					0
				),
				activeWithoutDomain: byTypeWidgets.reduce(
					(sum, item) => sum + item.activeWithoutDomain,
					0
				),
				new30d: byTypeWidgets.reduce((sum, item) => sum + item.new30d, 0),
				byType: byTypeWidgets
			},
			users: {
				total: this.number(users.total),
				publicTotal: Math.max(
					this.number(users.total) - this.number(users.admins),
					0
				),
				active30d: this.number(users.active30d),
				new30d: this.number(users.new30d),
				admins: this.number(users.admins),
				withoutEmail: this.number(users.withoutEmail),
				withoutPhone: this.number(users.withoutPhone),
				withoutContacts: this.number(users.withoutContacts),
				telegramLinked: this.number(users.telegramLinked)
			},
			charts: {
				revenueByMonth: revenueMonthPeriods.map(period => {
					const row = revenueMonths.get(period.periodKey);
					return {
						...period,
						revenue: this.number(row?.revenue),
						payments: this.number(row?.payments)
					};
				})
			}
		};
	}

	async getOverview() {
		const rows = await this.userStats(this.addDays(new Date(), -30));
		const users = this.first(rows, 'users');
		return {
			totalUsers: this.number(users.total),
			activeUsers30d: this.number(users.active30d),
			newUsers30d: this.number(users.new30d),
			multiLoginUsers: this.number(users.multiLoginUsers),
			adminUsers: this.number(users.admins)
		};
	}

	async getRegistrationsByMonth() {
		const now = new Date();
		const currentMonth = now.getUTCMonth();
		const currentYear = now.getUTCFullYear();
		const startDate = new Date(
			Date.UTC(currentYear - 1, currentMonth + 1, 1)
		);
		const endDate = new Date(Date.UTC(currentYear, currentMonth + 1, 0));
		const rows = await this.prisma.$queryRaw<RegistrationMonthRow[]>`
			SELECT
				TO_CHAR("created_at", 'YYYY-MM') AS "periodKey",
				COUNT(*) AS "count"
			FROM "reporting"."identity_user_projections"
			WHERE "tombstoned" = FALSE
				AND "deleted_at" IS NULL
				AND "created_at" >= ${startDate}
				AND "created_at" <= ${endDate}
			GROUP BY TO_CHAR("created_at", 'YYYY-MM')
			ORDER BY "periodKey" ASC
		`;
		const counts = new Map(
			rows.map(row => [row.periodKey, this.number(row.count)])
		);
		return this.generateMonths(startDate, endDate).map(
			({ month, year }) => {
				const date = new Date(Date.UTC(year, month - 1, 1));
				return {
					month: dayjs(date).locale('en').format('MMMM'),
					year,
					count: counts.get(this.formatMonthKey(date)) || 0
				};
			}
		);
	}

	private userStats(since: Date): Promise<UserStatsRow[]> {
		return this.prisma.$queryRaw<UserStatsRow[]>`
			SELECT
				COUNT(*) AS "total",
				COUNT(*) FILTER (WHERE "source_updated_at" >= ${since}) AS "active30d",
				COUNT(*) FILTER (WHERE "created_at" >= ${since}) AS "new30d",
				COUNT(*) FILTER (WHERE "roles" @> ARRAY['ADMIN']::TEXT[]) AS "admins",
				COUNT(*) FILTER (WHERE "has_email_identity" = FALSE) AS "withoutEmail",
				COUNT(*) FILTER (WHERE "has_phone_identity" = FALSE) AS "withoutPhone",
				COUNT(*) FILTER (WHERE "has_email_identity" = FALSE AND "has_phone_identity" = FALSE) AS "withoutContacts",
				COUNT(*) FILTER (WHERE "has_telegram_identity" = TRUE) AS "telegramLinked",
				COUNT(*) FILTER (WHERE "login_method_count" >= 2) AS "multiLoginUsers"
			FROM "reporting"."identity_user_projections"
			WHERE "tombstoned" = FALSE AND "deleted_at" IS NULL
		`;
	}

	private first<T>(rows: T[], name: string): T {
		if (rows.length !== 1) {
			throw new Error(
				`Reporting ${name} aggregate returned ${rows.length} rows`
			);
		}
		return rows[0];
	}

	private number(value: SqlNumberish | undefined): number {
		if (value === undefined || value === null) return 0;
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new Error('Reporting aggregate contains a non-finite value');
		}
		return parsed;
	}

	private sumByWidget<K extends keyof LeadStatsRow>(
		rows: Map<LeadWidgetType, LeadStatsRow>,
		key: K
	): number {
		return REPORTING_LEAD_WIDGET_TYPES.reduce(
			(sum, type) =>
				sum + this.number(rows.get(type)?.[key] as SqlNumberish),
			0
		);
	}

	private generateMonths(start: Date, end: Date) {
		const current = new Date(start);
		const months: Array<{ month: number; year: number }> = [];
		while (current < end) {
			months.push({
				month: current.getUTCMonth() + 1,
				year: current.getUTCFullYear()
			});
			current.setUTCMonth(current.getUTCMonth() + 1);
		}
		months.push({
			month: end.getUTCMonth() + 1,
			year: end.getUTCFullYear()
		});
		return months;
	}

	private generateDayPeriods(days: number, endDate: Date) {
		const endDayStart = this.startOfUtcDay(endDate);
		return Array.from({ length: days }, (_, index) => {
			const date = this.addDays(endDayStart, index - days + 1);
			return {
				date: this.formatDateKey(date),
				label: new Intl.DateTimeFormat('ru-RU', {
					day: '2-digit',
					month: 'short',
					timeZone: 'UTC'
				}).format(date),
				start: date
			};
		});
	}

	private generateMonthPeriods(months: number, endDate: Date) {
		const currentMonthStart = new Date(
			Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1)
		);
		return Array.from({ length: months }, (_, index) => {
			const date = new Date(
				Date.UTC(
					currentMonthStart.getUTCFullYear(),
					currentMonthStart.getUTCMonth() + index - months + 1,
					1
				)
			);
			return {
				periodKey: this.formatMonthKey(date),
				label: new Intl.DateTimeFormat('ru-RU', {
					month: 'short',
					year: 'numeric',
					timeZone: 'UTC'
				}).format(date)
			};
		});
	}

	private growthPercent(current: number, previous: number): number | null {
		if (previous <= 0) return current > 0 ? null : 0;
		return ((current - previous) / previous) * 100;
	}

	private startOfUtcDay(value: Date): Date {
		return new Date(
			Date.UTC(
				value.getUTCFullYear(),
				value.getUTCMonth(),
				value.getUTCDate()
			)
		);
	}

	private addDays(value: Date, days: number): Date {
		return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
	}

	private formatDateKey(value: Date): string {
		const month = `${value.getUTCMonth() + 1}`.padStart(2, '0');
		const day = `${value.getUTCDate()}`.padStart(2, '0');
		return `${value.getUTCFullYear()}-${month}-${day}`;
	}

	private formatMonthKey(value: Date): string {
		const month = `${value.getUTCMonth() + 1}`.padStart(2, '0');
		return `${value.getUTCFullYear()}-${month}`;
	}

	private widgetLabel(type: WidgetType): string {
		return {
			wheel: 'Колесо',
			quiz: 'Квизы',
			callback: 'Обратный звонок',
			countdownTimer: 'Таймеры',
			stopOffer: 'Стоп-офферы',
			aiConsultant: 'AI-консультанты',
			calculator: 'Калькуляторы стоимости'
		}[type];
	}
}
