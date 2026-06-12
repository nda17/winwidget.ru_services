import { PrismaService } from '@/prisma.service';
import type { AdminBonusAudience } from '@/subscription/dto/admin-activate-subscription.dto';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
	BillingPeriod,
	Plan,
	Prisma,
	Subscription,
	SubscriptionBonusAudience,
	SubscriptionHistoryAction,
	SubscriptionStatus
} from '@prisma/client';
import * as dayjs from 'dayjs';

const BONUS_AUDIENCE_LABELS: Record<AdminBonusAudience, string> = {
	SINGLE: 'Выбранный пользователь',
	ACTIVE_SUBSCRIPTION: 'Все активные пользователи',
	INACTIVE_SUBSCRIPTION: 'Все неактивные пользователи',
	ALL: 'Все пользователи'
};

interface AdminExtendSubscriptionDaysInput {
	userId?: string;
	days: number;
	adminId: string;
	audience?: AdminBonusAudience;
}

export interface AdminExtendSubscriptionDaysResult {
	audience: AdminBonusAudience;
	audienceLabel: string;
	affectedUsersCount: number;
	historyId: string;
	subscription?: Subscription;
}

export interface AdminSubscriptionFilters {
	plan?: string;
	status?: string;
	billingPeriod?: string;
	expiresFrom?: string;
	expiresTo?: string;
}

export interface AdminSubscriptionHistoryFilters {
	audience?: string;
	adminId?: string;
	createdFrom?: string;
	createdTo?: string;
}

@Injectable()
export class SubscriptionService {
	constructor(private prisma: PrismaService) {}

	async getOrCreateTrialSubscription(userId: string) {
		const existing = await this.prisma.subscription.findUnique({
			where: { userId }
		});

		if (existing) return existing;

		return this.prisma.subscription.create({
			data: {
				userId,
				plan: Plan.TRIAL,
				status: SubscriptionStatus.ACTIVE,
				expiresAt: dayjs().add(7, 'day').toDate()
			}
		});
	}

	async getSubscription(userId: string) {
		return this.prisma.subscription.findUnique({
			where: { userId }
		});
	}

	async createOrUpgradeSubscription(
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		const now = dayjs();
		const addPeriod = (base: dayjs.Dayjs) =>
			billingPeriod === BillingPeriod.YEARLY
				? base.add(1, 'year')
				: base.add(1, 'month');

		const existing = await this.prisma.subscription.findUnique({
			where: { userId }
		});

		const isActiveSub =
			existing &&
			existing.status === SubscriptionStatus.ACTIVE &&
			existing.expiresAt != null;

		const isSamePlan = isActiveSub && existing.plan === plan;

		// Same plan: extend from current expiresAt
		// Upgrade/downgrade: add new period from now + carry over remaining days
		let base: dayjs.Dayjs;
		if (isSamePlan) {
			base = dayjs(existing.expiresAt);
		} else if (isActiveSub && dayjs(existing.expiresAt).isAfter(now)) {
			const remainingDays = dayjs(existing.expiresAt).diff(now, 'day');
			base = now.add(remainingDays, 'day');
		} else {
			base = now;
		}

		const expiresAt = addPeriod(base).toDate();
		const periodResetsAt = now.add(1, 'month').toDate();

		return this.prisma.subscription.upsert({
			where: { userId },
			update: {
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: isActiveSub ? existing.startsAt : now.toDate(),
				expiresAt,
				leadsThisPeriod: 0,
				periodResetsAt
			},
			create: {
				userId,
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: now.toDate(),
				expiresAt,
				leadsThisPeriod: 0,
				periodResetsAt
			}
		});
	}

	async checkAndResetPeriod(userId: string) {
		const sub = await this.getSubscription(userId);
		if (!sub) return sub;

		const now = dayjs();

		// Expire subscription if past expiresAt (applies to all plans including TRIAL)
		if (sub.expiresAt && now.isAfter(sub.expiresAt)) {
			return this.prisma.subscription.update({
				where: { userId },
				data: { status: SubscriptionStatus.EXPIRED }
			});
		}

		// Reset monthly lead counter only for non-TRIAL plans
		if (
			sub.plan !== Plan.TRIAL &&
			sub.periodResetsAt &&
			now.isAfter(sub.periodResetsAt)
		) {
			const nextReset = dayjs(sub.periodResetsAt).add(1, 'month').toDate();
			return this.prisma.subscription.update({
				where: { userId },
				data: {
					leadsThisPeriod: 0,
					periodResetsAt: nextReset
				}
			});
		}

		return sub;
	}

