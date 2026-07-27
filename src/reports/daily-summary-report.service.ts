import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import {
	AuthIdentityType,
	PaymentStatus,
	Role,
	SubscriptionStatus
} from '@prisma/client';

interface DailySummaryPeriod {
	start: Date;
	end: Date;
}

interface DailySummaryStats {
	period: DailySummaryPeriod;
	generatedAtLabel: string;
	totalUsersCount: number;
	usersByRole: {
		user: number;
		admin: number;
		dev: number;
	};
	newUsersCount: number;
	previousDayNewUsersCount: number;
	averageNewUsersCount7d: number;
	succeededPaymentsCount: number;
	succeededPaymentsAmount: number;
	previousDaySucceededPaymentsAmount: number;
	currentMonthSucceededPaymentsAmount: number;
	firstPaymentsCount: number;
	repeatPaymentsCount: number;
	averagePaymentAmount: number | null;
	pendingPaymentsCount: number;
	currentPendingPaymentsCount: number;
	stalePendingPaymentsCount: number;
	cancelledPaymentsCount: number;
	leads: {
		total: number;
		previousDayTotal: number;
		averageTotal7d: number;
		wheel: number;
		quiz: number;
		callback: number;
		countdownTimer: number;
		stopOffer: number;
		onlineConsultant: number;
		calculator: number;
	};
	expiringSubscriptionsTodayCount: number;
	expiringSubscriptions3dCount: number;
	expiringSubscriptionsCount: number;
	expiredActiveSubscriptionsCount: number;
	usersWithoutContactsCount: number;
}

@Injectable()
export class DailySummaryReportService {
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;

	constructor(private readonly prisma: PrismaService) {}

	async render(periodStart: Date, periodEnd: Date): Promise<string> {
		const stats = await this.collectStats({
			start: periodStart,
			end: periodEnd
		});

		return this.buildMessage(stats);
	}

