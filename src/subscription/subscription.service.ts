import { disableAutoRenewalForLifecycleInTransaction } from '@/payment/auto-renewal-state';
import { PrismaService } from '@/prisma.service';
import type { AdminBonusAudience } from '@/subscription/dto/admin-activate-subscription.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import {
	BillingPeriod,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	Plan,
	Prisma,
	Role,
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
const ATOMIC_TRANSACTION_OPTIONS = {
	maxWait: 5000,
	timeout: 10000
} as const;

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
		return this.createOrUpgradeSubscriptionWithClient(
			this.prisma,
			userId,
			plan,
			billingPeriod
		);
	}

	async createOrUpgradeSubscriptionInTransaction(
		transaction: Prisma.TransactionClient,
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		return this.createOrUpgradeSubscriptionWithClient(
			transaction,
			userId,
			plan,
			billingPeriod
		);
	}

	private async createOrUpgradeSubscriptionWithClient(
		client: Pick<Prisma.TransactionClient, 'subscription'>,
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		const now = dayjs();
		const addPeriod = (base: dayjs.Dayjs) =>
			billingPeriod === BillingPeriod.YEARLY
				? base.add(1, 'year')
				: base.add(1, 'month');

		const existing = await client.subscription.findUnique({
			where: { userId }
		});

		const isActiveSub =
			existing &&
			existing.status === SubscriptionStatus.ACTIVE &&
			existing.expiresAt != null &&
			dayjs(existing.expiresAt).isAfter(now);

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

		return client.subscription.upsert({
			where: { userId },
			update: {
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: isActiveSub ? existing.startsAt : now.toDate(),
				expiresAt,
				periodResetsAt
			},
			create: {
				userId,
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: now.toDate(),
				expiresAt,
				periodResetsAt
			}
		});
	}

	async checkAndResetPeriod(userId: string) {
		return this.prisma.$transaction(async transaction => {
			const subscription = await this.lockOperationalSubscription(
				transaction,
				userId
			);
			if (!subscription) return null;

			return this.normalizeLockedSubscription(transaction, subscription);
		}, ATOMIC_TRANSACTION_OPTIONS);
	}

	private async lockOperationalSubscription(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<Subscription | null> {
		// Lock both Core rows so account lifecycle cannot race with subscription
		// normalization and the corresponding projection events.
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				SELECT s."id"
				FROM "subscriptions" s
				JOIN "User" u ON u."id" = s."user_id"
				WHERE s."user_id" = ${userId}
					AND u."status" = 'ACTIVE'
					AND u."deleted_at" IS NULL
				FOR UPDATE OF s, u
			`
		);
		if (!rows.length) return null;

		return transaction.subscription.findUnique({ where: { userId } });
	}

	private async normalizeLockedSubscription(
		transaction: Prisma.TransactionClient,
		subscription: Subscription
	): Promise<Subscription> {
		const now = dayjs();

		if (subscription.expiresAt && now.isAfter(subscription.expiresAt)) {
			if (subscription.status === SubscriptionStatus.EXPIRED) {
				return subscription;
			}
			return transaction.subscription.update({
				where: { userId: subscription.userId },
				data: { status: SubscriptionStatus.EXPIRED }
			});
		}

		if (
			subscription.plan !== Plan.TRIAL &&
			subscription.periodResetsAt &&
			now.isAfter(subscription.periodResetsAt)
		) {
			let nextReset = dayjs(subscription.periodResetsAt);
			do {
				nextReset = nextReset.add(1, 'month');
			} while (!nextReset.isAfter(now));

			return transaction.subscription.update({
				where: { userId: subscription.userId },
				data: {
					periodResetsAt: nextReset.toDate()
				}
			});
		}

		return subscription;
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
		await this.assertUserCanReceiveAdminSubscriptionChange(userId);

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
				periodResetsAt: start.add(1, 'month').toDate()
			},
			create: {
				userId,
				plan,
				billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: start.toDate(),
				expiresAt,
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

		await this.assertUserCanReceiveAdminSubscriptionChange(userId);

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
						deletedAt: null,
						subscription: {
							is: activeSubscriptionWhere
						}
					}
				: audience === 'INACTIVE_SUBSCRIPTION'
					? {
							deletedAt: null,
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
					: { deletedAt: null };

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
						periodResetsAt: now.add(1, 'month').toDate()
					})
		};

		return { data, newExpiresAt };
	}

	async adminCancelSubscription(userId: string, adminId: string) {
		return this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "User"
					WHERE "id" = ${userId}
					FOR UPDATE
				`
			);
			const subscription = await transaction.subscription.update({
				where: { userId },
				data: { status: SubscriptionStatus.CANCELLED }
			});
			await disableAutoRenewalForLifecycleInTransaction(transaction, {
				userId,
				status: AutoRenewalStatus.REVOKED,
				eventType: AutoRenewalConsentEventType.ADMIN_REVOKED,
				source: 'SUBSCRIPTION_ADMIN_CANCEL',
				reason:
					'Автопродление отозвано при административной отмене подписки',
				actorUserId: adminId,
				actorRole: Role.ADMIN
			});
			return subscription;
		});
	}

	private async assertUserCanReceiveAdminSubscriptionChange(
		userId: string
	) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { deletedAt: true }
		});

		if (!user) {
			throw new BadRequestException('Пользователь не найден');
		}

		if (user.deletedAt) {
			throw new BadRequestException(
				'Нельзя изменить подписку удалённого пользователя'
			);
		}
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
