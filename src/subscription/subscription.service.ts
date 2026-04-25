import { PrismaService } from '@/prisma.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { Injectable } from '@nestjs/common';
import { BillingPeriod, Plan, SubscriptionStatus } from '@prisma/client';
import * as dayjs from 'dayjs';

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
		const [widgetCount, quizCount] = await Promise.all([
			this.prisma.widget.count({ where: { userId } }),
			this.prisma.quiz.count({ where: { userId } })
		]);

		if (widgetCount + quizCount >= limits.maxWidgets) {
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

	async incrementLeadCount(userId: string) {
		return this.prisma.subscription.update({
			where: { userId },
			data: { leadsThisPeriod: { increment: 1 } }
		});
	}

	getMaxWidgets(plan: Plan): number {
		return PLAN_LIMITS[plan].maxWidgets;
	}

	async adminGetAllSubscriptions() {
		const subs = await this.prisma.subscription.findMany({
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
			orderBy: { updatedAt: 'desc' }
		});

		return subs.map(sub => ({
			...sub,
			user: sub.user
				? {
						id: sub.user.id,
						name: sub.user.name,
						email: sub.user.authIdentities[0]?.value ?? null
					}
				: null
		}));
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

	async adminCancelSubscription(userId: string) {
		return this.prisma.subscription.update({
			where: { userId },
			data: { status: SubscriptionStatus.CANCELLED }
		});
	}
}
