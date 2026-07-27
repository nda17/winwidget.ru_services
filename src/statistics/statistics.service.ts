import { PrismaService } from '@/prisma.service';
import { Injectable } from '@nestjs/common';
import {
	AuthIdentityType,
	PaymentStatus,
	Plan,
	Role,
	SubscriptionStatus
} from '@prisma/client';
import * as dayjs from 'dayjs';

@Injectable()
export class StatisticsService {
	constructor(private prisma: PrismaService) {}

	async getDashboard() {
		const now = new Date();
		const todayStart = this.startOfDay(now);
		const tomorrowStart = this.addDays(todayStart, 1);
		const last30DaysStart = this.addDays(now, -30);
		const previous30DaysStart = this.addDays(now, -60);
		const currentMonthStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			1
		);
		const firstRevenueMonthStart = new Date(
			now.getFullYear(),
			now.getMonth() - 11,
			1
		);
		const expiresIn3Days = this.addDays(now, 3);
		const expiresIn7Days = this.addDays(now, 7);
		const leadDayPeriods = this.generateDayPeriods(30, now);
		const revenueMonthPeriods = this.generateMonthPeriods(12, now);

		const [
			totalUsers,
			activeUsers30d,
			newUsers30d,
			adminUsers,
			usersWithoutEmail,
			usersWithoutPhone,
			usersWithoutContacts,
			telegramLinkedUsers,
			succeededPaymentsAll,
			succeededPayments30d,
			succeededPaymentsCurrentMonth,
			succeededPaymentsForRevenueChart,
			pendingPaymentsCurrent,
			cancelledPayments30d,
			activeSubscriptions,
			paidActiveSubscriptions,
			trialActiveSubscriptions,
			expiringSubscriptionsToday,
			expiringSubscriptions3d,
			expiringSubscriptions7d,
			expiredActiveSubscriptions,
			subscriptionsByPlan,
			subscriptionsByStatus,
			wheelLeads30d,
			quizLeads30d,
			callbackLeads30d,
			countdownTimerLeads30d,
			stopOfferLeads30d,
			onlineConsultantLeads30d,
			calculatorLeads30d,
			wheelLeadsPrevious30d,
			quizLeadsPrevious30d,
			callbackLeadsPrevious30d,
			countdownTimerLeadsPrevious30d,
			stopOfferLeadsPrevious30d,
			onlineConsultantLeadsPrevious30d,
			calculatorLeadsPrevious30d,
			wheelLeadsToday,
			quizLeadsToday,
			callbackLeadsToday,
			countdownTimerLeadsToday,
			stopOfferLeadsToday,
			onlineConsultantLeadsToday,
			calculatorLeadsToday,
			wheelLeadsAllTime,
			quizLeadsAllTime,
			callbackLeadsAllTime,
			countdownTimerLeadsAllTime,
			stopOfferLeadsAllTime,
			onlineConsultantLeadsAllTime,
			calculatorLeadsAllTime,
			wheelLeadDates,
			quizLeadDates,
			callbackLeadDates,
			countdownTimerLeadDates,
			stopOfferLeadDates,
			onlineConsultantLeadDates,
			calculatorLeadDates,
			wheelWidgetStats,
			quizWidgetStats,
			callbackWidgetStats,
			countdownTimerWidgetStats,
			stopOfferWidgetStats,
			onlineConsultantWidgetStats,
			calculatorWidgetStats
		] = await Promise.all([
			this.prisma.user.count({
				where: { deletedAt: null }
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					updatedAt: { gte: last30DaysStart }
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					createdAt: { gte: last30DaysStart }
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
					authIdentities: {
						none: { type: AuthIdentityType.EMAIL }
					}
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					authIdentities: {
						none: { type: AuthIdentityType.PHONE }
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
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					authIdentities: {
						some: { type: AuthIdentityType.TELEGRAM }
					}
				}
			}),
			this.prisma.payment.findMany({
				where: { status: PaymentStatus.SUCCEEDED },
				select: { amount: true, userId: true }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: { gte: last30DaysStart }
				},
				select: { amount: true, userId: true }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: { gte: currentMonthStart }
				},
				select: { amount: true }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: { gte: firstRevenueMonthStart }
				},
				select: {
					amount: true,
					updatedAt: true
				}
			}),
			this.prisma.payment.count({
				where: { status: PaymentStatus.PENDING }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.CANCELLED,
					updatedAt: { gte: last30DaysStart }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					plan: { in: [Plan.EASY, Plan.HARD] },
					user: { deletedAt: null }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					plan: Plan.TRIAL,
					user: { deletedAt: null }
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: {
						gte: now,
						lt: expiresIn3Days
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: {
						gte: now,
						lt: expiresIn7Days
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null },
					expiresAt: { lt: now }
				}
			}),
			this.prisma.subscription.groupBy({
				by: ['plan'],
				_count: true,
				where: {
					status: SubscriptionStatus.ACTIVE,
					user: { deletedAt: null }
				}
			}),
			this.prisma.subscription.groupBy({
				by: ['status'],
				_count: true,
				where: {
					user: { deletedAt: null }
				}
			}),
			this.prisma.lead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.quizLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.callbackLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.stopOfferLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.onlineConsultantLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.calculatorLead.count({
				where: { createdAt: { gte: last30DaysStart } }
			}),
			this.prisma.lead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.quizLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.callbackLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.countdownTimerLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.stopOfferLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.onlineConsultantLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.calculatorLead.count({
				where: {
					createdAt: {
						gte: previous30DaysStart,
						lt: last30DaysStart
					}
				}
			}),
			this.prisma.lead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.quizLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.callbackLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.countdownTimerLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.stopOfferLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.onlineConsultantLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.calculatorLead.count({
				where: {
					createdAt: {
						gte: todayStart,
						lt: tomorrowStart
					}
				}
			}),
			this.prisma.lead.count(),
			this.prisma.quizLead.count(),
			this.prisma.callbackLead.count(),
			this.prisma.countdownTimerLead.count(),
			this.prisma.stopOfferLead.count(),
			this.prisma.onlineConsultantLead.count(),
			this.prisma.calculatorLead.count(),
			this.prisma.lead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.quizLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.callbackLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.countdownTimerLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.stopOfferLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.onlineConsultantLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.prisma.calculatorLead.findMany({
				where: { createdAt: { gte: leadDayPeriods[0].start } },
				select: { createdAt: true }
			}),
			this.getWidgetStats('wheel', last30DaysStart),
			this.getWidgetStats('quiz', last30DaysStart),
			this.getWidgetStats('callback', last30DaysStart),
			this.getWidgetStats('countdownTimer', last30DaysStart),
			this.getWidgetStats('stopOffer', last30DaysStart),
			this.getWidgetStats('onlineConsultant', last30DaysStart),
			this.getWidgetStats('calculator', last30DaysStart)
		]);

		const revenue30d = this.getPaymentsAmount(succeededPayments30d);
		const totalLeads30d =
			wheelLeads30d +
			quizLeads30d +
			callbackLeads30d +
			countdownTimerLeads30d +
			stopOfferLeads30d +
			onlineConsultantLeads30d +
			calculatorLeads30d;
		const previousLeads30d =
			wheelLeadsPrevious30d +
			quizLeadsPrevious30d +
			callbackLeadsPrevious30d +
			countdownTimerLeadsPrevious30d +
			stopOfferLeadsPrevious30d +
			onlineConsultantLeadsPrevious30d +
			calculatorLeadsPrevious30d;
		const totalLeadsToday =
			wheelLeadsToday +
			quizLeadsToday +
			callbackLeadsToday +
			countdownTimerLeadsToday +
			stopOfferLeadsToday +
			onlineConsultantLeadsToday +
			calculatorLeadsToday;
		const totalLeadsAllTime =
			wheelLeadsAllTime +
			quizLeadsAllTime +
			callbackLeadsAllTime +
			countdownTimerLeadsAllTime +
			stopOfferLeadsAllTime +
			onlineConsultantLeadsAllTime +
			calculatorLeadsAllTime;
		const widgetStats = [
			wheelWidgetStats,
			quizWidgetStats,
			callbackWidgetStats,
			countdownTimerWidgetStats,
			stopOfferWidgetStats,
			onlineConsultantWidgetStats,
			calculatorWidgetStats
		];

		return {
			generatedAt: now.toISOString(),
			finance: {
				revenueAllTime: this.getPaymentsAmount(succeededPaymentsAll),
				revenue30d,
				revenueCurrentMonth: this.getPaymentsAmount(
					succeededPaymentsCurrentMonth
				),
				succeededPayments30d: succeededPayments30d.length,
				pendingPaymentsCurrent,
				cancelledPayments30d,
				averageCheck30d: succeededPayments30d.length
					? revenue30d / succeededPayments30d.length
					: 0,
				payingUsersTotal: this.countUniqueValues(
					succeededPaymentsAll.map(payment => payment.userId)
				),
				payingUsers30d: this.countUniqueValues(
					succeededPayments30d.map(payment => payment.userId)
				)
			},
			subscriptions: {
				active: activeSubscriptions,
				paidActive: paidActiveSubscriptions,
				trialActive: trialActiveSubscriptions,
				expiringToday: expiringSubscriptionsToday,
				expiring3d: expiringSubscriptions3d,
				expiring7d: expiringSubscriptions7d,
				expiredActive: expiredActiveSubscriptions,
				byPlan: this.fillPlanStats(subscriptionsByPlan),
				byStatus: this.fillSubscriptionStatusStats(subscriptionsByStatus)
			},
			leads: {
				total30d: totalLeads30d,
				previous30d: previousLeads30d,
				growth30d: this.getGrowthPercent(totalLeads30d, previousLeads30d),
				today: totalLeadsToday,
				allTime: totalLeadsAllTime,
				byType30d: [
					{ type: 'wheel', label: 'Колесо', count: wheelLeads30d },
					{ type: 'quiz', label: 'Квизы', count: quizLeads30d },
					{
						type: 'callback',
						label: 'Обратный звонок',
						count: callbackLeads30d
					},
					{
						type: 'countdownTimer',
						label: 'Таймеры',
						count: countdownTimerLeads30d
					},
					{
						type: 'stopOffer',
						label: 'Стоп-офферы',
						count: stopOfferLeads30d
					},
					{
						type: 'onlineConsultant',
						label: 'Онлайн-консультанты',
						count: onlineConsultantLeads30d
					},
					{
						type: 'calculator',
						label: 'Калькуляторы стоимости',
						count: calculatorLeads30d
					}
				],
				byDay: this.buildLeadDayStats(leadDayPeriods, {
					wheel: wheelLeadDates,
					quiz: quizLeadDates,
					callback: callbackLeadDates,
					countdownTimer: countdownTimerLeadDates,
					stopOffer: stopOfferLeadDates,
					onlineConsultant: onlineConsultantLeadDates,
					calculator: calculatorLeadDates
				})
			},
			widgets: {
				total: widgetStats.reduce((sum, item) => sum + item.total, 0),
				active: widgetStats.reduce((sum, item) => sum + item.active, 0),
				inactive: widgetStats.reduce(
					(sum, item) => sum + item.inactive,
					0
				),
				withoutDomain: widgetStats.reduce(
					(sum, item) => sum + item.withoutDomain,
					0
				),
				activeWithoutDomain: widgetStats.reduce(
					(sum, item) => sum + item.activeWithoutDomain,
					0
				),
				new30d: widgetStats.reduce((sum, item) => sum + item.new30d, 0),
				byType: widgetStats
			},
			users: {
				total: totalUsers,
				publicTotal: Math.max(totalUsers - adminUsers, 0),
				active30d: activeUsers30d,
				new30d: newUsers30d,
				admins: adminUsers,
				withoutEmail: usersWithoutEmail,
				withoutPhone: usersWithoutPhone,
				withoutContacts: usersWithoutContacts,
				telegramLinked: telegramLinkedUsers
			},
			charts: {
				revenueByMonth: this.buildRevenueMonthStats(
					revenueMonthPeriods,
					succeededPaymentsForRevenueChart
				)
			}
		};
	}

	async getUserRegistrationsByMonth() {
		const currentMonth = new Date().getMonth();
		const currentYear = new Date().getFullYear();
		const startDate = new Date(currentYear - 1, currentMonth + 1, 1);
		const endDate = new Date(currentYear, currentMonth + 1, 0);
		const allMonths = this.generateMonths(startDate, endDate);

		const registrations = await this.prisma.user.groupBy({
			by: ['createdAt'],
			_count: true,
			orderBy: {
				createdAt: 'asc'
			},
			where: {
				deletedAt: null,
				createdAt: {
					gte: startDate,
					lte: endDate
				}
			}
		});

		const registrationMap = new Map<string, number>();

		for (const reg of registrations) {
			const month = reg.createdAt.getMonth() + 1;
			const year = reg.createdAt.getFullYear();
			const key = `${year}-${month}`;
			registrationMap.set(
				key,
				(registrationMap.get(key) ?? 0) + reg._count
			);
		}

		return allMonths.map(({ month, year }) => {
			const key = `${year}-${month}`;
			const monthName = dayjs(new Date(year, month - 1)).format('MMMM');
			return {
				month: monthName,
				year,
				count: registrationMap.get(key) || 0
			};
		});
	}

	async getOverview() {
		const monthAgo = new Date(
			new Date().setDate(new Date().getDate() - 30)
		);
		const [
			totalUsers,
			activeUsers30d,
			newUsers30d,
			usersWithAuthIdentities,
			adminUsers
		] = await Promise.all([
			this.prisma.user.count({
				where: { deletedAt: null }
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					updatedAt: { gte: monthAgo }
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					createdAt: { gte: monthAgo }
				}
			}),
			this.prisma.user.findMany({
				where: {
					deletedAt: null
				},
				select: {
					authIdentities: {
						select: {
							type: true,
							verifiedAt: true
						}
					}
				}
			}),
			this.prisma.user.count({
				where: {
					deletedAt: null,
					rights: { has: Role.ADMIN }
				}
			})
		]);
		const usersWithMultipleLoginMethods = usersWithAuthIdentities.reduce(
			(total, user) => {
				const loginMethods = user.authIdentities.filter(identity => {
					if (identity.type === AuthIdentityType.PHONE) {
						return Boolean(identity.verifiedAt);
					}

					return (
						identity.type === AuthIdentityType.EMAIL ||
						identity.type === AuthIdentityType.GOOGLE ||
						identity.type === AuthIdentityType.GITHUB ||
						identity.type === AuthIdentityType.TELEGRAM
					);
				});

				return total + (loginMethods.length >= 2 ? 1 : 0);
			},
			0
		);

		return {
			totalUsers,
			activeUsers30d,
			newUsers30d,
			multiLoginUsers: usersWithMultipleLoginMethods,
			adminUsers
		};
	}

	private generateMonths(
		start: Date,
		end: Date
	): { month: number; year: number }[] {
		const current = new Date(start);
		const endMonth = new Date(end);
		const months = [];

		while (current < endMonth) {
			months.push({
				month: current.getMonth() + 1,
				year: current.getFullYear()
			});
			current.setMonth(current.getMonth() + 1);
		}

		months.push({
			month: endMonth.getMonth() + 1,
			year: endMonth.getFullYear()
		});

		return months;
	}

	private async getWidgetStats(
		type:
			| 'wheel'
			| 'quiz'
			| 'callback'
			| 'countdownTimer'
			| 'stopOffer'
			| 'onlineConsultant'
			| 'calculator',
		since: Date
	) {
		const getStats = async (model: {
			count: (args?: Record<string, unknown>) => Promise<number>;
		}) => {
			const [
				total,
				active,
				inactive,
				withoutDomain,
				activeWithoutDomain,
				new30d
			] = await Promise.all([
				model.count(),
				model.count({ where: { isActive: true } }),
				model.count({ where: { isActive: false } }),
				model.count({ where: { installDomain: '' } }),
				model.count({
					where: { isActive: true, installDomain: '' }
				}),
				model.count({ where: { createdAt: { gte: since } } })
			]);

			return {
				total,
				active,
				inactive,
				withoutDomain,
				activeWithoutDomain,
				new30d
			};
		};

		const stats =
			type === 'wheel'
				? await getStats(this.prisma.widget)
				: type === 'quiz'
					? await getStats(this.prisma.quiz)
					: type === 'callback'
						? await getStats(this.prisma.callback)
						: type === 'countdownTimer'
							? await getStats(this.prisma.countdownTimer)
							: type === 'stopOffer'
								? await getStats(this.prisma.stopOffer)
								: type === 'onlineConsultant'
									? await getStats(this.prisma.onlineConsultant)
									: await getStats(this.prisma.calculator);

		return {
			type,
			label: this.getWidgetTypeLabel(type),
			...stats
		};
	}

	private buildLeadDayStats(
		periods: Array<{
			date: string;
			label: string;
			start: Date;
		}>,
		leadDates: Record<
			| 'wheel'
			| 'quiz'
			| 'callback'
			| 'countdownTimer'
			| 'stopOffer'
			| 'onlineConsultant'
			| 'calculator',
			Array<{ createdAt: Date }>
		>
	) {
		const wheelMap = this.buildDateCountMap(leadDates.wheel);
		const quizMap = this.buildDateCountMap(leadDates.quiz);
		const callbackMap = this.buildDateCountMap(leadDates.callback);
		const countdownTimerMap = this.buildDateCountMap(
			leadDates.countdownTimer
		);
		const stopOfferMap = this.buildDateCountMap(leadDates.stopOffer);
		const onlineConsultantMap = this.buildDateCountMap(
			leadDates.onlineConsultant
		);
		const calculatorMap = this.buildDateCountMap(leadDates.calculator);

		return periods.map(period => {
			const wheel = wheelMap.get(period.date) ?? 0;
			const quiz = quizMap.get(period.date) ?? 0;
			const callback = callbackMap.get(period.date) ?? 0;
			const countdownTimer = countdownTimerMap.get(period.date) ?? 0;
			const stopOffer = stopOfferMap.get(period.date) ?? 0;
			const onlineConsultant = onlineConsultantMap.get(period.date) ?? 0;
			const calculator = calculatorMap.get(period.date) ?? 0;

			return {
				date: period.date,
				label: period.label,
				wheel,
				quiz,
				callback,
				countdownTimer,
				stopOffer,
				onlineConsultant,
				calculator,
				total:
					wheel +
					quiz +
					callback +
					countdownTimer +
					stopOffer +
					onlineConsultant +
					calculator
			};
		});
	}

	private buildRevenueMonthStats(
		periods: Array<{
			periodKey: string;
			label: string;
		}>,
		payments: Array<{ amount: string; updatedAt: Date }>
	) {
		const statsMap = new Map(
			periods.map(period => [
				period.periodKey,
				{
					revenue: 0,
					payments: 0
				}
			])
		);

		for (const payment of payments) {
			const periodKey = this.formatMonthKey(payment.updatedAt);
			const periodStats = statsMap.get(periodKey);

			if (!periodStats) {
				continue;
			}

			periodStats.revenue += this.parsePaymentAmount(payment.amount);
			periodStats.payments += 1;
		}

		return periods.map(period => {
			const stats = statsMap.get(period.periodKey);

			return {
				...period,
				revenue: stats?.revenue ?? 0,
				payments: stats?.payments ?? 0
			};
		});
	}

	private fillPlanStats(items: Array<{ plan: Plan; _count: number }>) {
		const counts = new Map(items.map(item => [item.plan, item._count]));

		return [Plan.TRIAL, Plan.EASY, Plan.HARD].map(plan => ({
			plan,
			label: this.getPlanLabel(plan),
			count: counts.get(plan) ?? 0
		}));
	}

	private fillSubscriptionStatusStats(
		items: Array<{ status: SubscriptionStatus; _count: number }>
	) {
		const counts = new Map(items.map(item => [item.status, item._count]));

		return [
			SubscriptionStatus.ACTIVE,
			SubscriptionStatus.EXPIRED,
			SubscriptionStatus.CANCELLED
		].map(status => ({
			status,
			label: this.getSubscriptionStatusLabel(status),
			count: counts.get(status) ?? 0
		}));
	}

	private buildDateCountMap(items: Array<{ createdAt: Date }>) {
		const map = new Map<string, number>();

		for (const item of items) {
			const key = this.formatDateKey(item.createdAt);
			map.set(key, (map.get(key) ?? 0) + 1);
		}

		return map;
	}

	private generateDayPeriods(days: number, endDate: Date) {
		const endDayStart = this.startOfDay(endDate);

		return Array.from({ length: days }, (_, index) => {
			const date = this.addDays(endDayStart, index - days + 1);

			return {
				date: this.formatDateKey(date),
				label: this.formatDayLabel(date),
				start: date
			};
		});
	}

	private generateMonthPeriods(months: number, endDate: Date) {
		const currentMonthStart = new Date(
			endDate.getFullYear(),
			endDate.getMonth(),
			1
		);

		return Array.from({ length: months }, (_, index) => {
			const date = new Date(
				currentMonthStart.getFullYear(),
				currentMonthStart.getMonth() + index - months + 1,
				1
			);

			return {
				periodKey: this.formatMonthKey(date),
				label: this.formatMonthLabel(date)
			};
		});
	}

	private getPaymentsAmount(payments: Array<{ amount: string }>) {
		return payments.reduce(
			(total, payment) => total + this.parsePaymentAmount(payment.amount),
			0
		);
	}

	private parsePaymentAmount(value: string) {
		const amount = Number(value.replace(',', '.'));
		return Number.isFinite(amount) ? amount : 0;
	}

	private getGrowthPercent(current: number, previous: number) {
		if (previous <= 0) {
			return current > 0 ? null : 0;
		}

		return ((current - previous) / previous) * 100;
	}

	private countUniqueValues(values: string[]) {
		return new Set(values).size;
	}

	private startOfDay(value: Date) {
		return new Date(
			value.getFullYear(),
			value.getMonth(),
			value.getDate()
		);
	}

	private addDays(value: Date, days: number) {
		const date = new Date(value);
		date.setDate(date.getDate() + days);
		return date;
	}

	private formatDateKey(value: Date) {
		const month = `${value.getMonth() + 1}`.padStart(2, '0');
		const day = `${value.getDate()}`.padStart(2, '0');

		return `${value.getFullYear()}-${month}-${day}`;
	}

	private formatMonthKey(value: Date) {
		const month = `${value.getMonth() + 1}`.padStart(2, '0');

		return `${value.getFullYear()}-${month}`;
	}

	private formatDayLabel(value: Date) {
		return new Intl.DateTimeFormat('ru-RU', {
			day: '2-digit',
			month: 'short'
		}).format(value);
	}

	private formatMonthLabel(value: Date) {
		return new Intl.DateTimeFormat('ru-RU', {
			month: 'short',
			year: 'numeric'
		}).format(value);
	}

	private getPlanLabel(plan: Plan) {
		const labels: Record<Plan, string> = {
			TRIAL: 'Trial',
			EASY: 'Easy',
			HARD: 'Hard'
		};

		return labels[plan];
	}

	private getSubscriptionStatusLabel(status: SubscriptionStatus) {
		const labels: Record<SubscriptionStatus, string> = {
			ACTIVE: 'Активные',
			EXPIRED: 'Истекшие',
			CANCELLED: 'Отменённые'
		};

		return labels[status];
	}

	private getWidgetTypeLabel(
		type:
			| 'wheel'
			| 'quiz'
			| 'callback'
			| 'countdownTimer'
			| 'stopOffer'
			| 'onlineConsultant'
			| 'calculator'
	) {
		const labels = {
			wheel: 'Колесо',
			quiz: 'Квизы',
			callback: 'Обратный звонок',
			countdownTimer: 'Таймеры',
			stopOffer: 'Стоп-офферы',
			onlineConsultant: 'Онлайн-консультанты',
			calculator: 'Калькуляторы стоимости'
		};

		return labels[type];
	}
}
