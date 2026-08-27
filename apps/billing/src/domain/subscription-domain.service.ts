import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	Prisma,
	ProviderOperationKind,
	ProviderOperationStatus,
	SubscriptionBonusAudience,
	SubscriptionHistoryAction,
	SubscriptionStatus
} from '@prisma/billing-client';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
	AdminActivateSubscriptionDto,
	AdminExtendSubscriptionDto
} from '../http/billing.dto';
import { WidgetsInternalClient } from '../internal/widgets-internal.client';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	enqueueBillingAdminAudit,
	type BillingAdminActor,
	type BillingAdminAuditAction
} from './billing-admin-audit';

@Injectable()
export class SubscriptionDomainService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly widgets: WidgetsInternalClient
	) {}

	async me(userId: string) {
		const identity =
			await this.prisma.identityContactProjection.findUnique({
				where: { userId }
			});
		if (!identity) {
			throw new ServiceUnavailableException(
				'Профиль пользователя ещё не синхронизирован'
			);
		}
		if (
			identity.tombstone ||
			identity.deletedAt ||
			identity.status !== 'ACTIVE'
		) {
			throw new BadRequestException(
				'Пользователь не найден или неактивен'
			);
		}
		let subscription = await this.prisma.subscription.findUnique({
			where: { userId }
		});
		if (!subscription) {
			if (!identity.sourceCreatedAt) {
				throw new ServiceUnavailableException(
					'Дата регистрации ещё не синхронизирована'
				);
			}
			subscription = await this.ensureTrial(
				userId,
				7,
				identity.sourceCreatedAt
			);
		}
		subscription = await this.normalizeSubscription(subscription);
		const [usage] = await this.widgets.getOwnerUsage([userId]);
		return {
			...this.publicSubscription(subscription),
			leadsThisPeriod: usage.leadCount
		};
	}

	async adminList(
		page = 1,
		limit = 15,
		filters: Record<string, string | undefined>
	) {
		const paging = this.pagination(page, limit, 100, 15);
		const where: Prisma.SubscriptionWhereInput = {};
		const plan = this.normalizeEnum(
			filters.plan,
			Plan,
			'Некорректный тариф'
		);
		const status = this.normalizeEnum(
			filters.status,
			SubscriptionStatus,
			'Некорректный статус подписки'
		);
		const billingPeriod = this.normalizeBillingPeriod(
			filters.billingPeriod
		);
		const expiresAt = this.dateRange(
			filters.expiresFrom,
			filters.expiresTo
		);
		if (plan) where.plan = plan;
		if (status) where.status = status;
		if (billingPeriod !== undefined) where.billingPeriod = billingPeriod;
		if (expiresAt) where.expiresAt = expiresAt;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.subscription.findMany({
				where,
				orderBy: { updatedAt: 'desc' },
				skip: paging.skip,
				take: paging.limit
			}),
			this.prisma.subscription.count({ where })
		]);
		const userIds = items.map(item => item.userId);
		const [identities, usage] = await Promise.all([
			this.prisma.identityContactProjection.findMany({
				where: { userId: { in: userIds } }
			}),
			this.widgets.getOwnerUsage(userIds)
		]);
		const identityMap = new Map(
			identities.map(item => [item.userId, item])
		);
		const usageMap = new Map(usage.map(item => [item.userId, item]));
		return {
			items: items.map(item => ({
				...this.publicSubscription(item),
				leadsThisPeriod:
					usageMap.get(item.userId)?.leadCount ?? item.leadsThisPeriod,
				user: {
					id: item.userId,
					name: identityMap.get(item.userId)?.name ?? null,
					email: identityMap.get(item.userId)?.email ?? null
				}
			})),
			total,
			page: paging.page,
			limit: paging.limit,
			totalPages: Math.max(1, Math.ceil(total / paging.limit))
		};
	}

	async history(
		page = 1,
		limit = 10,
		filters: Record<string, string | undefined>
	) {
		const paging = this.pagination(page, limit, 100, 10);
		const where: Prisma.SubscriptionHistoryWhereInput = {};
		const audience = this.normalizeEnum(
			filters.audience,
			SubscriptionBonusAudience,
			'Некорректная аудитория начисления'
		);
		const adminId = filters.adminId?.trim();
		const createdAt = this.dateRange(
			filters.createdFrom,
			filters.createdTo
		);
		if (adminId) where.adminId = adminId;
		if (audience) where.targetAudience = audience;
		if (createdAt) where.createdAt = createdAt;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.subscriptionHistory.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: paging.skip,
				take: paging.limit
			}),
			this.prisma.subscriptionHistory.count({ where })
		]);
		const ids = [
			...new Set(
				items
					.flatMap(item => [item.userId, item.adminId])
					.filter(Boolean) as string[]
			)
		];
		const identities =
			await this.prisma.identityContactProjection.findMany({
				where: { userId: { in: ids } }
			});
		const map = new Map(identities.map(item => [item.userId, item]));
		return {
			items: items.map(item => ({
				...item,
				user: item.userId
					? this.publicIdentity(map.get(item.userId))
					: null,
				admin: item.adminId
					? this.publicIdentity(map.get(item.adminId))
					: null
			})),
			total,
			page: paging.page,
			limit: paging.limit,
			totalPages: Math.max(1, Math.ceil(total / paging.limit))
		};
	}

	async activate(
		dto: AdminActivateSubscriptionDto,
		actor: BillingAdminActor
	) {
		await this.assertIdentityCanReceiveSubscription(dto.userId);
		const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
		const current = await this.prisma.subscription.findUnique({
			where: { userId: dto.userId }
		});
		const base =
			dto.extendIfActive !== false &&
			current?.status === SubscriptionStatus.ACTIVE &&
			current.expiresAt &&
			current.expiresAt > new Date()
				? current.expiresAt
				: startsAt;
		const expiresAt =
			dto.plan === Plan.TRIAL
				? new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000)
				: this.addPeriod(base, dto.billingPeriod || BillingPeriod.MONTHLY);
		const periodResetsAt = this.addCalendarMonthsClamped(startsAt, 1);
		const subscription = await this.prisma.$transaction(
			async transaction => {
				const sequence = await this.nextSequence(transaction);
				const version = (current?.aggregateVersion || 0n) + 1n;
				const updated = await transaction.subscription.upsert({
					where: { userId: dto.userId },
					create: {
						userId: dto.userId,
						plan: dto.plan,
						billingPeriod: dto.billingPeriod,
						status: SubscriptionStatus.ACTIVE,
						startsAt,
						expiresAt,
						periodResetsAt,
						aggregateVersion: version,
						sourceSequence: sequence
					},
					update: {
						plan: dto.plan,
						billingPeriod: dto.billingPeriod,
						status: SubscriptionStatus.ACTIVE,
						startsAt,
						expiresAt,
						periodResetsAt,
						aggregateVersion: version,
						sourceSequence: sequence
					}
				});
				await this.emitSubscriptionState(transaction, updated);
				await this.audit(
					transaction,
					actor,
					'SUBSCRIPTION_ACTIVATE',
					dto.userId,
					{
						subscriptionId: updated.id,
						plan: dto.plan,
						billingPeriod: dto.billingPeriod ?? null,
						startsAt: dto.startsAt ?? null,
						extendIfActive: dto.extendIfActive ?? null,
						expiresAt: updated.expiresAt?.toISOString() ?? null
					}
				);
				return updated;
			}
		);
		return this.publicSubscription(subscription);
	}

	async extend(dto: AdminExtendSubscriptionDto, actor: BillingAdminActor) {
		const audience = dto.userId
			? SubscriptionBonusAudience.SINGLE
			: dto.audience || SubscriptionBonusAudience.ALL;
		if (audience === SubscriptionBonusAudience.SINGLE) {
			if (!dto.userId)
				throw new BadRequestException('Выберите пользователя');
			await this.assertIdentityCanReceiveSubscription(dto.userId);
			const current = await this.prisma.subscription.findUnique({
				where: { userId: dto.userId }
			});
			if (!current) {
				throw new BadRequestException('Подписка пользователя не найдена');
			}
			const result = await this.prisma.$transaction(async transaction => {
				const now = new Date();
				const oldExpiresAt = current.expiresAt;
				const base = this.isActiveFuture(current, now)
					? current.expiresAt!
					: now;
				const newExpiresAt = new Date(
					base.getTime() + dto.days * 24 * 60 * 60 * 1000
				);
				const sequence = await this.nextSequence(transaction);
				const updated = await transaction.subscription.update({
					where: { id: current.id },
					data: {
						expiresAt: newExpiresAt,
						status: SubscriptionStatus.ACTIVE,
						...(!this.isActiveFuture(current, now)
							? { periodResetsAt: this.addCalendarMonthsClamped(now, 1) }
							: {}),
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				const history = await transaction.subscriptionHistory.create({
					data: {
						subscriptionId: current.id,
						userId: dto.userId,
						adminId: actor.id,
						action: SubscriptionHistoryAction.BONUS_DAYS,
						days: dto.days,
						oldExpiresAt,
						newExpiresAt,
						targetAudience: SubscriptionBonusAudience.SINGLE,
						targetLabel: this.audienceLabel(
							SubscriptionBonusAudience.SINGLE
						),
						affectedUsersCount: 1
					}
				});
				await this.emitSubscriptionState(transaction, updated);
				await this.audit(
					transaction,
					actor,
					'SUBSCRIPTION_EXTEND_DAYS',
					dto.userId,
					{
						subscriptionId: updated.id,
						days: dto.days,
						audience,
						audienceLabel: this.audienceLabel(audience),
						affectedUsersCount: 1,
						expiresAt: updated.expiresAt?.toISOString() ?? null
					}
				);
				return { updated, history };
			});
			return {
				audience,
				audienceLabel: this.audienceLabel(audience),
				affectedUsersCount: 1,
				historyId: result.history.id,
				subscription: this.publicSubscription(result.updated)
			};
		}

		const now = new Date();
		const identities =
			await this.prisma.identityContactProjection.findMany({
				where: { deletedAt: null, tombstone: false },
				orderBy: { userId: 'asc' }
			});
		const subscriptions = await this.prisma.subscription.findMany({
			where: {
				userId: { in: identities.map(identity => identity.userId) }
			}
		});
		const byUserId = new Map(
			subscriptions.map(item => [item.userId, item])
		);
		const eligible = identities.filter(identity => {
			const active = this.isActiveForAudience(
				byUserId.get(identity.userId),
				now
			);
			if (audience === SubscriptionBonusAudience.ACTIVE_SUBSCRIPTION) {
				return active;
			}
			if (audience === SubscriptionBonusAudience.INACTIVE_SUBSCRIPTION) {
				return !active;
			}
			return true;
		});
		if (!eligible.length) {
			throw new BadRequestException(
				'Пользователи для начисления не найдены'
			);
		}
		const result = await this.prisma.$transaction(async transaction => {
			for (const identity of eligible) {
				const current = byUserId.get(identity.userId);
				const active = this.isActiveFuture(current, now);
				const base = active ? current!.expiresAt! : now;
				const newExpiresAt = new Date(
					base.getTime() + dto.days * 24 * 60 * 60 * 1000
				);
				const sequence = await this.nextSequence(transaction);
				const updated = current
					? await transaction.subscription.update({
							where: { id: current.id },
							data: {
								status: SubscriptionStatus.ACTIVE,
								expiresAt: newExpiresAt,
								...(!active
									? {
											periodResetsAt: this.addCalendarMonthsClamped(now, 1)
										}
									: {}),
								aggregateVersion: { increment: 1n },
								sourceSequence: sequence
							}
						})
					: await transaction.subscription.create({
							data: {
								userId: identity.userId,
								plan: Plan.TRIAL,
								billingPeriod: null,
								status: SubscriptionStatus.ACTIVE,
								startsAt: now,
								expiresAt: newExpiresAt,
								periodResetsAt: this.addCalendarMonthsClamped(now, 1),
								aggregateVersion: 1n,
								sourceSequence: sequence
							}
						});
				await this.emitSubscriptionState(transaction, updated);
			}
			const history = await transaction.subscriptionHistory.create({
				data: {
					adminId: actor.id,
					action: SubscriptionHistoryAction.BONUS_DAYS,
					days: dto.days,
					targetAudience: audience,
					targetLabel: this.audienceLabel(audience),
					affectedUsersCount: eligible.length
				}
			});
			await this.audit(
				transaction,
				actor,
				'SUBSCRIPTION_EXTEND_DAYS',
				undefined,
				{
					historyId: history.id,
					days: dto.days,
					audience,
					audienceLabel: this.audienceLabel(audience),
					affectedUsersCount: eligible.length,
					expiresAt: null
				}
			);
			return history;
		});
		return {
			audience,
			audienceLabel: this.audienceLabel(audience),
			affectedUsersCount: eligible.length,
			historyId: result.id
		};
	}

	async cancel(userId: string, actor: BillingAdminActor) {
		const current = await this.prisma.subscription.findUnique({
			where: { userId }
		});
		if (!current) throw new NotFoundException('Подписка не найдена');
		const updated = await this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw`
				SELECT user_id FROM billing.identity_contact_projections
				WHERE user_id = ${userId}
				FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT id FROM billing.auto_renewals
				WHERE user_id = ${userId}
				FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT id FROM billing.payments
				WHERE user_id = ${userId}
					AND kind = 'RECURRING'
					AND (status = 'PENDING' OR payment_method_ciphertext IS NOT NULL)
				ORDER BY id
				FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT operation.id
				FROM billing.provider_operations AS operation
				JOIN billing.payments AS payment
					ON payment.id = operation.payment_id
				WHERE payment.user_id = ${userId}
					AND operation.kind = 'CAPTURE_RECURRING'::billing."ProviderOperationKind"
				FOR UPDATE OF operation
			`;
			const ambiguousOperation =
				await transaction.providerOperation.findFirst({
					where: {
						payment: { userId },
						kind: ProviderOperationKind.CAPTURE_RECURRING,
						status: {
							in: [
								ProviderOperationStatus.PROCESSING,
								ProviderOperationStatus.UNKNOWN
							]
						}
					},
					select: { id: true }
				});
			if (ambiguousOperation) {
				throw new ConflictException(
					'Списание уже обрабатывается. Повторите отмену подписки после завершения проверки'
				);
			}
			await transaction.$queryRaw`
				SELECT id FROM billing.subscriptions WHERE id = ${current.id} FOR UPDATE
			`;
			const sequence = await this.nextSequence(transaction);
			const item = await transaction.subscription.update({
				where: { id: current.id },
				data: {
					status: SubscriptionStatus.CANCELLED,
					aggregateVersion: { increment: 1n },
					sourceSequence: sequence
				}
			});
			await this.revokeAutoRenewalForAdminCancellation(
				transaction,
				userId,
				actor
			);
			await this.emitSubscriptionState(transaction, item);
			await this.audit(transaction, actor, 'SUBSCRIPTION_CANCEL', userId, {
				subscriptionId: item.id,
				status: item.status,
				plan: item.plan,
				expiresAt: item.expiresAt?.toISOString() ?? null
			});
			return item;
		});
		return this.publicSubscription(updated);
	}

	async runExpiryCheck(actor?: BillingAdminActor) {
		const now = new Date();
		const candidates = await this.prisma.subscription.findMany({
			where: {
				status: SubscriptionStatus.ACTIVE,
				expiresAt: { lte: now }
			},
			take: 1000
		});
		let count = 0;
		for (const candidate of candidates) {
			const changed = await this.prisma.$transaction(async transaction => {
				const sequence = await this.nextSequence(transaction);
				const result = await transaction.subscription.updateMany({
					where: {
						id: candidate.id,
						status: SubscriptionStatus.ACTIVE,
						expiresAt: { lte: now }
					},
					data: {
						status: SubscriptionStatus.EXPIRED,
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				if (result.count !== 1) return false;
				const item = await transaction.subscription.findUniqueOrThrow({
					where: { id: candidate.id }
				});
				await this.emitSubscriptionState(transaction, item);
				return true;
			});
			if (changed) count += 1;
		}
		const result = {
			taskId: 'subscriptionExpiryCheck',
			title: 'Проверка истёкших подписок',
			affectedCount: count,
			message:
				count > 0
					? `Деактивировано ${count} истёкших подписок.`
					: 'Истёкшие подписки для деактивации не найдены.',
			executedAt: now.toISOString()
		};
		if (actor) {
			await this.prisma.$transaction(transaction =>
				this.audit(
					transaction,
					actor,
					'SUBSCRIPTION_EXPIRY_CHECK_RUN',
					undefined,
					result
				)
			);
		}
		return result;
	}

	async ensureTrial(
		userId: string,
		trialDays: number,
		registeredAt: Date
	) {
		return this.prisma.$transaction(transaction =>
			this.ensureTrialInTransaction(
				transaction,
				userId,
				trialDays,
				registeredAt
			)
		);
	}

	async ensureTrialInTransaction(
		transaction: Prisma.TransactionClient,
		userId: string,
		trialDays: number,
		registeredAt: Date
	) {
		await transaction.$executeRaw(Prisma.sql`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`billing-subscription-user:${userId}`}, 0)
			)
		`);
		const existing = await transaction.subscription.findUnique({
			where: { userId }
		});
		if (existing) return existing;
		const sequence = await this.nextSequence(transaction);
		const created = await transaction.subscription.create({
			data: {
				userId,
				plan: Plan.TRIAL,
				status: SubscriptionStatus.ACTIVE,
				startsAt: registeredAt,
				expiresAt: new Date(
					registeredAt.getTime() + trialDays * 24 * 60 * 60 * 1000
				),
				aggregateVersion: 1n,
				sourceSequence: sequence
			}
		});
		await this.emitSubscriptionState(transaction, created);
		return created;
	}

	private async emitSubscriptionState(
		transaction: Prisma.TransactionClient,
		item: any
	) {
		const eventId = randomUUID();
		const occurredAt = item.updatedAt.toISOString();
		const base = {
			id: item.id,
			userId: item.userId,
			plan: item.plan,
			billingPeriod: item.billingPeriod,
			status: item.status,
			startsAt: item.startsAt.toISOString(),
			expiresAt: item.expiresAt?.toISOString() || null,
			periodResetsAt: item.periodResetsAt?.toISOString() || null,
			createdAt: item.createdAt.toISOString()
		};
		await transaction.outboxEvent.createMany({
			data: [
				{
					eventId,
					eventType: BILLING_EVENT_TYPES.subscriptionChanged,
					aggregateType: 'billing.subscription',
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion,
					sourceSequence: item.sourceSequence,
					exchange: BILLING_EVENTS_EXCHANGE,
					routingKey: BILLING_EVENT_TYPES.subscriptionChanged,
					payload: {
						schemaVersion: 1,
						eventType: BILLING_EVENT_TYPES.subscriptionChanged,
						eventId,
						aggregateId: item.id,
						aggregateVersion: item.aggregateVersion.toString(),
						sourceSequence: item.sourceSequence.toString(),
						occurredAt,
						tombstone: false,
						state: {
							...base,
							maxWidgets: item.plan === Plan.HARD ? 10 : 1,
							maxLeadsPerPeriod:
								item.plan === Plan.TRIAL
									? 10
									: item.plan === Plan.EASY
										? 100
										: null,
							unlimited: item.plan === Plan.HARD
						}
					}
				}
			]
		});
	}

	private async revokeAutoRenewalForAdminCancellation(
		transaction: Prisma.TransactionClient,
		userId: string,
		actor: BillingAdminActor
	): Promise<void> {
		const renewal = await transaction.autoRenewal.findUnique({
			where: { userId }
		});
		if (renewal) {
			await transaction.$queryRaw`
				SELECT id FROM billing.auto_renewals WHERE id = ${renewal.id} FOR UPDATE
			`;
			if (renewal.status !== AutoRenewalStatus.REVOKED) {
				const reason =
					'Автопродление отозвано при административной отмене подписки';
				const now = new Date();
				const changed = await transaction.autoRenewal.updateMany({
					where: { id: renewal.id, stateVersion: renewal.stateVersion },
					data: {
						status: AutoRenewalStatus.REVOKED,
						paymentMethodCiphertext: null,
						paymentMethodType: null,
						paymentMethodTitle: null,
						paymentMethodLast4: null,
						paymentMethodSavedAt: null,
						retryStartedAt: null,
						retryAttempt: 0,
						nextRetryAt: null,
						dispatchPending: false,
						disabledAt: now,
						disableReason: reason,
						stateVersion: { increment: 1 }
					}
				});
				if (changed.count !== 1) {
					throw new BadRequestException(
						'Состояние автопродления изменилось. Повторите отмену'
					);
				}
				await transaction.autoRenewalConsentEvent.create({
					data: {
						autoRenewalId: renewal.id,
						userId,
						type: AutoRenewalConsentEventType.ADMIN_REVOKED,
						actorUserId: actor.id,
						actorRole: actor.role,
						source: 'SUBSCRIPTION_ADMIN_CANCEL',
						reason,
						consentVersion: renewal.consentVersion,
						consentText: renewal.consentText,
						offerSnapshot: renewal.offerSnapshot,
						offerSha256: renewal.offerSha256,
						offerUpdatedAt: renewal.offerUpdatedAt,
						plan: renewal.plan,
						billingPeriod: renewal.billingPeriod,
						amount: renewal.amount,
						currency: renewal.currency,
						ip: actor.ip,
						userAgent: actor.userAgent,
						metadata: {}
					}
				});
			}
		}
		const futurePayments = await transaction.payment.findMany({
			where: {
				userId,
				kind: PaymentKind.RECURRING,
				status: PaymentStatus.PENDING,
				yookassaId: null
			}
		});
		for (const payment of futurePayments) {
			const sequence = await this.nextSequence(transaction);
			const updated = await transaction.payment.update({
				where: { id: payment.id },
				data: {
					status:
						payment.providerStatus === 'creating'
							? PaymentStatus.EXPIRED
							: PaymentStatus.CANCELLED,
					providerStatus:
						payment.providerStatus === 'creating' ? 'unknown' : 'not_sent',
					paymentMethodCiphertext: null,
					confirmationUrl: null,
					cancelledAt: new Date(),
					cancellationReason:
						'Автопродление отозвано при административной отмене подписки',
					aggregateVersion: { increment: 1n },
					sourceSequence: sequence
				}
			});
			await transaction.providerOperation.updateMany({
				where: {
					paymentId: payment.id,
					status: 'PENDING'
				},
				data: {
					status: 'FAILED',
					lastErrorCode: 'AUTO_RENEWAL_REVOKED',
					lastErrorSafe: 'Автопродление отозвано'
				}
			});
			await this.emitPaymentState(transaction, updated);
		}
	}

	private async emitPaymentState(
		transaction: Prisma.TransactionClient,
		item: any
	) {
		const occurredAt = item.updatedAt.toISOString();
		const eventType = BILLING_EVENT_TYPES.paymentChanged;
		const eventId = randomUUID();
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: 'billing.payment',
				aggregateId: item.id,
				aggregateVersion: item.aggregateVersion,
				sourceSequence: item.sourceSequence,
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion.toString(),
					sourceSequence: item.sourceSequence.toString(),
					occurredAt,
					tombstone: false,
					state: {
						id: item.id,
						userId: item.userId,
						amount: item.amount,
						status: item.status,
						createdAt: item.createdAt.toISOString(),
						updatedAt: occurredAt
					}
				} as Prisma.InputJsonValue
			}
		});
	}

	private async audit(
		transaction: Prisma.TransactionClient,
		actor: BillingAdminActor,
		action: Extract<BillingAdminAuditAction, `SUBSCRIPTION_${string}`>,
		targetUserId: string | undefined,
		metadata: Record<string, unknown>
	) {
		const isTask = action === 'SUBSCRIPTION_EXPIRY_CHECK_RUN';
		const subscriptionId = metadata.subscriptionId;
		const historyId = metadata.historyId;
		const audienceLabel = metadata.audienceLabel;
		const plan = metadata.plan;
		const days = metadata.days;
		const title = metadata.title;
		const eventMetadata = { ...metadata };
		delete eventMetadata.subscriptionId;
		delete eventMetadata.historyId;
		delete eventMetadata.audienceLabel;
		const description =
			action === 'SUBSCRIPTION_ACTIVATE'
				? `Ручная активация подписки: ${String(plan)}`
				: action === 'SUBSCRIPTION_EXTEND_DAYS'
					? `Начислены бонусные дни: ${String(days)} (${String(audienceLabel)})`
					: action === 'SUBSCRIPTION_CANCEL'
						? 'Ручная отмена подписки'
						: String(title);
		const massExtension =
			action === 'SUBSCRIPTION_EXTEND_DAYS' && !targetUserId;
		await enqueueBillingAdminAudit(transaction, {
			actor,
			section: isTask ? 'TASKS' : 'SUBSCRIPTIONS',
			action,
			description,
			entity: {
				type: isTask
					? 'manual_task'
					: massExtension
						? 'subscription_bonus_audience'
						: 'subscription',
				id: String(
					subscriptionId ||
						historyId ||
						metadata.taskId ||
						targetUserId ||
						action
				),
				label: isTask
					? typeof title === 'string'
						? title
						: null
					: massExtension
						? typeof audienceLabel === 'string'
							? audienceLabel
							: null
						: action === 'SUBSCRIPTION_EXTEND_DAYS'
							? `${String(days)} дн.`
							: typeof plan === 'string'
								? plan
								: null,
				targetUserId: targetUserId || null
			},
			metadata: {
				...eventMetadata,
				requestIp: actor.ip || null,
				requestUserAgent: actor.userAgent || null
			}
		});
	}

	private publicSubscription(item: any) {
		return {
			id: item.id,
			userId: item.userId,
			plan: item.plan,
			billingPeriod: item.billingPeriod,
			status: item.status,
			startsAt: item.startsAt,
			expiresAt: item.expiresAt,
			leadsThisPeriod: item.leadsThisPeriod,
			periodResetsAt: item.periodResetsAt,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt
		};
	}

	private publicIdentity(item: any) {
		return item
			? { id: item.userId, name: item.name, email: item.email }
			: null;
	}

	private async assertIdentityCanReceiveSubscription(
		userId: string
	): Promise<void> {
		const identity =
			await this.prisma.identityContactProjection.findUnique({
				where: { userId }
			});
		if (!identity) throw new BadRequestException('Пользователь не найден');
		if (identity.deletedAt || identity.tombstone) {
			throw new BadRequestException(
				'Нельзя изменить подписку удалённого пользователя'
			);
		}
	}

	private async normalizeSubscription(subscription: any) {
		const now = new Date();
		const expired = Boolean(
			subscription.expiresAt && subscription.expiresAt < now
		);
		const resetDue = Boolean(
			!expired &&
			subscription.plan !== Plan.TRIAL &&
			subscription.periodResetsAt &&
			subscription.periodResetsAt < now
		);
		if (
			(!expired || subscription.status === SubscriptionStatus.EXPIRED) &&
			!resetDue
		) {
			return subscription;
		}
		return this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw`
				SELECT id FROM billing.subscriptions WHERE id = ${subscription.id} FOR UPDATE
			`;
			const current = await transaction.subscription.findUniqueOrThrow({
				where: { id: subscription.id }
			});
			const transactionNow = new Date();
			let nextReset = current.periodResetsAt;
			if (
				current.plan !== Plan.TRIAL &&
				nextReset &&
				nextReset < transactionNow
			) {
				do {
					nextReset = this.addCalendarMonthsClamped(nextReset, 1);
				} while (nextReset <= transactionNow);
			}
			const shouldExpire = Boolean(
				current.expiresAt && current.expiresAt < transactionNow
			);
			if (
				(!shouldExpire || current.status === SubscriptionStatus.EXPIRED) &&
				nextReset?.getTime() === current.periodResetsAt?.getTime()
			)
				return current;
			const sequence = await this.nextSequence(transaction);
			const updated = await transaction.subscription.update({
				where: { id: current.id },
				data: {
					...(shouldExpire ? { status: SubscriptionStatus.EXPIRED } : {}),
					...(nextReset?.getTime() !== current.periodResetsAt?.getTime()
						? { periodResetsAt: nextReset }
						: {}),
					aggregateVersion: { increment: 1n },
					sourceSequence: sequence
				}
			});
			await this.emitSubscriptionState(transaction, updated);
			return updated;
		});
	}

	private isActiveFuture(
		subscription:
			| { status: SubscriptionStatus; expiresAt: Date | null }
			| null
			| undefined,
		now: Date
	): boolean {
		return Boolean(
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.expiresAt &&
			subscription.expiresAt > now
		);
	}

	private isActiveForAudience(
		subscription:
			| { status: SubscriptionStatus; expiresAt: Date | null }
			| null
			| undefined,
		now: Date
	): boolean {
		return Boolean(
			subscription?.status === SubscriptionStatus.ACTIVE &&
			(!subscription.expiresAt || subscription.expiresAt > now)
		);
	}

	private pagination(
		page: number,
		limit: number,
		max: number,
		fallback: number
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0
				? Math.min(limit, max)
				: fallback;
		return {
			page: normalizedPage,
			limit: normalizedLimit,
			skip: (normalizedPage - 1) * normalizedLimit
		};
	}

	private addPeriod(date: Date, period: BillingPeriod) {
		return this.addCalendarMonthsClamped(
			date,
			period === BillingPeriod.YEARLY ? 12 : 1
		);
	}

	private addCalendarMonthsClamped(date: Date, months: number): Date {
		const result = new Date(date);
		const day = result.getUTCDate();
		result.setUTCDate(1);
		result.setUTCMonth(result.getUTCMonth() + months);
		const lastDay = new Date(
			Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
		).getUTCDate();
		result.setUTCDate(Math.min(day, lastDay));
		return result;
	}

	private audienceLabel(audience: SubscriptionBonusAudience) {
		return {
			SINGLE: 'Выбранный пользователь',
			ACTIVE_SUBSCRIPTION: 'Все активные пользователи',
			INACTIVE_SUBSCRIPTION: 'Все неактивные пользователи',
			ALL: 'Все пользователи'
		}[audience];
	}

	private normalizeEnum<T extends Record<string, string>>(
		value: string | undefined,
		values: T,
		errorMessage: string
	): T[keyof T] | undefined {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (!Object.values(values).includes(normalized)) {
			throw new BadRequestException(errorMessage);
		}
		return normalized as T[keyof T];
	}

	private normalizeBillingPeriod(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (normalized === 'NONE') return null;
		return this.normalizeEnum(
			normalized,
			BillingPeriod,
			'Некорректный период подписки'
		);
	}

	private dateRange(from?: string, to?: string) {
		const gte = this.normalizeDate(from, false);
		const lte = this.normalizeDate(to, true);
		if (!gte && !lte) return undefined;
		return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
	}

	private normalizeDate(value?: string, endOfDay = false) {
		const normalized = value?.trim();
		if (!normalized) return undefined;
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

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}
}