	async isWidgetAllowed(
		userId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const sub = await this.checkAndResetPeriod(userId);
		if (!sub) return { allowed: false, reason: 'no_subscription' };

		if (sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];
		const [
			widgetCount,
			quizCount,
			callbackCount,
			countdownTimerCount,
			stopOfferCount,
			onlineConsultantCount
		] = await Promise.all([
			this.prisma.widget.count({ where: { userId } }),
			this.prisma.quiz.count({ where: { userId } }),
			this.prisma.callback.count({ where: { userId } }),
			this.prisma.countdownTimer.count({ where: { userId } }),
			this.prisma.stopOffer.count({ where: { userId } }),
			this.prisma.onlineConsultant.count({ where: { userId } })
		]);

		if (
			widgetCount +
				quizCount +
				callbackCount +
				countdownTimerCount +
				stopOfferCount +
				onlineConsultantCount >=
			limits.maxWidgets
		) {
			return { allowed: false, reason: 'widget_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitLead(
		widgetId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const widget = await this.prisma.widget.findUnique({
			where: { id: widgetId },
			include: { user: { include: { subscription: true } } }
		});

		if (!widget) return { allowed: false, reason: 'widget_not_found' };
		if (!widget.isActive)
			return { allowed: false, reason: 'widget_inactive' };

		const userId = widget.userId;
		const sub = await this.checkAndResetPeriod(userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitQuizLead(
		quizId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const quiz = await this.prisma.quiz.findUnique({
			where: { id: quizId },
			include: { user: { include: { subscription: true } } }
		});

		if (!quiz) return { allowed: false, reason: 'quiz_not_found' };
		if (!quiz.isActive) return { allowed: false, reason: 'quiz_inactive' };

		const sub = await this.checkAndResetPeriod(quiz.userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitCallbackLead(
		callbackId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const callback = await this.prisma.callback.findUnique({
			where: { id: callbackId },
			include: { user: { include: { subscription: true } } }
		});

		if (!callback) return { allowed: false, reason: 'callback_not_found' };
		if (!callback.isActive)
			return { allowed: false, reason: 'callback_inactive' };

		const sub = await this.checkAndResetPeriod(callback.userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitCountdownTimerLead(
		countdownTimerId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const timer = await this.prisma.countdownTimer.findUnique({
			where: { id: countdownTimerId },
			include: { user: { include: { subscription: true } } }
		});

		if (!timer) return { allowed: false, reason: 'timer_not_found' };
		if (!timer.isActive)
			return { allowed: false, reason: 'timer_inactive' };

		const sub = await this.checkAndResetPeriod(timer.userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitStopOfferLead(
		stopOfferId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const stopOffer = await this.prisma.stopOffer.findUnique({
			where: { id: stopOfferId },
			include: { user: { include: { subscription: true } } }
		});

		if (!stopOffer)
			return { allowed: false, reason: 'stop_offer_not_found' };
		if (!stopOffer.isActive)
			return { allowed: false, reason: 'stop_offer_inactive' };

		const sub = await this.checkAndResetPeriod(stopOffer.userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async canSubmitOnlineConsultantLead(
		onlineConsultantId: string
	): Promise<{ allowed: boolean; reason?: string }> {
		const onlineConsultant = await this.prisma.onlineConsultant.findUnique(
			{
				where: { id: onlineConsultantId },
				include: { user: { include: { subscription: true } } }
			}
		);

		if (!onlineConsultant)
			return { allowed: false, reason: 'online_consultant_not_found' };
		if (!onlineConsultant.isActive)
			return { allowed: false, reason: 'online_consultant_inactive' };

		const sub = await this.checkAndResetPeriod(onlineConsultant.userId);

		if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
			return { allowed: false, reason: 'subscription_expired' };
		}

		const limits = PLAN_LIMITS[sub.plan];

		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return { allowed: false, reason: 'lead_limit_reached' };
		}

		return { allowed: true };
	}

	async incrementLeadCount(userId: string) {
		return this.prisma.subscription.update({
			where: { userId },
			data: { leadsThisPeriod: { increment: 1 } }
		});
	}

	getMaxWidgets(plan: Plan): number {
		return PLAN_LIMITS[plan].maxWidgets;
	}

	async adminGetAllSubscriptions(
		page = 1,
		limit = 15,
		filters: AdminSubscriptionFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 15;
		const where = this.getAdminSubscriptionWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [subs, total] = await Promise.all([
			this.prisma.subscription.findMany({
				where,
				include: {
					user: {
						select: {
							id: true,
							name: true,
							authIdentities: {
								where: { type: 'EMAIL' },
								select: { value: true }
							}
						}
					}
				},
				orderBy: { updatedAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.subscription.count({ where })
		]);

		return {
			items: subs.map(sub => ({
				...sub,
				user: sub.user
					? {
							id: sub.user.id,
							name: sub.user.name,
							email: sub.user.authIdentities[0]?.value ?? null
						}
					: null
			})),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async adminGetSubscriptionHistory(
		page = 1,
		limit = 10,
		filters: AdminSubscriptionHistoryFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
		const where = this.getAdminSubscriptionHistoryWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [histories, total] = await Promise.all([
			this.prisma.subscriptionHistory.findMany({
				where,
				include: {
					user: {
						select: {
							id: true,
							name: true,
							authIdentities: {
								where: { type: 'EMAIL' },
								select: { value: true }
							}
						}
					},
					admin: {
						select: {
							id: true,
							name: true,
							authIdentities: {
								where: { type: 'EMAIL' },
								select: { value: true }
							}
						}
					}
				},
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.subscriptionHistory.count({ where })
		]);

		return {
			items: histories.map(history => ({
				...history,
				user: history.user
					? {
							id: history.user.id,
							name: history.user.name,
							email: history.user.authIdentities[0]?.value ?? null
						}
					: null,
				admin: history.admin
					? {
							id: history.admin.id,
							name: history.admin.name,
							email: history.admin.authIdentities[0]?.value ?? null
						}
					: null
			})),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async adminActivateSubscription(
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod,
		startsAt?: Date,
		extendIfActive?: boolean
	) {
		const start = dayjs(startsAt ?? new Date());

		const addPeriod = (base: dayjs.Dayjs) =>
			plan === Plan.TRIAL
				? base.add(7, 'day')
				: billingPeriod === BillingPeriod.YEARLY
					? base.add(1, 'year')
					: base.add(1, 'month');

		let base = start;
		if (extendIfActive !== false) {
			const existing = await this.prisma.subscription.findUnique({
				where: { userId }
			});
			if (
				existing?.status === SubscriptionStatus.ACTIVE &&
				existing.expiresAt &&
				dayjs(existing.expiresAt).isAfter(dayjs())
			) {
				base = dayjs(existing.expiresAt);
			}
		}

		const expiresAt = addPeriod(base).toDate();

		return this.prisma.subscription.upsert({
			where: { userId },
			update: {
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: start.toDate(),
				expiresAt,
				leadsThisPeriod: 0,
				periodResetsAt: start.add(1, 'month').toDate()
			},
			create: {
				userId,
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: start.toDate(),
				expiresAt,
				leadsThisPeriod: 0,
				periodResetsAt: start.add(1, 'month').toDate()
			}
		});
	}

	async adminExtendSubscriptionDays({
		userId,
		days,
		adminId,
		audience = 'SINGLE'
	}: AdminExtendSubscriptionDaysInput): Promise<AdminExtendSubscriptionDaysResult> {
		if (audience === 'SINGLE') {
			return this.adminExtendSingleSubscriptionDays(userId, days, adminId);
		}

		return this.adminExtendMassSubscriptionDays(audience, days, adminId);
	}

	private async adminExtendSingleSubscriptionDays(
		userId: string,
		days: number,
		adminId: string
	): Promise<AdminExtendSubscriptionDaysResult> {
		if (!userId) {
			throw new BadRequestException('Выберите пользователя');
		}

		const subscription = await this.prisma.subscription.findUnique({
			where: { userId }
		});

		if (!subscription) {
			throw new BadRequestException('Подписка пользователя не найдена');
		}

		const now = dayjs();
		const { data, newExpiresAt } = this.getBonusExtensionData(
			subscription,
			days,
			now
		);

		return this.prisma.$transaction(async tx => {
			const updatedSubscription = await tx.subscription.update({
				where: { userId },
				data
			});

			const history = await tx.subscriptionHistory.create({
				data: {
					subscriptionId: subscription.id,
					userId,
					adminId,
					action: SubscriptionHistoryAction.BONUS_DAYS,
					days,
					oldExpiresAt: subscription.expiresAt,
					newExpiresAt,
					targetAudience: SubscriptionBonusAudience.SINGLE,
					targetLabel: BONUS_AUDIENCE_LABELS.SINGLE,
					affectedUsersCount: 1
				}
			});

			return {
				audience: 'SINGLE',
				audienceLabel: BONUS_AUDIENCE_LABELS.SINGLE,
				affectedUsersCount: 1,
				historyId: history.id,
				subscription: updatedSubscription
			};
		});
	}

	private async adminExtendMassSubscriptionDays(
		audience: Exclude<AdminBonusAudience, 'SINGLE'>,
		days: number,
		adminId: string
	): Promise<AdminExtendSubscriptionDaysResult> {
		const now = dayjs();
		const users = await this.getBonusAudienceUsers(audience, now.toDate());

		if (!users.length) {
			throw new BadRequestException(
				'Пользователи для начисления не найдены'
			);
		}

		const subscriptionOperations = users.map(user => {
			const { data, newExpiresAt } = this.getBonusExtensionData(
				user.subscription,
				days,
				now
			);

			if (user.subscription) {
				return this.prisma.subscription.update({
					where: { id: user.subscription.id },
					data
				});
			}

			return this.prisma.subscription.create({
				data: {
					userId: user.id,
					plan: Plan.TRIAL,
					status: SubscriptionStatus.ACTIVE,
					expiresAt: newExpiresAt,
					leadsThisPeriod: 0,
					periodResetsAt: now.add(1, 'month').toDate()
				}
			});
		});

		const affectedUsersCount = subscriptionOperations.length;
		const transactionResults = await this.prisma.$transaction([
			...subscriptionOperations,
			this.prisma.subscriptionHistory.create({
				data: {
					adminId,
					action: SubscriptionHistoryAction.BONUS_DAYS,
					days,
					targetAudience: audience as SubscriptionBonusAudience,
					targetLabel: BONUS_AUDIENCE_LABELS[audience],
					affectedUsersCount
				}
			})
		]);
		const history = transactionResults[transactionResults.length - 1];

		return {
			audience,
			audienceLabel: BONUS_AUDIENCE_LABELS[audience],
			affectedUsersCount,
			historyId: history.id
		};
	}

	private async getBonusAudienceUsers(
		audience: Exclude<AdminBonusAudience, 'SINGLE'>,
		now: Date
	) {
		const activeSubscriptionWhere = this.getActiveSubscriptionWhere(now);
		const where: Prisma.UserWhereInput =
			audience === 'ACTIVE_SUBSCRIPTION'
				? {
						subscription: {
							is: activeSubscriptionWhere
						}
					}
				: audience === 'INACTIVE_SUBSCRIPTION'
					? {
							OR: [
								{
									subscription: {
										is: null
									}
								},
								{
									subscription: {
										isNot: activeSubscriptionWhere
									}
								}
							]
						}
					: {};

		return this.prisma.user.findMany({
			where,
			select: {
				id: true,
				subscription: true
			},
			orderBy: {
				createdAt: 'asc'
			}
		});
	}

	private getActiveSubscriptionWhere(
		now: Date
	): Prisma.SubscriptionWhereInput {
		return {
			status: SubscriptionStatus.ACTIVE,
			OR: [
				{
					expiresAt: null
				},
				{
					expiresAt: {
						gt: now
					}
				}
			]
		};
	}

	private getBonusExtensionData(
		subscription: Subscription | null,
		days: number,
		now: dayjs.Dayjs
	) {
		const isActiveFutureSubscription =
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.expiresAt &&
			dayjs(subscription.expiresAt).isAfter(now);
		const base = isActiveFutureSubscription
			? dayjs(subscription.expiresAt)
			: now;
		const newExpiresAt = base.add(days, 'day').toDate();
		const data = {
			status: SubscriptionStatus.ACTIVE,
			expiresAt: newExpiresAt,
			...(isActiveFutureSubscription
				? {}
				: {
						leadsThisPeriod: 0,
						periodResetsAt: now.add(1, 'month').toDate()
					})
		};

		return { data, newExpiresAt };
	}

	async adminCancelSubscription(userId: string) {
		return this.prisma.subscription.update({
			where: { userId },
			data: { status: SubscriptionStatus.CANCELLED }
		});
	}

	private getAdminSubscriptionWhere(
		filters: AdminSubscriptionFilters
	): Prisma.SubscriptionWhereInput {
		const where: Prisma.SubscriptionWhereInput = {};
		const plan = this.normalizePlan(filters.plan);
		const status = this.normalizeSubscriptionStatus(filters.status);
		const billingPeriod = this.normalizeBillingPeriod(
			filters.billingPeriod
		);
		const expiresAt = this.getDateRangeFilter(
			filters.expiresFrom,
			filters.expiresTo
		);

		if (plan) where.plan = plan;
		if (status) where.status = status;
		if (billingPeriod !== undefined) where.billingPeriod = billingPeriod;
		if (expiresAt) where.expiresAt = expiresAt;

		return where;
	}

	private getAdminSubscriptionHistoryWhere(
		filters: AdminSubscriptionHistoryFilters
	): Prisma.SubscriptionHistoryWhereInput {
		const where: Prisma.SubscriptionHistoryWhereInput = {};
		const audience = this.normalizeSubscriptionBonusAudience(
			filters.audience
		);
		const adminId = filters.adminId?.trim();
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);

		if (audience) where.targetAudience = audience;
		if (adminId) where.adminId = adminId;
		if (createdAt) where.createdAt = createdAt;

		return where;
	}

	private normalizePlan(value?: string) {
		return this.normalizeEnumValue(value, Plan, 'Некорректный тариф');
	}

	private normalizeSubscriptionStatus(value?: string) {
		return this.normalizeEnumValue(
			value,
			SubscriptionStatus,
			'Некорректный статус подписки'
		);
	}

	private normalizeBillingPeriod(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (normalized === 'NONE') {
			return null;
		}

		return this.normalizeEnumValue(
			normalized,
			BillingPeriod,
			'Некорректный период подписки'
		);
	}

	private normalizeSubscriptionBonusAudience(value?: string) {
		return this.normalizeEnumValue(
			value,
			SubscriptionBonusAudience,
			'Некорректная аудитория начисления'
		);
	}

	private normalizeEnumValue<T extends Record<string, string>>(
		value: string | undefined,
		enumValues: T,
		errorMessage: string
	): T[keyof T] | undefined {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) {
			return undefined;
		}

		if (!Object.values(enumValues).includes(normalized)) {
			throw new BadRequestException(errorMessage);
		}

		return normalized as T[keyof T];
	}

	private getDateRangeFilter(from?: string, to?: string) {
		const gte = this.normalizeDate(from, false);
		const lte = this.normalizeDate(to, true);

		if (!gte && !lte) {
			return undefined;
		}

		return {
			...(gte ? { gte } : {}),
			...(lte ? { lte } : {})
		};
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();

		if (!normalized) {
			return undefined;
		}

		const date = new Date(
			endOfDay
				? `${normalized}T23:59:59.999Z`
				: `${normalized}T00:00:00.000Z`
		);

		if (Number.isNaN(date.getTime())) {
			throw new BadRequestException('Некорректная дата фильтра');
		}

		return date;
	}
}
