import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	REPORTING_LEAD_WIDGET_TYPES,
	ReportingLeadWidgetType
} from '../projections/reporting-event.contract';
import { Injectable } from '@nestjs/common';

interface DailySummaryPeriod {
	start: Date;
	end: Date;
}

interface LeadCounts {
	total: number;
	wheel: number;
	quiz: number;
	callback: number;
	countdownTimer: number;
	stopOffer: number;
	calculator: number;
}

interface SubscriptionAttentionCounts {
	expiringToday: bigint;
	expiring3d: bigint;
	expiring7d: bigint;
	expiredActive: bigint;
}

@Injectable()
export class DailySummaryReportService {
	private readonly moscowOffsetMs = 3 * 60 * 60 * 1000;

	constructor(private readonly prisma: ReportingPrismaService) {}

	async render(periodStart: Date, periodEnd: Date): Promise<string> {
		const period: DailySummaryPeriod = {
			start: periodStart,
			end: periodEnd
		};
		const range = { gte: period.start, lt: period.end };
		const now = new Date();
		const dayMs = 24 * 60 * 60 * 1000;
		const previousRange = {
			gte: new Date(period.start.getTime() - dayMs),
			lt: period.start
		};
		const last7DaysRange = {
			gte: new Date(period.end.getTime() - 7 * dayMs),
			lt: period.end
		};
		const stalePendingBefore = new Date(now.getTime() - dayMs);
		const todayEndsAt = new Date(now.getTime() + dayMs);
		const soonEndsAt3d = new Date(now.getTime() + 3 * dayMs);
		const soonEndsAt7d = new Date(now.getTime() + 7 * dayMs);
		const shiftedPeriodStart = new Date(
			period.start.getTime() + this.moscowOffsetMs
		);
		shiftedPeriodStart.setUTCDate(1);
		shiftedPeriodStart.setUTCHours(0, 0, 0, 0);
		const currentMonthStart = new Date(
			shiftedPeriodStart.getTime() - this.moscowOffsetMs
		);

		const [
			totalUsers,
			userRoleUsers,
			adminRoleUsers,
			devRoleUsers,
			newUsers,
			previousNewUsers,
			newUsers7d,
			succeededPayments,
			previousSucceededPayments,
			monthSucceededPayments,
			pendingCreated,
			pendingCurrent,
			stalePending,
			cancelledPayments,
			currentLeads,
			previousLeads,
			last7DaysLeads,
			subscriptionRows,
			usersWithoutContacts
		] = await Promise.all([
			this.prisma.identityUserProjection.count({
				where: { tombstoned: false, deletedAt: null }
			}),
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					roles: { has: 'USER' }
				}
			}),
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					roles: { has: 'ADMIN' }
				}
			}),
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					roles: { has: 'DEV' }
				}
			}),
			this.prisma.identityUserProjection.count({
				where: { tombstoned: false, deletedAt: null, createdAt: range }
			}),
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					createdAt: previousRange
				}
			}),
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					createdAt: last7DaysRange
				}
			}),
			this.prisma.billingPaymentFact.findMany({
				where: {
					tombstoned: false,
					status: 'SUCCEEDED',
					sourceUpdatedAt: range
				},
				select: { amount: true, userId: true, sourceUpdatedAt: true },
				orderBy: { sourceUpdatedAt: 'asc' }
			}),
			this.prisma.billingPaymentFact.findMany({
				where: {
					tombstoned: false,
					status: 'SUCCEEDED',
					sourceUpdatedAt: previousRange
				},
				select: { amount: true }
			}),
			this.prisma.billingPaymentFact.findMany({
				where: {
					tombstoned: false,
					status: 'SUCCEEDED',
					sourceUpdatedAt: { gte: currentMonthStart, lt: period.end }
				},
				select: { amount: true }
			}),
			this.prisma.billingPaymentFact.count({
				where: {
					tombstoned: false,
					status: 'PENDING',
					sourceCreatedAt: range
				}
			}),
			this.prisma.billingPaymentFact.count({
				where: { tombstoned: false, status: 'PENDING' }
			}),
			this.prisma.billingPaymentFact.count({
				where: {
					tombstoned: false,
					status: 'PENDING',
					sourceCreatedAt: { lt: stalePendingBefore }
				}
			}),
			this.prisma.billingPaymentFact.count({
				where: {
					tombstoned: false,
					status: 'CANCELLED',
					sourceUpdatedAt: range
				}
			}),
			this.leadCounts(range),
			this.leadCounts(previousRange),
			this.leadCounts(last7DaysRange),
			this.prisma.$queryRaw<SubscriptionAttentionCounts[]>`
				SELECT
					COUNT(*) FILTER (
						WHERE subscriptions."expires_at" >= ${now}
						AND subscriptions."expires_at" < ${todayEndsAt}
					) AS "expiringToday",
					COUNT(*) FILTER (
						WHERE subscriptions."expires_at" >= ${now}
						AND subscriptions."expires_at" < ${soonEndsAt3d}
					) AS "expiring3d",
					COUNT(*) FILTER (
						WHERE subscriptions."expires_at" >= ${now}
						AND subscriptions."expires_at" < ${soonEndsAt7d}
					) AS "expiring7d",
					COUNT(*) FILTER (
						WHERE subscriptions."expires_at" < ${now}
					) AS "expiredActive"
				FROM "reporting"."billing_subscription_projections" subscriptions
				INNER JOIN "reporting"."identity_user_projections" users
					ON users."id" = subscriptions."user_id"
					AND users."tombstoned" = FALSE
					AND users."deleted_at" IS NULL
				WHERE subscriptions."tombstoned" = FALSE
					AND subscriptions."status" = 'ACTIVE'
			`,
			this.prisma.identityUserProjection.count({
				where: {
					tombstoned: false,
					deletedAt: null,
					hasEmailIdentity: false,
					hasPhoneIdentity: false
				}
			})
		]);

		const currentUserIds = [
			...new Set(
				succeededPayments
					.map(payment => payment.userId)
					.filter((id): id is string => Boolean(id))
			)
		];
		const previousPayments = currentUserIds.length
			? await this.prisma.billingPaymentFact.findMany({
					where: {
						tombstoned: false,
						status: 'SUCCEEDED',
						sourceUpdatedAt: { lt: period.start },
						userId: { in: currentUserIds }
					},
					select: { userId: true },
					distinct: ['userId']
				})
			: [];
		const previousPayers = new Set(
			previousPayments
				.map(payment => payment.userId)
				.filter((id): id is string => Boolean(id))
		);
		let firstPayments = 0;
		let repeatPayments = 0;
		for (const payment of succeededPayments) {
			if (payment.userId && previousPayers.has(payment.userId)) {
				repeatPayments += 1;
			} else {
				firstPayments += 1;
				if (payment.userId) previousPayers.add(payment.userId);
			}
		}
		const revenue = this.paymentAmount(succeededPayments);
		const subscription = subscriptionRows[0] || {
			expiringToday: 0n,
			expiring3d: 0n,
			expiring7d: 0n,
			expiredActive: 0n
		};

		return [
			'<b>Ежедневная сводка WinWidget</b>',
			`${this.formatMoscowDate(period.start)} · МСК`,
			'',
			'<b>Итоги дня</b>',
			`👤 Регистрации: ${newUsers} (вчера: ${previousNewUsers} · среднее за 7 дней: ${this.formatAverage(newUsers7d / 7)})`,
			`💳 Выручка: ${this.formatMoney(revenue)} (вчера: ${this.formatMoney(this.paymentAmount(previousSucceededPayments))} · за месяц: ${this.formatMoney(this.paymentAmount(monthSucceededPayments))})`,
			`🎯 Лиды: ${currentLeads.total} (вчера: ${previousLeads.total} · среднее за 7 дней: ${this.formatAverage(last7DaysLeads.total / 7)})`,
			'',
			'<b>Пользователи</b>',
			`- Всего: ${totalUsers}`,
			`- С ролью USER: ${userRoleUsers}`,
			`- С ролью ADMIN: ${adminRoleUsers}`,
			`- С ролью DEV: ${devRoleUsers}`,
			'',
			'<b>Платежи</b>',
			`- Успешные: ${succeededPayments.length}`,
			`- Первые оплаты: ${firstPayments}`,
			`- Повторные оплаты: ${repeatPayments}`,
			`- Средний чек: ${succeededPayments.length ? this.formatMoney(revenue / succeededPayments.length) : '—'}`,
			`- Создано pending: ${pendingCreated}`,
			`- Pending сейчас: ${pendingCurrent}`,
			`- Отменённые: ${cancelledPayments}`,
			'',
			'<b>Лиды</b>',
			`- Всего: ${currentLeads.total}`,
			`- Колесо: ${currentLeads.wheel}`,
			`- Квизы: ${currentLeads.quiz}`,
			`- Обратный звонок: ${currentLeads.callback}`,
			`- Таймеры: ${currentLeads.countdownTimer}`,
			`- Стоп-офферы: ${currentLeads.stopOffer}`,
			`- Калькуляторы стоимости: ${currentLeads.calculator}`,
			'',
			'<b>Подписки</b>',
			`- Истекают в ближайшие 24 часа: ${Number(subscription.expiringToday)}`,
			`- Истекают в ближайшие 3 дня: ${Number(subscription.expiring3d)}`,
			`- Истекают в ближайшие 7 дней: ${Number(subscription.expiring7d)}`,
			`- Истекли, но ещё ACTIVE: ${Number(subscription.expiredActive)}`,
			'',
			'<b>Требует внимания</b>',
			`- Pending более 24 часов: ${stalePending}${stalePending ? ' ⚠️' : ''}`,
			`- Всего пользователей без email и телефона: ${usersWithoutContacts}${usersWithoutContacts ? ' ⚠️' : ''}`,
			`- Просроченные ACTIVE-подписки: ${Number(subscription.expiredActive)}${subscription.expiredActive ? ' ⚠️' : ''}`,
			'',
			`Сформировано: ${this.formatMoscowDateTime(new Date())} МСК`
		].join('\n');
	}

	private async leadCounts(range: {
		gte: Date;
		lt: Date;
	}): Promise<LeadCounts> {
		const groups = await this.prisma.leadFact.groupBy({
			by: ['widgetType'],
			where: {
				tombstoned: false,
				sourceCreatedAt: range
			},
			_count: true
		});
		const map = new Map(
			groups.map(group => [group.widgetType, group._count])
		);
		const result = Object.fromEntries(
			REPORTING_LEAD_WIDGET_TYPES.map(type => [type, map.get(type) || 0])
		) as Record<ReportingLeadWidgetType, number>;
		return {
			...result,
			total: REPORTING_LEAD_WIDGET_TYPES.reduce(
				(sum, type) => sum + result[type],
				0
			)
		};
	}

	private paymentAmount(
		payments: Array<{ amount: string | null }>
	): number {
		return payments.reduce((total, payment) => {
			const amount = Number((payment.amount || '').replace(',', '.'));
			return total + (Number.isFinite(amount) ? amount : 0);
		}, 0);
	}

	private formatMoney(value: number): string {
		return new Intl.NumberFormat('ru-RU', {
			style: 'currency',
			currency: 'RUB',
			maximumFractionDigits: 2
		}).format(value);
	}

	private formatAverage(value: number): string {
		return new Intl.NumberFormat('ru-RU', {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1
		}).format(value);
	}

	private formatMoscowDate(date: Date): string {
		return date.toLocaleDateString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		});
	}

	private formatMoscowDateTime(date: Date): string {
		return date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
}