	private async collectStats(
		period: DailySummaryPeriod
	): Promise<DailySummaryStats> {
		const range = {
			gte: period.start,
			lt: period.end
		};
		const now = new Date();
		const dayMs = 24 * 60 * 60 * 1000;
		const previousDayRange = {
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
		const soonEndsAt = new Date(now.getTime() + 7 * dayMs);
		const moscowOffsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedPeriodStart = new Date(
			period.start.getTime() + moscowOffsetMs
		);
		shiftedPeriodStart.setUTCDate(1);
		shiftedPeriodStart.setUTCHours(0, 0, 0, 0);
		const currentMonthStart = new Date(
			shiftedPeriodStart.getTime() - moscowOffsetMs
		);

		const [
			totalUsersCount,
			usersWithUserRoleCount,
			usersWithAdminRoleCount,
			usersWithDevRoleCount,
			newUsersCount,
			previousDayNewUsersCount,
			newUsersCount7d,
			succeededPayments,
			previousDaySucceededPayments,
			currentMonthSucceededPayments,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			stalePendingPaymentsCount,
			cancelledPaymentsCount,
			wheelLeadsCount,
			quizLeadsCount,
			callbackLeadsCount,
			countdownTimerLeadsCount,
			stopOfferLeadsCount,
			onlineConsultantLeadsCount,
			calculatorLeadsCount,
			previousDayWheelLeadsCount,
			previousDayQuizLeadsCount,
			previousDayCallbackLeadsCount,
			previousDayCountdownTimerLeadsCount,
			previousDayStopOfferLeadsCount,
			previousDayOnlineConsultantLeadsCount,
			previousDayCalculatorLeadsCount,
			wheelLeadsCount7d,
			quizLeadsCount7d,
			callbackLeadsCount7d,
			countdownTimerLeadsCount7d,
			stopOfferLeadsCount7d,
			onlineConsultantLeadsCount7d,
			calculatorLeadsCount7d,
			expiringSubscriptionsTodayCount,
			expiringSubscriptions3dCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutContactsCount
		] = await Promise.all([
			this.prisma.user.count({
				where: { deletedAt: null }
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					rights: { has: Role.USER }
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					rights: { has: Role.ADMIN }
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					rights: { has: Role.DEV }
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					createdAt: range
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					createdAt: previousDayRange
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					createdAt: last7DaysRange
				}
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: range
				},
				select: { amount: true, userId: true, updatedAt: true },
				orderBy: { updatedAt: 'asc' }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: previousDayRange
				},
				select: { amount: true }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: {
						gte: currentMonthStart,
						lt: period.end
					}
				},
				select: { amount: true }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.PENDING,
					createdAt: range
				}
			}),
			this.prisma.payment.count({
				where: { status: PaymentStatus.PENDING }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.PENDING,
					createdAt: { lt: stalePendingBefore }
				}
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.CANCELLED,
					updatedAt: range
				}
			}),
			this.prisma.lead.count({ where: { createdAt: range } }),
			this.prisma.quizLead.count({ where: { createdAt: range } }),
			this.prisma.callbackLead.count({ where: { createdAt: range } }),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: range }
			}),
			this.prisma.stopOfferLead.count({ where: { createdAt: range } }),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: range }
			}),
			this.prisma.calculatorLead.count({ where: { createdAt: range } }),
			this.prisma.lead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.quizLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.callbackLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.stopOfferLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.calculatorLead.count({
				where: { createdAt: previousDayRange }
			}),
			this.prisma.lead.count({ where: { createdAt: last7DaysRange } }),
			this.prisma.quizLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.callbackLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.stopOfferLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.calculatorLead.count({
				where: { createdAt: last7DaysRange }
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: { gte: now, lt: todayEndsAt }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: { gte: now, lt: soonEndsAt3d }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: {
						gte: now,
						lt: soonEndsAt
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: {
						lt: now
					}
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					authIdentities: {
						none: {
							type: {
								in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
							}
						}
					}
				}
			})
		]);

		const leadsTotal =
			wheelLeadsCount +
			quizLeadsCount +
			callbackLeadsCount +
			countdownTimerLeadsCount +
			stopOfferLeadsCount +
			onlineConsultantLeadsCount +
			calculatorLeadsCount;
		const previousDayLeadsTotal =
			previousDayWheelLeadsCount +
			previousDayQuizLeadsCount +
			previousDayCallbackLeadsCount +
			previousDayCountdownTimerLeadsCount +
			previousDayStopOfferLeadsCount +
			previousDayOnlineConsultantLeadsCount +
			previousDayCalculatorLeadsCount;
		const leadsTotal7d =
			wheelLeadsCount7d +
			quizLeadsCount7d +
			callbackLeadsCount7d +
			countdownTimerLeadsCount7d +
			stopOfferLeadsCount7d +
			onlineConsultantLeadsCount7d +
			calculatorLeadsCount7d;
		const currentPaymentUserIds = [
			...new Set(succeededPayments.map(payment => payment.userId))
		];
		const usersWithPreviousPayments = currentPaymentUserIds.length
			? await this.prisma.payment.findMany({
					where: {
						status: PaymentStatus.SUCCEEDED,
						updatedAt: { lt: period.start },
						userId: { in: currentPaymentUserIds }
					},
					select: { userId: true },
					distinct: ['userId']
				})
			: [];
		const usersWithPreviousPaymentIds = new Set(
			usersWithPreviousPayments.map(payment => payment.userId)
		);
		let firstPaymentsCount = 0;
		let repeatPaymentsCount = 0;

		for (const payment of succeededPayments) {
			if (usersWithPreviousPaymentIds.has(payment.userId)) {
				repeatPaymentsCount += 1;
				continue;
			}

			firstPaymentsCount += 1;
			usersWithPreviousPaymentIds.add(payment.userId);
		}

		const succeededPaymentsAmount =
			this.getPaymentsAmount(succeededPayments);

		return {
			period,
			generatedAtLabel: this.formatMoscowDateTime(new Date()),
			totalUsersCount,
			usersByRole: {
				user: usersWithUserRoleCount,
				admin: usersWithAdminRoleCount,
				dev: usersWithDevRoleCount
			},
			newUsersCount,
			previousDayNewUsersCount,
			averageNewUsersCount7d: newUsersCount7d / 7,
			succeededPaymentsCount: succeededPayments.length,
			succeededPaymentsAmount,
			previousDaySucceededPaymentsAmount: this.getPaymentsAmount(
				previousDaySucceededPayments
			),
			currentMonthSucceededPaymentsAmount: this.getPaymentsAmount(
				currentMonthSucceededPayments
			),
			firstPaymentsCount,
			repeatPaymentsCount,
			averagePaymentAmount: succeededPayments.length
				? succeededPaymentsAmount / succeededPayments.length
				: null,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			stalePendingPaymentsCount,
			cancelledPaymentsCount,
			leads: {
				total: leadsTotal,
				previousDayTotal: previousDayLeadsTotal,
				averageTotal7d: leadsTotal7d / 7,
				wheel: wheelLeadsCount,
				quiz: quizLeadsCount,
				callback: callbackLeadsCount,
				countdownTimer: countdownTimerLeadsCount,
				stopOffer: stopOfferLeadsCount,
				onlineConsultant: onlineConsultantLeadsCount,
				calculator: calculatorLeadsCount
			},
			expiringSubscriptionsTodayCount,
			expiringSubscriptions3dCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutContactsCount
		};
	}

	private buildMessage(stats: DailySummaryStats): string {
		return [
			'<b>Ежедневная сводка WinWidget</b>',
			`${this.formatMoscowDate(stats.period.start)} · МСК`,
			'',
			'<b>Итоги дня</b>',
			`👤 Регистрации: ${stats.newUsersCount} (вчера: ${stats.previousDayNewUsersCount} · среднее за 7 дней: ${this.formatAverage(stats.averageNewUsersCount7d)})`,
			`💳 Выручка: ${this.formatMoney(stats.succeededPaymentsAmount)} (вчера: ${this.formatMoney(stats.previousDaySucceededPaymentsAmount)} · за месяц: ${this.formatMoney(stats.currentMonthSucceededPaymentsAmount)})`,
			`🎯 Лиды: ${stats.leads.total} (вчера: ${stats.leads.previousDayTotal} · среднее за 7 дней: ${this.formatAverage(stats.leads.averageTotal7d)})`,
			'',
			'<b>Пользователи</b>',
			`- Всего: ${stats.totalUsersCount}`,
			`- С ролью USER: ${stats.usersByRole.user}`,
			`- С ролью ADMIN: ${stats.usersByRole.admin}`,
			`- С ролью DEV: ${stats.usersByRole.dev}`,
			'',
			'<b>Платежи</b>',
			`- Успешные: ${stats.succeededPaymentsCount}`,
			`- Первые оплаты: ${stats.firstPaymentsCount}`,
			`- Повторные оплаты: ${stats.repeatPaymentsCount}`,
			`- Средний чек: ${stats.averagePaymentAmount === null ? '—' : this.formatMoney(stats.averagePaymentAmount)}`,
			`- Создано pending: ${stats.pendingPaymentsCount}`,
			`- Pending сейчас: ${stats.currentPendingPaymentsCount}`,
			`- Отменённые: ${stats.cancelledPaymentsCount}`,
			'',
			'<b>Лиды</b>',
			`- Всего: ${stats.leads.total}`,
			`- Колесо: ${stats.leads.wheel}`,
			`- Квизы: ${stats.leads.quiz}`,
			`- Обратный звонок: ${stats.leads.callback}`,
			`- Таймеры: ${stats.leads.countdownTimer}`,
			`- Стоп-офферы: ${stats.leads.stopOffer}`,
			`- Онлайн-консультанты: ${stats.leads.onlineConsultant}`,
			`- Калькуляторы стоимости: ${stats.leads.calculator}`,
			'',
			'<b>Подписки</b>',
			`- Истекают в ближайшие 24 часа: ${stats.expiringSubscriptionsTodayCount}`,
			`- Истекают в ближайшие 3 дня: ${stats.expiringSubscriptions3dCount}`,
			`- Истекают в ближайшие 7 дней: ${stats.expiringSubscriptionsCount}`,
			`- Истекли, но ещё ACTIVE: ${stats.expiredActiveSubscriptionsCount}`,
			'',
			'<b>Требует внимания</b>',
			`- Pending более 24 часов: ${stats.stalePendingPaymentsCount}${stats.stalePendingPaymentsCount ? ' ⚠️' : ''}`,
			`- Всего пользователей без email и телефона: ${stats.usersWithoutContactsCount}${stats.usersWithoutContactsCount ? ' ⚠️' : ''}`,
			`- Просроченные ACTIVE-подписки: ${stats.expiredActiveSubscriptionsCount}${stats.expiredActiveSubscriptionsCount ? ' ⚠️' : ''}`,
			'',
			`Сформировано: ${stats.generatedAtLabel} МСК`
		].join('\n');
	}

	private getPaymentsAmount(payments: Array<{ amount: string }>): number {
		return payments.reduce(
			(total, payment) => total + this.parsePaymentAmount(payment.amount),
			0
		);
	}

	private parsePaymentAmount(value: string): number {
		const amount = Number(value.replace(',', '.'));
		return Number.isFinite(amount) ? amount : 0;
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
