import {
	AutoRenewal,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	IdentityContactProjection,
	Payment,
	PaymentKind,
	PaymentStatus,
	Plan,
	Prisma,
	ProviderOperationKind,
	ProviderOperationStatus,
	Subscription,
	SubscriptionStatus
} from '@prisma/billing-client';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import type {
	AdminAutoRenewalActionDto,
	CreatePaymentDto
} from '../http/billing.dto';
import {
	enqueueBillingAdminAudit,
	type BillingAdminActor,
	type BillingAdminAuditAction
} from './billing-admin-audit';
import { getBillingCorrelationId } from '../common/billing-request-context';
import { PaymentMethodCryptoService } from '../provider/payment-method-crypto.service';
import {
	AUTO_RENEWAL_DUE_GRACE_MS,
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION,
	AUTO_RENEWAL_RETRY_DELAYS_MS,
	AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS,
	buildRecurringCycleKey,
	isAutoRenewalRetryableCancellation,
	isAutoRenewalOfferCompatible
} from './billing-legal.constants';

const DEFAULT_PRICES: Record<
	'EASY' | 'HARD',
	Record<BillingPeriod, number>
> = {
	EASY: { MONTHLY: 990, YEARLY: 4680 },
	HARD: { MONTHLY: 1690, YEARLY: 9480 }
};

const PLAN_PRIORITY: Record<Plan, number> = {
	[Plan.TRIAL]: 0,
	[Plan.EASY]: 1,
	[Plan.HARD]: 2
};
const PROVIDER_COMMAND_TIMEOUT_MS = 25_000;
const PROVIDER_COMMAND_POLL_MS = 100;

interface PaymentListFilters {
	status?: string;
	plan?: string;
	billingPeriod?: string;
	createdFrom?: string;
	createdTo?: string;
	search?: string;
}

export interface BillingPaymentRequestContext {
	ip?: string | null;
	userAgent?: string | null;
}

@Injectable()
export class PaymentDomainService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly crypto: PaymentMethodCryptoService
	) {}

	async create(
		userId: string,
		dto: CreatePaymentDto,
		context: BillingPaymentRequestContext
	) {
		if (dto.plan === Plan.TRIAL) {
			throw new BadRequestException('Нельзя оплатить тестовый тариф');
		}
		const settings = await this.settings();
		if (!settings.paymentEnabled) {
			throw new ServiceUnavailableException(
				'Приём платежей временно отключён'
			);
		}
		if (dto.autoRenew && !settings.autoRenewalSignupEnabled) {
			throw new BadRequestException(
				'Подключение автопродления временно недоступно. Выберите разовую оплату'
			);
		}
		if (
			dto.autoRenew &&
			dto.consentVersion !== AUTO_RENEWAL_CONSENT_VERSION
		) {
			throw new ConflictException(
				'Условия автопродления обновились. Обновите страницу и подтвердите их заново'
			);
		}
		if (
			dto.autoRenew &&
			(settings.consentVersion !== AUTO_RENEWAL_CONSENT_VERSION ||
				settings.consentText !== AUTO_RENEWAL_CONSENT_TEXT ||
				!isAutoRenewalOfferCompatible(settings.offerSnapshot))
		) {
			throw new ServiceUnavailableException(
				'Условия автопродления обновляются. Выберите разовую оплату или повторите позже'
			);
		}

		const identity = await this.requireActiveIdentity(userId);
		if (!identity.email && !identity.phone) {
			throw new BadRequestException(
				'Для оформления подписки необходимо привязать email или телефон в профиле'
			);
		}
		const activeSubscription = await this.prisma.subscription.findUnique({
			where: { userId }
		});
		if (
			activeSubscription?.status === SubscriptionStatus.ACTIVE &&
			(!activeSubscription.expiresAt ||
				activeSubscription.expiresAt > new Date()) &&
			PLAN_PRIORITY[activeSubscription.plan] > PLAN_PRIORITY[dto.plan]
		) {
			throw new BadRequestException(
				`Пока у вас активен тариф ${this.planLabel(
					activeSubscription.plan
				)}, оплатить ${this.planLabel(
					dto.plan
				)} нельзя. Дождитесь окончания текущего тарифа или продлите текущий.`
			);
		}
		const tariff = await this.ensureTariff(dto.plan, dto.billingPeriod);
		if (tariff.amount !== dto.expectedAmount) {
			throw new ConflictException(
				'Стоимость тарифа изменилась. Обновите страницу перед оплатой'
			);
		}
		await this.cleanupStalePendingForUser(userId);
		const now = new Date();
		const existing = await this.prisma.payment.findFirst({
			where: {
				userId,
				status: PaymentStatus.PENDING,
				OR: [
					{ kind: PaymentKind.RECURRING },
					{
						kind: PaymentKind.ONE_TIME,
						checkoutExpiresAt: { gt: now }
					},
					{
						kind: PaymentKind.ONE_TIME,
						providerOperations: {
							some: {
								status: {
									in: [
										ProviderOperationStatus.PROCESSING,
										ProviderOperationStatus.UNKNOWN
									]
								}
							}
						}
					}
				]
			},
			orderBy: { createdAt: 'desc' }
		});
		if (existing) {
			this.assertSameCreateRequest(existing, dto, tariff.amount);
			return this.awaitCreatedPayment(existing.id);
		}

		const paymentId = this.cuidLikeId();
		const idempotencyKey = randomUUID();
		const checkoutExpiresAt = new Date(now.getTime() + 60 * 60 * 1000);
		const result = await this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${userId}
					FOR UPDATE
				`;
				const lockedIdentity =
					await transaction.identityContactProjection.findUnique({
						where: { userId }
					});
				if (
					!lockedIdentity ||
					lockedIdentity.status !== 'ACTIVE' ||
					lockedIdentity.deletedAt
				) {
					throw new BadRequestException(
						'Пользователь не найден или неактивен'
					);
				}
				const concurrent = await transaction.payment.findFirst({
					where: {
						userId,
						status: PaymentStatus.PENDING,
						OR: [
							{ kind: PaymentKind.RECURRING },
							{
								kind: PaymentKind.ONE_TIME,
								checkoutExpiresAt: { gt: now }
							},
							{
								kind: PaymentKind.ONE_TIME,
								providerOperations: {
									some: {
										status: {
											in: [
												ProviderOperationStatus.PROCESSING,
												ProviderOperationStatus.UNKNOWN
											]
										}
									}
								}
							}
						]
					},
					orderBy: { createdAt: 'desc' }
				});
				if (concurrent) {
					this.assertSameCreateRequest(concurrent, dto, tariff.amount);
					return concurrent;
				}

				const sequence = await this.nextSequence(transaction);
				const payment = await transaction.payment.create({
					data: {
						id: paymentId,
						userId,
						providerIdempotencyKey: idempotencyKey,
						kind: PaymentKind.ONE_TIME,
						amount: this.formatAmount(tariff.amount),
						plan: dto.plan,
						billingPeriod: dto.billingPeriod,
						autoRenew: dto.autoRenew ?? false,
						providerStatus: 'creating',
						consentVersion: dto.autoRenew
							? AUTO_RENEWAL_CONSENT_VERSION
							: null,
						consentText: dto.autoRenew ? AUTO_RENEWAL_CONSENT_TEXT : null,
						consentedAt: dto.autoRenew ? now : null,
						consentIp: dto.autoRenew ? context.ip : null,
						consentUserAgent: dto.autoRenew ? context.userAgent : null,
						offerSnapshot: settings.offerSnapshot,
						offerSha256: settings.offerSectionHash,
						offerUpdatedAt: settings.offerUpdatedAt,
						customerEmail: lockedIdentity.email,
						customerPhone: lockedIdentity.phone,
						checkoutExpiresAt,
						aggregateVersion: 1n,
						sourceSequence: sequence
					}
				});
				await transaction.providerOperation.create({
					data: {
						paymentId: payment.id,
						idempotencyKey,
						kind: ProviderOperationKind.CREATE_CHECKOUT,
						payload: {
							paymentId: payment.id,
							amount: payment.amount,
							currency: payment.currency,
							plan: payment.plan,
							billingPeriod: payment.billingPeriod,
							autoRenew: payment.autoRenew,
							customerEmail: payment.customerEmail,
							customerPhone: payment.customerPhone,
							createdAt: now.toISOString()
						}
					}
				});
				await this.emitPaymentState(transaction, payment);
				return payment;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 5_000,
				timeout: 15_000
			}
		);
		return this.awaitCreatedPayment(result.id);
	}

	async verify(userId: string, paymentId?: string) {
		const payment = await this.findUserPayment(userId, paymentId);
		if (!payment) return this.verificationResponse(null);
		if (payment.yookassaId && payment.status !== PaymentStatus.SUCCEEDED) {
			const operationId = await this.queueVerification(
				payment.id,
				payment.yookassaId
			);
			await this.awaitProviderOperation(operationId);
		}
		const updated = await this.prisma.payment.findUnique({
			where: { id: payment.id }
		});
		return this.verificationResponse(updated);
	}

	async pending(userId: string) {
		await this.cleanupStalePendingForUser(userId);
		let payment = await this.prisma.payment.findFirst({
			where: {
				userId,
				kind: PaymentKind.ONE_TIME,
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { gt: new Date() }
			},
			orderBy: { createdAt: 'desc' }
		});
		if (!payment) return null;

		if (!payment.yookassaId && payment.providerStatus === 'creating') {
			const operation = await this.prisma.providerOperation.upsert({
				where: {
					idempotencyKey:
						payment.providerIdempotencyKey || `create:${payment.id}`
				},
				create: {
					paymentId: payment.id,
					idempotencyKey:
						payment.providerIdempotencyKey || `create:${payment.id}`,
					kind: ProviderOperationKind.CREATE_CHECKOUT,
					payload: { paymentId: payment.id, recovered: true }
				},
				update: {}
			});
			try {
				await this.awaitProviderOperation(operation.id);
			} catch (error) {
				if (!(error instanceof ServiceUnavailableException)) throw error;
			}
		}

		payment = await this.prisma.payment.findUniqueOrThrow({
			where: { id: payment.id }
		});
		if (payment.yookassaId && payment.status === PaymentStatus.PENDING) {
			const operationId = await this.queueVerification(
				payment.id,
				payment.yookassaId
			);
			try {
				await this.awaitProviderOperation(operationId);
			} catch (error) {
				if (!(error instanceof ServiceUnavailableException)) throw error;
			}
		}

		payment = await this.prisma.payment.findUniqueOrThrow({
			where: { id: payment.id }
		});
		return payment.status === PaymentStatus.PENDING
			? this.pendingResponse(payment)
			: null;
	}

	async cancelPending(userId: string, paymentId: string) {
		const normalizedPaymentId = paymentId.trim();
		if (!normalizedPaymentId) {
			throw new BadRequestException('Незавершённый платёж не найден');
		}
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw`
					SELECT id FROM billing.payments
					WHERE id = ${normalizedPaymentId}
						AND user_id = ${userId}
						AND kind = 'ONE_TIME'::billing."PaymentKind"
					FOR UPDATE
				`;
				const payment = await transaction.payment.findFirst({
					where: {
						id: normalizedPaymentId,
						userId,
						kind: PaymentKind.ONE_TIME
					}
				});
				if (!payment) {
					throw new BadRequestException('Незавершённый платёж не найден');
				}
				if (payment.status === PaymentStatus.CANCELLED) {
					return {
						cancelled: true,
						message: 'Незавершённый платёж уже отменён.',
						cancelledAt: (
							payment.cancelledAt ?? payment.updatedAt
						).toISOString()
					};
				}
				if (payment.status === PaymentStatus.EXPIRED) {
					return {
						cancelled: true,
						message: 'Срок незавершённого платежа уже истёк.',
						cancelledAt: payment.updatedAt.toISOString()
					};
				}
				if (payment.status === PaymentStatus.SUCCEEDED) {
					throw new BadRequestException(
						'Платёж уже подтверждён, отменить его нельзя'
					);
				}
				const cancelledAt = new Date();
				const sequence = await this.nextSequence(transaction);
				const updated = await transaction.payment.update({
					where: { id: payment.id },
					data: {
						status: PaymentStatus.CANCELLED,
						confirmationUrl: null,
						cancelledAt,
						cancellationReason: 'user_cancelled',
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await transaction.providerOperation.updateMany({
					where: {
						paymentId: payment.id,
						status: ProviderOperationStatus.PENDING
					},
					data: {
						status: ProviderOperationStatus.FAILED,
						lastErrorCode: 'USER_CANCELLED',
						lastErrorSafe: 'Незавершённый платёж отменён пользователем'
					}
				});
				await this.emitPaymentState(transaction, updated);
				return {
					cancelled: true,
					message: 'Незавершённый платёж отменён.',
					cancelledAt: cancelledAt.toISOString()
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async history(userId: string, page = 1, limit = 10) {
		const paging = this.pagination(page, limit, 50, 10);
		const where = { userId };
		const [initialItems, total] = await this.prisma.$transaction([
			this.prisma.payment.findMany({
				where,
				include: {
					receipts: {
						orderBy: [{ registeredAt: 'desc' }, { createdAt: 'desc' }]
					}
				},
				orderBy: { createdAt: 'desc' },
				skip: paging.skip,
				take: paging.limit
			}),
			this.prisma.payment.count({ where })
		]);
		let items = initialItems;
		const missingReceipts = items.filter(
			item =>
				item.status === PaymentStatus.SUCCEEDED &&
				Boolean(item.yookassaId) &&
				item.receiptSyncEligible &&
				item.receipts.length === 0
		);
		if (missingReceipts.length > 0) {
			await Promise.all(
				missingReceipts.map(async payment => {
					const operation = await this.prisma.providerOperation.upsert({
						where: { idempotencyKey: `receipt:${payment.id}` },
						create: {
							paymentId: payment.id,
							providerPaymentId: payment.yookassaId,
							idempotencyKey: `receipt:${payment.id}`,
							kind: ProviderOperationKind.SYNC_RECEIPT,
							payload: {
								paymentId: payment.id,
								providerPaymentId: payment.yookassaId
							}
						},
						update: {}
					});
					try {
						await this.awaitProviderOperation(operation.id);
					} catch (error) {
						if (!(error instanceof ServiceUnavailableException))
							throw error;
					}
				})
			);
			items = await this.prisma.payment.findMany({
				where,
				include: {
					receipts: {
						orderBy: [{ registeredAt: 'desc' }, { createdAt: 'desc' }]
					}
				},
				orderBy: { createdAt: 'desc' },
				skip: paging.skip,
				take: paging.limit
			});
		}
		return {
			items: items.map(item => this.historyItem(item)),
			total,
			page: paging.page,
			limit: paging.limit,
			totalPages: Math.max(1, Math.ceil(total / paging.limit)),
			serverTime: new Date().toISOString()
		};
	}

	async userAutoRenewal(userId: string) {
		const detail = await this.getRenewalContext(userId);
		return this.serializeUserAutoRenewal(
			detail.renewal,
			detail.identity,
			detail.subscription
		);
	}

	async disableUserAutoRenewal(
		userId: string,
		context: BillingPaymentRequestContext
	) {
		await this.prisma.$transaction(
			async transaction => {
				const renewal = await this.lockRenewal(transaction, userId);
				if (!renewal) {
					throw new BadRequestException('Автопродление не подключено');
				}
				if (
					renewal.status === AutoRenewalStatus.USER_DISABLED ||
					renewal.status === AutoRenewalStatus.REVOKED
				) {
					await this.clearFutureRecurringPayments(
						transaction,
						userId,
						'user_disabled_before_provider_call'
					);
					return;
				}
				const changed = await transaction.autoRenewal.updateMany({
					where: { id: renewal.id, stateVersion: renewal.stateVersion },
					data: {
						status: AutoRenewalStatus.USER_DISABLED,
						disabledAt: new Date(),
						disableReason: 'Отключено пользователем в личном кабинете',
						paymentMethodCiphertext: null,
						paymentMethodType: null,
						paymentMethodTitle: null,
						paymentMethodLast4: null,
						paymentMethodSavedAt: null,
						retryStartedAt: null,
						retryAttempt: 0,
						nextRetryAt: null,
						dispatchPending: false,
						stateVersion: { increment: 1 }
					}
				});
				if (changed.count !== 1) {
					throw new ConflictException(
						'Состояние автопродления уже изменилось'
					);
				}
				await this.clearFutureRecurringPayments(
					transaction,
					userId,
					'user_disabled_before_provider_call'
				);
				await this.createRenewalEvent(
					transaction,
					renewal,
					AutoRenewalConsentEventType.USER_DISABLED,
					{ id: userId, role: 'USER', ...context },
					'CABINET',
					'Отключено пользователем'
				);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		return this.userAutoRenewal(userId);
	}

	async confirmPrice(
		userId: string,
		context: BillingPaymentRequestContext
	) {
		let chargeMayStartImmediately = false;
		await this.prisma.$transaction(
			async transaction => {
				const renewal = await this.lockRenewal(transaction, userId);
				if (!renewal?.pendingAmount) {
					throw new BadRequestException(
						'Изменение стоимости для подтверждения не найдено'
					);
				}
				if (
					renewal.status === AutoRenewalStatus.USER_DISABLED ||
					renewal.status === AutoRenewalStatus.REVOKED
				) {
					throw new ForbiddenException(
						'Подключите автопродление заново на странице оплаты'
					);
				}
				const [identity, subscription] = await Promise.all([
					transaction.identityContactProjection.findUnique({
						where: { userId }
					}),
					transaction.subscription.findUnique({ where: { userId } })
				]);
				if (
					!this.isUserEligible(identity, subscription) &&
					!this.isChargeWindowEligible(identity, subscription, renewal)
				) {
					throw new ForbiddenException(
						'Текущий оплаченный период завершён. Оформите подписку заново'
					);
				}
				const currentAmount = await this.currentAmount(
					transaction,
					renewal.plan,
					renewal.billingPeriod
				);
				if (currentAmount !== renewal.pendingAmount) {
					throw new ConflictException(
						'Стоимость изменилась повторно. Обновите страницу'
					);
				}
				const settings = await transaction.billingSettings.findUnique({
					where: { id: 'singleton' }
				});
				if (
					!settings?.offerSnapshot.trim() ||
					!isAutoRenewalOfferCompatible(settings.offerSnapshot)
				) {
					throw new ConflictException(
						'Условия автопродления обновляются. Повторите подтверждение позже'
					);
				}
				const offerSha256 = createHash('sha256')
					.update(settings.offerSnapshot, 'utf8')
					.digest('hex');
				if (
					settings.offerSectionHash &&
					settings.offerSectionHash !== offerSha256
				) {
					throw new ConflictException(
						'Условия автопродления обновляются. Повторите подтверждение позже'
					);
				}
				const confirmedAt = new Date();
				chargeMayStartImmediately =
					(renewal.nextRetryAt ?? renewal.nextChargeAt) <= confirmedAt;
				const changed = await transaction.autoRenewal.updateMany({
					where: {
						id: renewal.id,
						stateVersion: renewal.stateVersion,
						pendingAmount: renewal.pendingAmount
					},
					data: {
						amount: currentAmount,
						pendingAmount: null,
						priceChangeDetectedAt: null,
						consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
						consentText: AUTO_RENEWAL_CONSENT_TEXT,
						consentedAt: confirmedAt,
						offerSnapshot: settings.offerSnapshot,
						offerSha256,
						offerUpdatedAt: settings.offerUpdatedAt,
						stateVersion: { increment: 1 }
					}
				});
				if (changed.count !== 1) {
					throw new ConflictException(
						'Стоимость или состояние автопродления уже изменилось'
					);
				}
				await this.createRenewalEvent(
					transaction,
					renewal,
					AutoRenewalConsentEventType.PRICE_CHANGE_CONFIRMED,
					{ id: userId, role: 'USER', ...context },
					'CABINET',
					`Подтверждена новая стоимость ${currentAmount} ${renewal.currency}`,
					{
						amount: currentAmount,
						consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
						consentText: AUTO_RENEWAL_CONSENT_TEXT,
						offerSnapshot: settings.offerSnapshot,
						offerSha256,
						offerUpdatedAt: settings.offerUpdatedAt,
						metadata: {
							previousAmount: renewal.amount,
							newAmount: currentAmount,
							offerSha256
						}
					}
				);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		return {
			autoRenewal: await this.userAutoRenewal(userId),
			message: chargeMayStartImmediately
				? 'Новая стоимость подтверждена. Расчётная дата уже наступила, поэтому списание может начаться сразу.'
				: 'Новая стоимость подтверждена и будет применена при следующем плановом продлении.'
		};
	}

	async adminList(page = 1, limit = 20, filters: PaymentListFilters = {}) {
		const paging = this.pagination(page, limit, 100, 20);
		const and: Prisma.PaymentWhereInput[] = [];
		const status = this.normalizeAdminPaymentStatus(filters.status);
		const plan = this.normalizeAdminPaymentPlan(filters.plan);
		const billingPeriod = this.normalizeAdminPaymentBillingPeriod(
			filters.billingPeriod
		);
		const createdAt = this.getDateRangeFilter(
			filters.createdFrom,
			filters.createdTo
		);
		if (status) and.push({ status });
		if (plan !== undefined) and.push({ plan });
		if (billingPeriod !== undefined) and.push({ billingPeriod });
		if (createdAt) and.push({ createdAt });
		if (filters.search?.trim()) {
			const search = filters.search.trim();
			const identities =
				await this.prisma.identityContactProjection.findMany({
					where: {
						OR: [
							{ userId: { contains: search, mode: 'insensitive' } },
							{ name: { contains: search, mode: 'insensitive' } },
							{ email: { contains: search, mode: 'insensitive' } },
							{ phone: { contains: search, mode: 'insensitive' } }
						]
					},
					select: { userId: true }
				});
			and.push({
				OR: [
					{ id: { contains: search, mode: 'insensitive' } },
					{ yookassaId: { contains: search, mode: 'insensitive' } },
					{ userId: { in: identities.map(item => item.userId) } }
				]
			});
		}
		const where: Prisma.PaymentWhereInput = and.length ? { AND: and } : {};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.payment.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: paging.skip,
				take: paging.limit
			}),
			this.prisma.payment.count({ where })
		]);
		const users = await this.identityMap(items.map(item => item.userId));
		return {
			items: items.map(item =>
				this.adminPaymentItem(item, users.get(item.userId))
			),
			total,
			page: paging.page,
			limit: paging.limit,
			totalPages: Math.max(1, Math.ceil(total / paging.limit))
		};
	}

	async adminCheck(paymentId: string) {
		const normalizedPaymentId = paymentId.trim();
		if (!normalizedPaymentId) {
			throw new BadRequestException('Укажите ID платежа');
		}
		const payment = await this.prisma.payment.findFirst({
			where: {
				OR: [
					{ id: normalizedPaymentId },
					{ yookassaId: normalizedPaymentId }
				]
			}
		});
		if (!payment) throw new NotFoundException('Платёж не найден');
		if (payment.yookassaId) {
			const operationId = await this.queueVerification(
				payment.id,
				payment.yookassaId
			);
			await this.awaitProviderOperation(operationId);
		}
		const updated = await this.prisma.payment.findUnique({
			where: { id: payment.id }
		});
		if (!updated) throw new NotFoundException('Платёж не найден');
		const user = await this.prisma.identityContactProjection.findUnique({
			where: { userId: updated.userId }
		});
		const providerStatus =
			updated.providerStatus ??
			(updated.yookassaId ? 'unknown' : 'not_created');
		return {
			payment: this.adminPaymentItem(updated, user),
			providerStatus,
			message: this.adminCheckMessage(updated.status, providerStatus),
			checkedAt: new Date().toISOString()
		};
	}

	async runCleanup(actor: BillingAdminActor) {
		const now = new Date();
		const candidates = await this.prisma.payment.findMany({
			where: {
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { lte: now },
				providerOperations: {
					none: { status: ProviderOperationStatus.UNKNOWN }
				}
			},
			take: 500
		});
		let affectedCount = 0;
		for (const candidate of candidates) {
			const changed = await this.prisma.$transaction(async transaction => {
				const sequence = await this.nextSequence(transaction);
				const result = await transaction.payment.updateMany({
					where: { id: candidate.id, status: PaymentStatus.PENDING },
					data: {
						status: PaymentStatus.EXPIRED,
						cancellationReason: 'CHECKOUT_EXPIRED',
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				if (result.count !== 1) return false;
				const updated = await transaction.payment.findUniqueOrThrow({
					where: { id: candidate.id }
				});
				await this.emitPaymentState(transaction, updated);
				return true;
			});
			if (changed) affectedCount += 1;
		}
		const result = {
			taskId: 'paymentCleanup',
			title: 'Сверка просроченных платёжных попыток',
			affectedCount,
			message:
				affectedCount > 0
					? `Помечено просроченными: ${affectedCount}.`
					: 'Новые просроченные попытки не найдены.',
			executedAt: now.toISOString()
		};
		await this.adminAudit(actor, 'PAYMENT_CLEANUP_RUN', undefined, result);
		return result;
	}

	async adminAutoRenewal(userId: string, includeTechnical: boolean) {
		const detail = await this.getRenewalContext(userId);
		if (!detail.identity) {
			throw new NotFoundException('Пользователь не найден');
		}
		return this.serializeAdminAutoRenewal(
			detail.renewal,
			detail.identity,
			detail.subscription,
			includeTechnical
		);
	}

	async adminRenewalAction(
		userId: string,
		action: 'pause' | 'resume' | 'revoke' | 'resume-technical',
		dto: AdminAutoRenewalActionDto,
		actor: BillingAdminActor
	) {
		const target = {
			pause: {
				from: AutoRenewalStatus.ACTIVE,
				to: AutoRenewalStatus.ADMIN_PAUSED,
				type: AutoRenewalConsentEventType.ADMIN_PAUSED,
				audit: 'AUTO_RENEWAL_ADMIN_PAUSE' as const,
				message: 'Автопродление приостановлено.'
			},
			resume: {
				from: AutoRenewalStatus.ADMIN_PAUSED,
				to: AutoRenewalStatus.ACTIVE,
				type: AutoRenewalConsentEventType.ADMIN_RESUMED,
				audit: 'AUTO_RENEWAL_ADMIN_RESUME' as const,
				message: 'Автопродление возобновлено.'
			},
			revoke: {
				from: null,
				to: AutoRenewalStatus.REVOKED,
				type: AutoRenewalConsentEventType.ADMIN_REVOKED,
				audit: 'AUTO_RENEWAL_REVOKE' as const,
				message: 'Отзыв согласия зафиксирован.'
			},
			'resume-technical': {
				from: AutoRenewalStatus.TECHNICAL_PAUSE,
				to: AutoRenewalStatus.ACTIVE,
				type: AutoRenewalConsentEventType.TECHNICAL_RESUMED,
				audit: 'AUTO_RENEWAL_TECHNICAL_RESUME' as const,
				message:
					'Техническая пауза снята. Тот же идемпотентный запрос поставлен на безопасный повтор.'
			}
		}[action];

		await this.prisma.$transaction(
			async transaction => {
				const renewal = await this.lockRenewal(transaction, userId);
				if (!renewal) {
					throw new BadRequestException('Автопродление не подключено');
				}
				if (
					action === 'revoke' &&
					renewal.status === AutoRenewalStatus.REVOKED
				) {
					await this.clearFutureRecurringPayments(
						transaction,
						userId,
						'consent_revoked_before_provider_call'
					);
					return;
				}
				if (target.from && renewal.status !== target.from) {
					throw new ConflictException(
						'Dействие недоступно для текущего состояния автопродления'
					);
				}
				if (action === 'resume') {
					await this.assertCanResume(transaction, renewal, false);
				}

				let retryPayment: {
					id: string;
					recurringCycleKey: string | null;
				} | null = null;
				if (action === 'resume-technical') {
					if (
						!renewal.lastChargeErrorCode?.startsWith(
							'AUTO_RENEWAL_DELIVERY:'
						)
					) {
						throw new ForbiddenException(
							'Автоматический повтор небезопасен. Пользователь должен оформить подписку заново'
						);
					}
					await this.assertCanResume(transaction, renewal, true);
					const attempt = renewal.nextRetryAt ? renewal.retryAttempt : 0;
					const cycleKey = buildRecurringCycleKey(
						renewal.id,
						renewal.nextChargeAt,
						attempt
					);
					retryPayment = await transaction.payment.findFirst({
						where: {
							userId,
							recurringCycleKey: cycleKey,
							status: {
								in: [PaymentStatus.PENDING, PaymentStatus.EXPIRED]
							},
							checkoutExpiresAt: { gt: new Date() }
						},
						orderBy: { createdAt: 'desc' },
						select: { id: true, recurringCycleKey: true }
					});
					if (!retryPayment) {
						throw new ForbiddenException(
							'Безопасный запрос для повтора не найден. Пользователь должен оформить подписку заново'
						);
					}
				}

				const destructive = action === 'revoke';
				const changed = await transaction.autoRenewal.updateMany({
					where: {
						id: renewal.id,
						stateVersion: renewal.stateVersion,
						...(target.from ? { status: target.from } : {})
					},
					data: {
						status: target.to,
						disabledAt:
							target.to === AutoRenewalStatus.ACTIVE ? null : new Date(),
						disableReason:
							target.to === AutoRenewalStatus.ACTIVE ? null : dto.reason,
						...(action === 'resume-technical'
							? { lastChargeErrorCode: null }
							: {}),
						...(destructive
							? {
									paymentMethodCiphertext: null,
									paymentMethodType: null,
									paymentMethodTitle: null,
									paymentMethodLast4: null,
									paymentMethodSavedAt: null,
									retryStartedAt: null,
									retryAttempt: 0,
									nextRetryAt: null,
									dispatchPending: false
								}
							: {}),
						stateVersion: { increment: 1 }
					}
				});
				if (changed.count !== 1) {
					throw new ConflictException(
						'Состояние автопродления уже изменилось'
					);
				}
				if (destructive) {
					await this.clearFutureRecurringPayments(
						transaction,
						userId,
						'consent_revoked_before_provider_call'
					);
				}
				await this.createRenewalEvent(
					transaction,
					renewal,
					target.type,
					actor,
					action === 'resume-technical' ? 'DEV' : 'ADMIN',
					dto.reason
				);
				if (retryPayment) {
					const eventId = randomUUID();
					await transaction.outboxEvent.create({
						data: {
							eventId,
							deduplicationKey: `resume-technical:${retryPayment.id}:${renewal.stateVersion}`,
							eventType: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
							aggregateType: 'payment.auto-renewal',
							aggregateId: retryPayment.id,
							exchange: BILLING_EVENTS_EXCHANGE,
							routingKey: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
							payload: {
								schemaVersion: 1,
								eventType: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
								paymentId: retryPayment.id,
								autoRenewalId: renewal.id,
								cycleKey: retryPayment.recurringCycleKey,
								scheduledFor: (
									renewal.nextRetryAt ?? renewal.nextChargeAt
								).toISOString()
							} as Prisma.InputJsonValue
						}
					});
				}
				await this.createAdminAuditOutbox(
					transaction,
					actor,
					target.audit,
					userId,
					{
						reason: dto.reason,
						autoRenewalId: renewal.id,
						status: target.to,
						amount: renewal.amount,
						currency: renewal.currency,
						nextChargeAt: renewal.nextChargeAt.toISOString(),
						priceChangeRequired: Boolean(renewal.pendingAmount),
						result: target.message
					}
				);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		return {
			autoRenewal: await this.adminAutoRenewal(
				userId,
				actor.role === 'DEV'
			),
			message: target.message
		};
	}

	async reconcile(userId: string, actor: BillingAdminActor) {
		const detail = await this.getRenewalContext(userId);
		if (!detail.identity)
			throw new NotFoundException('Пользователь не найден');
		if (!detail.renewal) {
			const result = {
				autoRenewal: this.serializeAdminAutoRenewal(
					null,
					detail.identity,
					detail.subscription,
					true
				),
				message: 'Автопродление ранее не подключалось.'
			};
			await this.adminAudit(actor, 'AUTO_RENEWAL_RECONCILE', userId, {
				reason: null,
				status: result.autoRenewal.status,
				amount: result.autoRenewal.amount,
				currency: result.autoRenewal.currency,
				nextChargeAt: result.autoRenewal.nextChargeAt,
				priceChangeRequired: result.autoRenewal.priceChange.required,
				result: result.message
			});
			return result;
		}
		const renewal = detail.renewal;
		const pending = await this.prisma.payment.findMany({
			where: {
				userId,
				status: PaymentStatus.PENDING,
				yookassaId: { not: null }
			}
		});
		for (const payment of pending) {
			await this.queueVerification(payment.id, payment.yookassaId!);
		}
		const amount = await this.currentAmount(
			this.prisma,
			renewal.plan,
			renewal.billingPeriod
		);
		let technicalError: string | null = null;
		if (!renewal.paymentMethodCiphertext) {
			technicalError = 'PAYMENT_METHOD_MISSING';
		} else {
			try {
				this.crypto.decrypt(renewal.paymentMethodCiphertext);
			} catch {
				technicalError = 'PAYMENT_METHOD_DECRYPT_FAILED';
			}
		}
		await this.prisma.$transaction(
			async transaction => {
				const locked = await this.lockRenewal(transaction, userId);
				if (!locked) return;
				const data: Prisma.AutoRenewalUpdateManyMutationInput = {};
				if (amount !== locked.amount) {
					data.pendingAmount = amount;
					data.priceChangeDetectedAt =
						locked.priceChangeDetectedAt ?? new Date();
				}
				if (
					technicalError &&
					locked.status !== AutoRenewalStatus.REVOKED &&
					locked.status !== AutoRenewalStatus.USER_DISABLED
				) {
					data.status = AutoRenewalStatus.TECHNICAL_PAUSE;
					data.disabledAt = new Date();
					data.disableReason =
						'Автопродление остановлено после технической сверки';
					data.lastChargeErrorCode = technicalError;
				}
				if (!Object.keys(data).length) return;
				data.stateVersion = { increment: 1 };
				const changed = await transaction.autoRenewal.updateMany({
					where: { id: locked.id, stateVersion: locked.stateVersion },
					data
				});
				if (changed.count !== 1) {
					throw new ConflictException(
						'Состояние автопродления изменилось параллельно'
					);
				}
				if (
					data.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
					locked.status !== AutoRenewalStatus.TECHNICAL_PAUSE
				) {
					await this.createRenewalEvent(
						transaction,
						locked,
						AutoRenewalConsentEventType.TECHNICAL_PAUSED,
						actor,
						'DEV_RECONCILE',
						technicalError || 'TECHNICAL_RECONCILE'
					);
				}
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		const result = {
			autoRenewal: await this.adminAutoRenewal(userId, true),
			message: 'Состояние автопродления сверено.'
		};
		await this.adminAudit(actor, 'AUTO_RENEWAL_RECONCILE', userId, {
			autoRenewalId: renewal.id,
			reason: null,
			status: result.autoRenewal.status,
			amount: result.autoRenewal.amount,
			currency: result.autoRenewal.currency,
			nextChargeAt: result.autoRenewal.nextChargeAt,
			priceChangeRequired: result.autoRenewal.priceChange.required,
			result: result.message
		});
		return result;
	}

	async webhook(body: unknown) {
		if (!body || typeof body !== 'object') return { ok: true };
		const root = body as Record<string, unknown>;
		const event = typeof root.event === 'string' ? root.event : '';
		const object =
			root.object && typeof root.object === 'object'
				? (root.object as Record<string, unknown>)
				: {};
		if (event === 'payment.succeeded' || event === 'payment.canceled') {
			const providerPaymentId =
				typeof object.id === 'string' ? object.id : '';
			if (!providerPaymentId) return { ok: true };
			const metadata =
				object.metadata && typeof object.metadata === 'object'
					? (object.metadata as Record<string, unknown>)
					: {};
			let paymentId =
				typeof metadata.paymentId === 'string'
					? metadata.paymentId
					: undefined;
			if (!paymentId) {
				paymentId = (
					await this.prisma.payment.findUnique({
						where: { yookassaId: providerPaymentId },
						select: { id: true }
					})
				)?.id;
			}
			await this.prisma.providerOperation.createMany({
				data: {
					paymentId,
					providerPaymentId,
					idempotencyKey: `webhook:${event}:${providerPaymentId}`,
					kind: ProviderOperationKind.VERIFY_PAYMENT,
					payload: {
						paymentId,
						providerPaymentId,
						source: 'webhook',
						event
					}
				},
				skipDuplicates: true
			});
		} else if (
			event === 'receipt.succeeded' ||
			event === 'receipt.canceled'
		) {
			const providerPaymentId =
				typeof object.payment_id === 'string' ? object.payment_id : '';
			if (!providerPaymentId) return { ok: true };
			const paymentId = (
				await this.prisma.payment.findUnique({
					where: { yookassaId: providerPaymentId },
					select: { id: true }
				})
			)?.id;
			const receiptId =
				typeof object.id === 'string' ? object.id : providerPaymentId;
			await this.prisma.providerOperation.createMany({
				data: {
					paymentId,
					providerPaymentId,
					idempotencyKey: `webhook:${event}:${receiptId}`,
					kind: ProviderOperationKind.SYNC_RECEIPT,
					payload: {
						paymentId,
						providerPaymentId,
						receiptId,
						source: 'webhook',
						event
					}
				},
				skipDuplicates: true
			});
		}
		return { ok: true };
	}

	async bindProviderState(
		paymentId: string,
		input: {
			providerPaymentId: string;
			providerStatus: string;
			confirmationUrl?: string | null;
			providerCreatedAt?: Date | null;
			providerExpiresAt?: Date | null;
			providerSnapshot?: Record<string, unknown>;
		}
	) {
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw`
					SELECT id FROM billing.payments WHERE id = ${paymentId} FOR UPDATE
				`;
				const current = await transaction.payment.findUnique({
					where: { id: paymentId }
				});
				if (!current) throw new NotFoundException('Платёж не найден');
				if (
					current.yookassaId &&
					current.yookassaId !== input.providerPaymentId
				) {
					throw new ConflictException(
						'Provider payment ID conflicts with local payment'
					);
				}
				const owner = await transaction.payment.findFirst({
					where: {
						yookassaId: input.providerPaymentId,
						id: { not: paymentId }
					},
					select: { id: true }
				});
				if (owner)
					throw new ConflictException(
						'Provider payment ID is already bound'
					);
				const sequence = await this.nextSequence(transaction);
				const updated = await transaction.payment.update({
					where: { id: paymentId },
					data: {
						yookassaId: input.providerPaymentId,
						providerStatus: input.providerStatus,
						confirmationUrl:
							input.confirmationUrl ?? current.confirmationUrl,
						providerCreatedAt: input.providerCreatedAt,
						providerExpiresAt: input.providerExpiresAt,
						checkoutExpiresAt:
							input.providerExpiresAt &&
							input.providerExpiresAt > new Date() &&
							input.providerExpiresAt < current.checkoutExpiresAt
								? input.providerExpiresAt
								: current.checkoutExpiresAt,
						lastProviderCheckedAt: new Date(),
						providerSnapshot:
							input.providerSnapshot as Prisma.InputJsonValue,
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await this.emitPaymentState(transaction, updated);
				return updated;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async markProviderCancelled(
		paymentId: string,
		providerPaymentId: string | null,
		providerStatus: string,
		cancellationReason = 'provider_cancelled'
	) {
		const candidate = await this.prisma.payment.findUnique({
			where: { id: paymentId },
			select: { userId: true }
		});
		if (!candidate) throw new NotFoundException('Платёж не найден');
		return this.prisma.$transaction(
			async transaction => {
				await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${candidate.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.auto_renewals
					WHERE user_id = ${candidate.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.payments WHERE id = ${paymentId} FOR UPDATE
				`;
				const current = await transaction.payment.findUnique({
					where: { id: paymentId }
				});
				if (!current) throw new NotFoundException('Платёж не найден');
				if (current.status === PaymentStatus.SUCCEEDED) return current;
				if (
					current.status === PaymentStatus.CANCELLED &&
					current.providerStatus === providerStatus &&
					current.cancellationReason === cancellationReason
				) {
					return current;
				}
				const now = new Date();
				const sequence = await this.nextSequence(transaction);
				const updated = await transaction.payment.update({
					where: { id: paymentId },
					data: {
						yookassaId: providerPaymentId || current.yookassaId,
						providerStatus,
						status: PaymentStatus.CANCELLED,
						paymentMethodCiphertext: null,
						confirmationUrl: null,
						cancelledAt: current.cancelledAt ?? now,
						cancellationReason,
						lastProviderCheckedAt: now,
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await this.applyRecurringCancellation(
					transaction,
					current,
					cancellationReason,
					now
				);
				await this.cancelAffiliateReward(transaction, current.id, now);
				await this.emitPaymentState(transaction, updated);
				return updated;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 5_000,
				timeout: 30_000
			}
		);
	}

	async adminAudit(
		actor: BillingAdminActor,
		action: BillingAdminAuditAction,
		targetUserId?: string,
		metadata: Record<string, unknown> = {}
	): Promise<void> {
		await this.prisma.$transaction(transaction =>
			this.createAdminAuditOutbox(
				transaction,
				actor,
				action,
				targetUserId,
				metadata
			)
		);
	}

	private async emitPaymentState(
		transaction: Prisma.TransactionClient,
		payment: {
			id: string;
			userId: string;
			yookassaId: string | null;
			status: PaymentStatus;
			amount: string;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			aggregateVersion: bigint;
			sourceSequence: bigint;
			createdAt: Date;
			updatedAt: Date;
		}
	): Promise<void> {
		const occurredAt = payment.updatedAt.toISOString();
		await Promise.all([
			this.outbox(
				transaction,
				BILLING_EVENT_TYPES.paymentChanged,
				payment,
				{
					id: payment.id,
					userId: payment.userId,
					amount: payment.amount,
					status: payment.status,
					createdAt: payment.createdAt.toISOString(),
					updatedAt: payment.updatedAt.toISOString()
				},
				occurredAt
			),
			this.outbox(
				transaction,
				BILLING_EVENT_TYPES.paymentDetailsChanged,
				payment,
				{
					id: payment.id,
					userId: payment.userId,
					yookassaId: payment.yookassaId,
					status: payment.status,
					amount: payment.amount,
					plan: payment.plan,
					billingPeriod: payment.billingPeriod,
					createdAt: payment.createdAt.toISOString(),
					updatedAt: payment.updatedAt.toISOString()
				},
				occurredAt
			)
		]);
	}

	private async outbox(
		transaction: Prisma.TransactionClient,
		eventType: string,
		aggregate: {
			id: string;
			aggregateVersion: bigint;
			sourceSequence: bigint;
		},
		state: Record<string, unknown>,
		occurredAt: string
	): Promise<void> {
		const eventId = randomUUID();
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: eventType.replace('.changed.v1', ''),
				aggregateId: aggregate.id,
				aggregateVersion: aggregate.aggregateVersion,
				sourceSequence: aggregate.sourceSequence,
				correlationId: getBillingCorrelationId(),
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: aggregate.id,
					aggregateVersion: aggregate.aggregateVersion.toString(),
					sourceSequence: aggregate.sourceSequence.toString(),
					occurredAt,
					tombstone: false,
					state
				} as Prisma.InputJsonValue
			}
		});
	}

	private async createRenewalEvent(
		transaction: Prisma.TransactionClient,
		renewal: {
			id: string;
			userId: string;
			consentVersion: string;
			consentText: string;
			offerSnapshot: string | null;
			offerSha256: string | null;
			offerUpdatedAt: Date | null;
			plan: Plan;
			billingPeriod: BillingPeriod;
			amount: string;
			currency: string;
		},
		type: AutoRenewalConsentEventType,
		actor: {
			id: string;
			role: string;
			ip?: string | null;
			userAgent?: string | null;
		},
		source: string,
		reason?: string,
		overrides: {
			amount?: string;
			consentVersion?: string;
			consentText?: string;
			offerSnapshot?: string | null;
			offerSha256?: string | null;
			offerUpdatedAt?: Date | null;
			metadata?: Prisma.InputJsonValue;
		} = {}
	): Promise<void> {
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type,
				actorUserId: actor.id,
				actorRole: actor.role,
				source,
				reason,
				consentVersion: overrides.consentVersion ?? renewal.consentVersion,
				consentText: overrides.consentText ?? renewal.consentText,
				offerSnapshot:
					overrides.offerSnapshot === undefined
						? renewal.offerSnapshot
						: overrides.offerSnapshot,
				offerSha256:
					overrides.offerSha256 === undefined
						? renewal.offerSha256
						: overrides.offerSha256,
				offerUpdatedAt:
					overrides.offerUpdatedAt === undefined
						? renewal.offerUpdatedAt
						: overrides.offerUpdatedAt,
				plan: renewal.plan,
				billingPeriod: renewal.billingPeriod,
				amount: overrides.amount ?? renewal.amount,
				currency: renewal.currency,
				ip: actor.ip ?? null,
				userAgent: actor.userAgent ?? null,
				metadata: overrides.metadata ?? {}
			}
		});
	}

	private async createAdminAuditOutbox(
		transaction: Prisma.TransactionClient,
		actor: BillingAdminActor,
		action: BillingAdminAuditAction,
		targetUserId: string | undefined,
		metadata: Record<string, unknown>
	): Promise<void> {
		const descriptors: Record<
			BillingAdminAuditAction,
			{
				section:
					| 'PAYMENTS'
					| 'SUBSCRIPTIONS'
					| 'AFFILIATE'
					| 'SITE_SETTINGS'
					| 'TASKS'
					| 'MESSAGING';
				description: string;
				entityType: string;
			}
		> = {
			PAYMENT_MANUAL_CHECK: {
				section: 'PAYMENTS',
				description: 'Ручная проверка платежа',
				entityType: 'payment'
			},
			PAYMENT_CLEANUP_RUN: {
				section: 'TASKS',
				description: 'Сверка просроченных платёжных попыток',
				entityType: 'manual_task'
			},
			TARIFF_PRICES_UPDATE: {
				section: 'PAYMENTS',
				description: 'Обновлены тарифные цены',
				entityType: 'tariff_prices'
			},
			SUBSCRIPTION_ACTIVATE: {
				section: 'SUBSCRIPTIONS',
				description: 'Ручная активация подписки',
				entityType: 'subscription'
			},
			SUBSCRIPTION_EXTEND_DAYS: {
				section: 'SUBSCRIPTIONS',
				description: 'Начислены бонусные дни',
				entityType: 'subscription'
			},
			SUBSCRIPTION_CANCEL: {
				section: 'SUBSCRIPTIONS',
				description: 'Ручная отмена подписки',
				entityType: 'subscription'
			},
			SUBSCRIPTION_EXPIRY_CHECK_RUN: {
				section: 'TASKS',
				description: 'Проверка истёкших подписок',
				entityType: 'manual_task'
			},
			AUTO_RENEWAL_ADMIN_PAUSE: {
				section: 'PAYMENTS',
				description: 'Автопродление пользователя приостановлено',
				entityType: 'auto_renewal'
			},
			AUTO_RENEWAL_ADMIN_RESUME: {
				section: 'PAYMENTS',
				description: 'Автопродление пользователя возобновлено',
				entityType: 'auto_renewal'
			},
			AUTO_RENEWAL_REVOKE: {
				section: 'PAYMENTS',
				description: 'Согласие пользователя на автопродление отозвано',
				entityType: 'auto_renewal'
			},
			AUTO_RENEWAL_RECONCILE: {
				section: 'PAYMENTS',
				description: 'Выполнена техническая сверка автопродления',
				entityType: 'auto_renewal'
			},
			AUTO_RENEWAL_TECHNICAL_RESUME: {
				section: 'PAYMENTS',
				description: 'Техническая пауза автопродления снята',
				entityType: 'auto_renewal'
			},
			AFFILIATE_SETTINGS_UPDATE: {
				section: 'AFFILIATE',
				description: 'Настройки партнёрской программы обновлены',
				entityType: 'affiliate_settings'
			},
			SITE_SETTINGS_UPDATE: {
				section: 'SITE_SETTINGS',
				description: 'Настройки сайта обновлены',
				entityType: 'site_settings'
			},
			BILLING_DELIVERY_RETRY: {
				section: 'MESSAGING',
				description: 'Повтор доставки Billing поставлен в очередь',
				entityType: 'billing_delivery'
			}
		};
		const descriptor = descriptors[action];
		const paymentId = metadata.paymentId;
		const yookassaId = metadata.yookassaId;
		const autoRenewalId = metadata.autoRenewalId;
		const eventMetadata = { ...metadata };
		if (action === 'PAYMENT_MANUAL_CHECK') {
			delete eventMetadata.paymentId;
			delete eventMetadata.yookassaId;
		}
		if (action.startsWith('AUTO_RENEWAL_')) {
			delete eventMetadata.autoRenewalId;
		}
		const entityId = String(
			paymentId ||
				autoRenewalId ||
				metadata.taskId ||
				targetUserId ||
				action
		);
		await enqueueBillingAdminAudit(transaction, {
			actor,
			section: descriptor.section,
			action,
			description:
				action === 'PAYMENT_MANUAL_CHECK'
					? `Ручная проверка платежа ${String(yookassaId)}`
					: descriptor.description,
			entity: {
				type: descriptor.entityType,
				id: entityId,
				label:
					action === 'PAYMENT_MANUAL_CHECK'
						? typeof yookassaId === 'string'
							? yookassaId
							: null
						: action.startsWith('AUTO_RENEWAL_')
							? entityId
							: typeof metadata.title === 'string'
								? metadata.title
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

	private assertSameCreateRequest(
		payment: {
			kind: PaymentKind;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			amount: string;
			autoRenew: boolean;
		},
		dto: CreatePaymentDto,
		amount: number
	): void {
		if (
			payment.kind !== PaymentKind.ONE_TIME ||
			payment.plan !== dto.plan ||
			payment.billingPeriod !== dto.billingPeriod ||
			payment.amount !== this.formatAmount(amount) ||
			payment.autoRenew !== (dto.autoRenew ?? false)
		) {
			throw new ConflictException(
				'Другой активный платёж ещё не завершён. Повторите попытку после его завершения.'
			);
		}
	}

	private async awaitCreatedPayment(paymentId: string) {
		const deadline = Date.now() + PROVIDER_COMMAND_TIMEOUT_MS;
		let ensuredOperation = false;
		while (Date.now() < deadline) {
			const payment = await this.prisma.payment.findUnique({
				where: { id: paymentId },
				include: {
					providerOperations: {
						where: { kind: ProviderOperationKind.CREATE_CHECKOUT },
						orderBy: { createdAt: 'desc' },
						take: 1
					}
				}
			});
			if (!payment) {
				throw new ServiceUnavailableException(
					'ЮKassa временно недоступна. Повторите создание этого же платежа — двойного списания не будет'
				);
			}
			if (payment.confirmationUrl) return this.createResponse(payment);
			const operation = payment.providerOperations[0];
			if (
				payment.status === PaymentStatus.CANCELLED ||
				payment.status === PaymentStatus.EXPIRED ||
				operation?.status === ProviderOperationStatus.FAILED
			) {
				throw new BadRequestException('ЮKassa отклонила создание платежа');
			}
			if (operation?.status === ProviderOperationStatus.UNKNOWN) {
				throw this.providerCreationUnavailable();
			}
			if (operation?.status === ProviderOperationStatus.SUCCEEDED) {
				throw new ServiceUnavailableException(
					'ЮKassa не вернула ссылку на оплату'
				);
			}
			if (
				!operation &&
				!ensuredOperation &&
				payment.providerIdempotencyKey
			) {
				ensuredOperation = true;
				await this.prisma.providerOperation.upsert({
					where: { idempotencyKey: payment.providerIdempotencyKey },
					create: {
						paymentId: payment.id,
						idempotencyKey: payment.providerIdempotencyKey,
						kind: ProviderOperationKind.CREATE_CHECKOUT,
						payload: { paymentId: payment.id, recovered: true }
					},
					update: {}
				});
			}
			await this.pause(PROVIDER_COMMAND_POLL_MS);
		}
		throw this.providerCreationUnavailable();
	}

	private async awaitProviderOperation(
		operationId: string
	): Promise<void> {
		const deadline = Date.now() + PROVIDER_COMMAND_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const operation = await this.prisma.providerOperation.findUnique({
				where: { id: operationId },
				select: { status: true }
			});
			if (!operation) throw this.providerCreationUnavailable();
			if (
				operation.status === ProviderOperationStatus.SUCCEEDED ||
				operation.status === ProviderOperationStatus.FAILED
			) {
				return;
			}
			if (operation.status === ProviderOperationStatus.UNKNOWN) {
				throw this.providerCreationUnavailable();
			}
			await this.pause(PROVIDER_COMMAND_POLL_MS);
		}
		throw this.providerCreationUnavailable();
	}

	private providerCreationUnavailable(): ServiceUnavailableException {
		return new ServiceUnavailableException(
			'ЮKassa временно недоступна. Повторите создание этого же платежа — двойного списания не будет'
		);
	}

	private async cleanupStalePendingForUser(userId: string): Promise<void> {
		const candidates = await this.prisma.payment.findMany({
			where: {
				userId,
				kind: PaymentKind.ONE_TIME,
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { lte: new Date() },
				providerOperations: {
					none: {
						status: {
							in: [
								ProviderOperationStatus.PROCESSING,
								ProviderOperationStatus.UNKNOWN
							]
						}
					}
				}
			},
			select: { id: true },
			take: 20
		});
		for (const candidate of candidates) {
			await this.prisma.$transaction(async transaction => {
				await transaction.$queryRaw`
					SELECT id FROM billing.payments WHERE id = ${candidate.id} FOR UPDATE
				`;
				const current = await transaction.payment.findUnique({
					where: { id: candidate.id }
				});
				if (
					!current ||
					current.status !== PaymentStatus.PENDING ||
					current.checkoutExpiresAt > new Date()
				)
					return;
				const inFlight = await transaction.providerOperation.count({
					where: {
						paymentId: current.id,
						status: {
							in: [
								ProviderOperationStatus.PROCESSING,
								ProviderOperationStatus.UNKNOWN
							]
						}
					}
				});
				if (inFlight > 0) return;
				const sequence = await this.nextSequence(transaction);
				const updated = await transaction.payment.update({
					where: { id: current.id },
					data: {
						status: PaymentStatus.EXPIRED,
						confirmationUrl: null,
						cancellationReason: 'checkout_expired',
						aggregateVersion: { increment: 1n },
						sourceSequence: sequence
					}
				});
				await transaction.providerOperation.updateMany({
					where: {
						paymentId: current.id,
						status: ProviderOperationStatus.PENDING
					},
					data: {
						status: ProviderOperationStatus.FAILED,
						lastErrorCode: 'CHECKOUT_EXPIRED',
						lastErrorSafe: 'Срок локального checkout истёк'
					}
				});
				await this.emitPaymentState(transaction, updated);
			});
		}
	}

	private async getRenewalContext(userId: string): Promise<{
		identity: IdentityContactProjection | null;
		subscription: Subscription | null;
		renewal: AutoRenewal | null;
	}> {
		const [identity, subscription, renewal] = await Promise.all([
			this.prisma.identityContactProjection.findUnique({
				where: { userId }
			}),
			this.prisma.subscription.findUnique({ where: { userId } }),
			this.prisma.autoRenewal.findUnique({ where: { userId } })
		]);
		return { identity, subscription, renewal };
	}

	private async lockRenewal(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<AutoRenewal | null> {
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
		return transaction.autoRenewal.findUnique({ where: { userId } });
	}

	private async currentAmount(
		client: Pick<Prisma.TransactionClient, 'tariffPrice'>,
		plan: Plan,
		billingPeriod: BillingPeriod
	): Promise<string> {
		if (plan === Plan.TRIAL) {
			throw new ConflictException(
				'Для тестового тарифа автопродление недоступно'
			);
		}
		const price = await client.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		return this.formatAmount(
			price?.amount ?? DEFAULT_PRICES[plan][billingPeriod]
		);
	}

	private isUserEligible(
		identity: Pick<
			IdentityContactProjection,
			'status' | 'deletedAt'
		> | null,
		subscription: Pick<Subscription, 'status' | 'expiresAt'> | null
	): boolean {
		return Boolean(
			identity &&
			!identity.deletedAt &&
			identity.status === 'ACTIVE' &&
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.expiresAt &&
			subscription.expiresAt > new Date()
		);
	}

	private isChargeWindowEligible(
		identity: Pick<
			IdentityContactProjection,
			'status' | 'deletedAt'
		> | null,
		subscription: Pick<
			Subscription,
			'status' | 'expiresAt' | 'plan' | 'billingPeriod'
		> | null,
		renewal: AutoRenewal
	): boolean {
		const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
		const graceMs = renewal.nextRetryAt
			? AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
			: AUTO_RENEWAL_DUE_GRACE_MS;
		return Boolean(
			identity &&
			!identity.deletedAt &&
			identity.status === 'ACTIVE' &&
			subscription?.expiresAt &&
			(subscription.status === SubscriptionStatus.ACTIVE ||
				subscription.status === SubscriptionStatus.EXPIRED) &&
			subscription.plan === renewal.plan &&
			subscription.billingPeriod === renewal.billingPeriod &&
			Date.now() <= dueAt.getTime() + graceMs
		);
	}

	private async assertCanResume(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		allowTechnicalGrace: boolean
	): Promise<void> {
		const [identity, subscription] = await Promise.all([
			transaction.identityContactProjection.findUnique({
				where: { userId: renewal.userId }
			}),
			transaction.subscription.findUnique({
				where: { userId: renewal.userId }
			})
		]);
		if (
			!this.isUserEligible(identity, subscription) &&
			(!allowTechnicalGrace ||
				!this.isChargeWindowEligible(identity, subscription, renewal))
		) {
			throw new ForbiddenException(
				'Пользователь или оплаченный период неактивен'
			);
		}
		if (!renewal.paymentMethodCiphertext) {
			throw new ForbiddenException(
				'Сохранённый способ оплаты отсутствует'
			);
		}
		try {
			this.crypto.decrypt(renewal.paymentMethodCiphertext);
		} catch {
			throw new ForbiddenException(
				'Сохранённый способ оплаты не удалось проверить'
			);
		}
		const amount = await this.currentAmount(
			transaction,
			renewal.plan,
			renewal.billingPeriod
		);
		if (renewal.pendingAmount || amount !== renewal.amount) {
			throw new ForbiddenException(
				'Пользователь должен подтвердить актуальную стоимость'
			);
		}
	}

	private async clearFutureRecurringPayments(
		transaction: Prisma.TransactionClient,
		userId: string,
		reason: string
	): Promise<void> {
		const payments = await transaction.payment.findMany({
			where: {
				userId,
				kind: PaymentKind.RECURRING,
				OR: [
					{
						status: PaymentStatus.PENDING,
						yookassaId: null
					},
					{ paymentMethodCiphertext: { not: null } }
				]
			},
			orderBy: { createdAt: 'asc' }
		});
		for (const payment of payments) {
			await transaction.$queryRaw`
				SELECT id FROM billing.payments WHERE id = ${payment.id} FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT id FROM billing.provider_operations
				WHERE payment_id = ${payment.id}
					AND kind = 'CAPTURE_RECURRING'::billing."ProviderOperationKind"
				FOR UPDATE
			`;
			const ambiguousOperation =
				await transaction.providerOperation.findFirst({
					where: {
						paymentId: payment.id,
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
					'Списание уже обрабатывается. Повторите отключение автопродления после завершения проверки'
				);
			}
			await transaction.providerOperation.updateMany({
				where: {
					paymentId: payment.id,
					kind: ProviderOperationKind.CAPTURE_RECURRING,
					status: ProviderOperationStatus.PENDING
				},
				data: {
					status: ProviderOperationStatus.FAILED,
					lastErrorCode: 'RENEWAL_REVOKED',
					lastErrorSafe: reason
				}
			});
			const sequence = await this.nextSequence(transaction);
			const queued =
				payment.status === PaymentStatus.PENDING && !payment.yookassaId;
			const creating = queued && payment.providerStatus === 'creating';
			const updated = await transaction.payment.update({
				where: { id: payment.id },
				data: {
					...(queued
						? {
								status: creating
									? PaymentStatus.EXPIRED
									: PaymentStatus.CANCELLED,
								providerStatus: creating ? 'unknown' : 'not_sent',
								cancelledAt: creating ? payment.cancelledAt : new Date(),
								cancellationReason: reason,
								confirmationUrl: null
							}
						: {}),
					paymentMethodCiphertext: null,
					aggregateVersion: { increment: 1n },
					sourceSequence: sequence
				}
			});
			await this.emitPaymentState(transaction, updated);
		}
	}

	private async applyRecurringCancellation(
		transaction: Prisma.TransactionClient,
		payment: Payment,
		reason: string,
		now: Date
	): Promise<void> {
		if (payment.kind !== PaymentKind.RECURRING) return;
		const renewal = await transaction.autoRenewal.findUnique({
			where: { userId: payment.userId }
		});
		if (
			!renewal ||
			renewal.status === AutoRenewalStatus.TECHNICAL_PAUSE ||
			renewal.status === AutoRenewalStatus.USER_DISABLED ||
			renewal.status === AutoRenewalStatus.ADMIN_PAUSED ||
			renewal.status === AutoRenewalStatus.REVOKED
		) {
			return;
		}
		if (
			payment.recurringAttempt !== renewal.retryAttempt ||
			payment.consentedAt?.getTime() !== renewal.consentedAt.getTime() ||
			payment.recurringCycleKey !==
				buildRecurringCycleKey(
					renewal.id,
					renewal.nextChargeAt,
					payment.recurringAttempt
				)
		) {
			return;
		}

		const canScheduleRetry =
			isAutoRenewalRetryableCancellation(reason) &&
			payment.recurringAttempt < AUTO_RENEWAL_RETRY_DELAYS_MS.length;
		if (canScheduleRetry) {
			const nextAttempt = payment.recurringAttempt + 1;
			const retryStartedAt = renewal.retryStartedAt ?? now;
			const nextRetryAt = new Date(
				retryStartedAt.getTime() +
					AUTO_RENEWAL_RETRY_DELAYS_MS[nextAttempt - 1]
			);
			const changed = await transaction.autoRenewal.updateMany({
				where: {
					id: renewal.id,
					status: AutoRenewalStatus.ACTIVE,
					stateVersion: renewal.stateVersion
				},
				data: {
					retryStartedAt,
					retryAttempt: nextAttempt,
					nextRetryAt,
					dispatchPending: false,
					disabledAt: null,
					disableReason: null,
					lastChargeAttemptAt: now,
					lastChargeErrorCode: reason,
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления изменилось параллельно'
				);
			}
			await transaction.autoRenewalConsentEvent.create({
				data: {
					autoRenewalId: renewal.id,
					userId: renewal.userId,
					type: AutoRenewalConsentEventType.RETRY_SCHEDULED,
					source: 'YOOKASSA',
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
					metadata: {
						paymentId: payment.id,
						failedAttempt: payment.recurringAttempt,
						nextAttempt,
						nextRetryAt: nextRetryAt.toISOString(),
						maxRetryAttempts: AUTO_RENEWAL_RETRY_DELAYS_MS.length
					}
				}
			});
			return;
		}

		const permissionRevoked = reason === 'permission_revoked';
		const retriesExhausted =
			isAutoRenewalRetryableCancellation(reason) &&
			payment.recurringAttempt >= AUTO_RENEWAL_RETRY_DELAYS_MS.length;
		const status = permissionRevoked
			? AutoRenewalStatus.REVOKED
			: AutoRenewalStatus.TECHNICAL_PAUSE;
		const changed = await transaction.autoRenewal.updateMany({
			where: { id: renewal.id, stateVersion: renewal.stateVersion },
			data: {
				status,
				disabledAt: now,
				disableReason: permissionRevoked
					? 'Разрешение на повторные списания отозвано у платёжного провайдера'
					: retriesExhausted
						? 'Повторные попытки списания исчерпаны'
						: `Автосписание не выполнено: ${reason}`,
				nextRetryAt: null,
				dispatchPending: false,
				lastChargeAttemptAt: now,
				lastChargeErrorCode: reason,
				...(permissionRevoked
					? {
							paymentMethodCiphertext: null,
							paymentMethodType: null,
							paymentMethodTitle: null,
							paymentMethodLast4: null,
							paymentMethodSavedAt: null
						}
					: {}),
				stateVersion: { increment: 1 }
			}
		});
		if (changed.count !== 1) {
			throw new ConflictException(
				'Состояние автопродления изменилось параллельно'
			);
		}
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: permissionRevoked
					? AutoRenewalConsentEventType.ADMIN_REVOKED
					: retriesExhausted
						? AutoRenewalConsentEventType.RETRY_EXHAUSTED
						: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
				source: 'YOOKASSA',
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
				metadata: {
					paymentId: payment.id,
					failedAttempt: payment.recurringAttempt,
					maxRetryAttempts: AUTO_RENEWAL_RETRY_DELAYS_MS.length
				}
			}
		});
	}

	private async cancelAffiliateReward(
		transaction: Prisma.TransactionClient,
		paymentId: string,
		cancelledAt: Date
	): Promise<void> {
		const candidate = await transaction.affiliateReferral.findFirst({
			where: {
				firstPaymentId: paymentId,
				status: 'REWARD_PENDING'
			},
			select: { id: true }
		});
		if (!candidate) return;
		await transaction.$queryRaw`
			SELECT id FROM billing.affiliate_referrals
			WHERE id = ${candidate.id}
			FOR UPDATE
		`;
		const current = await transaction.affiliateReferral.findUnique({
			where: { id: candidate.id }
		});
		if (!current || current.status !== 'REWARD_PENDING') return;
		const sequence = await this.nextSequence(transaction);
		const updated = await transaction.affiliateReferral.update({
			where: { id: current.id },
			data: {
				status: 'CANCELLED',
				cancelledAt,
				aggregateVersion: { increment: 1n },
				sourceSequence: sequence
			}
		});
		await this.emitAffiliateState(transaction, updated);
	}

	private async emitAffiliateState(
		transaction: Prisma.TransactionClient,
		item: {
			id: string;
			referrerId: string;
			referredUserId: string;
			firstPaymentId: string | null;
			status: string;
			cashbackAmount: number | null;
			availableAt: Date | null;
			cancelledAt: Date | null;
			aggregateVersion: bigint;
			sourceSequence: bigint;
			updatedAt: Date;
		}
	): Promise<void> {
		const eventId = randomUUID();
		const eventType = BILLING_EVENT_TYPES.affiliateChanged;
		await transaction.outboxEvent.create({
			data: {
				eventId,
				eventType,
				aggregateType: 'billing.affiliate',
				aggregateId: item.id,
				aggregateVersion: item.aggregateVersion,
				sourceSequence: item.sourceSequence,
				correlationId: getBillingCorrelationId(),
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: eventType,
				payload: {
					schemaVersion: 1,
					eventType,
					eventId,
					aggregateId: item.id,
					aggregateVersion: item.aggregateVersion.toString(),
					sourceSequence: item.sourceSequence.toString(),
					occurredAt: item.updatedAt.toISOString(),
					tombstone: false,
					state: {
						id: item.id,
						referrerId: item.referrerId,
						referredUserId: item.referredUserId,
						firstPaymentId: item.firstPaymentId,
						status: item.status,
						cashbackAmount: item.cashbackAmount,
						availableAt: item.availableAt?.toISOString() ?? null,
						cancelledAt: item.cancelledAt?.toISOString() ?? null,
						updatedAt: item.updatedAt.toISOString()
					}
				} as Prisma.InputJsonValue
			}
		});
	}

	private normalizeAdminPaymentStatus(status?: string) {
		if (!status) return undefined;
		const normalized = status.trim().toUpperCase();
		if (
			!Object.values(PaymentStatus).includes(normalized as PaymentStatus)
		) {
			throw new BadRequestException('Некорректный статус платежа');
		}
		return normalized as PaymentStatus;
	}

	private normalizeAdminPaymentPlan(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (normalized === 'NONE') return null;
		if (!Object.values(Plan).includes(normalized as Plan)) {
			throw new BadRequestException('Некорректный тариф платежа');
		}
		return normalized as Plan;
	}

	private normalizeAdminPaymentBillingPeriod(value?: string) {
		const normalized = value?.trim().toUpperCase();
		if (!normalized) return undefined;
		if (normalized === 'NONE') return null;
		if (
			!Object.values(BillingPeriod).includes(normalized as BillingPeriod)
		) {
			throw new BadRequestException('Некорректный период платежа');
		}
		return normalized as BillingPeriod;
	}

	private getDateRangeFilter(from?: string, to?: string) {
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

	private adminCheckMessage(
		status: PaymentStatus,
		providerStatus: string
	) {
		if (status === PaymentStatus.SUCCEEDED) {
			return 'Платёж подтверждён, подписка синхронизирована.';
		}
		if (status === PaymentStatus.CANCELLED) return 'Платёж отменён.';
		if (status === PaymentStatus.EXPIRED && providerStatus === 'pending') {
			return 'Локальная ссылка истекла, ЮKassa ещё не вернула финальный статус.';
		}
		if (providerStatus === 'not_created') {
			return 'Провайдерный платёж ещё не создан.';
		}
		return 'Платёж ещё ожидает оплаты.';
	}

	private planLabel(plan: Plan): string {
		switch (plan) {
			case Plan.TRIAL:
				return 'Тест-драйв';
			case Plan.EASY:
				return 'Easy';
			case Plan.HARD:
				return 'Hard';
		}
	}

	private pause(milliseconds: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, milliseconds));
	}

	private async queueVerification(
		paymentId: string,
		providerPaymentId: string
	) {
		const idempotencyKey = `verify:${providerPaymentId}:${randomUUID()}`;
		const operation = await this.prisma.providerOperation.upsert({
			where: { idempotencyKey },
			create: {
				paymentId,
				providerPaymentId,
				idempotencyKey,
				kind: ProviderOperationKind.VERIFY_PAYMENT,
				payload: { paymentId, providerPaymentId }
			},
			update: {}
		});
		return operation.id;
	}

	private async requireActiveIdentity(userId: string) {
		const identity =
			await this.prisma.identityContactProjection.findUnique({
				where: { userId }
			});
		if (!identity || identity.status !== 'ACTIVE' || identity.deletedAt) {
			throw new BadRequestException(
				'Пользователь не найден или неактивен'
			);
		}
		return identity;
	}

	private settings() {
		return this.prisma.billingSettings.upsert({
			where: { id: 'singleton' },
			create: { id: 'singleton' },
			update: {}
		});
	}

	private async ensureTariff(plan: Plan, billingPeriod: BillingPeriod) {
		if (plan === Plan.TRIAL)
			throw new BadRequestException('Некорректный тариф');
		return this.prisma.tariffPrice.upsert({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			create: {
				plan,
				billingPeriod,
				amount: DEFAULT_PRICES[plan][billingPeriod]
			},
			update: {}
		});
	}

	private async findUserPayment(userId: string, paymentId?: string) {
		return this.prisma.payment.findFirst({
			where: {
				userId,
				...(paymentId ? { id: paymentId } : {})
			},
			orderBy: { createdAt: 'desc' }
		});
	}

	private createResponse(payment: any) {
		if (!payment.confirmationUrl) {
			throw new ServiceUnavailableException(
				'Ссылка на оплату ещё не получена'
			);
		}
		return {
			id: payment.id,
			confirmationUrl: payment.confirmationUrl,
			status: payment.status,
			kind: payment.kind,
			autoRenew: payment.autoRenew,
			expiresAt: payment.checkoutExpiresAt.toISOString(),
			providerExpiresAt: payment.providerExpiresAt?.toISOString() ?? null,
			serverTime: new Date().toISOString()
		};
	}

	private pendingResponse(payment: any) {
		return {
			id: payment.id,
			yookassaId: payment.yookassaId,
			amount: payment.amount,
			currency: payment.currency,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			status: payment.status,
			kind: payment.kind,
			autoRenew: payment.autoRenew,
			confirmationUrl: payment.confirmationUrl,
			createdAt: payment.createdAt.toISOString(),
			expiresAt: payment.checkoutExpiresAt.toISOString(),
			providerExpiresAt: payment.providerExpiresAt?.toISOString() ?? null,
			serverTime: new Date().toISOString()
		};
	}

	private verificationResponse(payment: any | null) {
		if (!payment) {
			return {
				activated: false,
				status: 'not_found',
				plan: null,
				billingPeriod: null,
				message: 'Платёж не найден'
			};
		}
		const status =
			payment.status === PaymentStatus.SUCCEEDED
				? 'succeeded'
				: payment.status === PaymentStatus.PENDING
					? 'pending'
					: 'cancelled';
		return {
			activated: status === 'succeeded',
			status,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			message:
				payment.status === PaymentStatus.EXPIRED
					? 'Срок ссылки истёк. Создайте новый платёж.'
					: status === 'succeeded'
						? 'Оплата подтверждена'
						: status === 'pending'
							? 'Ожидаем подтверждение оплаты'
							: 'Оплата отменена или не завершена'
		};
	}

	private historyItem(item: any) {
		const receipt =
			item.receipts.find((candidate: any) => candidate.publicUrl) ??
			item.receipts[0] ??
			null;
		return {
			id: item.id,
			yookassaId: item.yookassaId,
			status: item.status,
			kind: item.kind,
			amount: item.amount,
			currency: item.currency,
			plan: item.plan,
			billingPeriod: item.billingPeriod,
			autoRenew: item.autoRenew,
			createdAt: item.createdAt.toISOString(),
			succeededAt: item.succeededAt?.toISOString() ?? null,
			receiptSyncEligible: item.receiptSyncEligible,
			receipt: receipt
				? {
						status: receipt.status,
						registeredAt: receipt.registeredAt?.toISOString() ?? null,
						url: receipt.publicUrl,
						fiscalDocumentNumber: receipt.fiscalDocumentNumber
					}
				: null
		};
	}

	private serializeUserAutoRenewal(
		renewal: AutoRenewal | null,
		identity: IdentityContactProjection | null = null,
		subscription: Subscription | null = null
	) {
		if (!renewal) {
			return {
				status: 'NEVER_CONSENTED',
				active: false,
				plan: null,
				billingPeriod: null,
				amount: null,
				currency: 'RUB',
				nextChargeAt: null,
				retry: null,
				disabledAt: null,
				disableReason: null,
				canDisable: false,
				canEnableViaCheckout: true,
				serverTime: new Date().toISOString(),
				priceChange: this.serializeRenewalPriceChange(null, false)
			};
		}
		const userEligible = this.isUserEligible(identity, subscription);
		const chargeWindowEligible = this.isChargeWindowEligible(
			identity,
			subscription,
			renewal
		);
		const priceCanConfirm =
			Boolean(renewal.pendingAmount) &&
			(userEligible || chargeWindowEligible) &&
			renewal.status !== AutoRenewalStatus.USER_DISABLED &&
			renewal.status !== AutoRenewalStatus.REVOKED;
		return {
			status: renewal.status,
			active:
				renewal.status === AutoRenewalStatus.ACTIVE &&
				!renewal.pendingAmount &&
				(userEligible || chargeWindowEligible),
			plan: renewal.plan,
			billingPeriod: renewal.billingPeriod,
			amount: renewal.amount,
			currency: renewal.currency,
			nextChargeAt: renewal.nextChargeAt.toISOString(),
			retry: this.serializeRenewalRetry(renewal),
			disabledAt: renewal.disabledAt?.toISOString() ?? null,
			disableReason: this.publicRenewalDisableReason(renewal),
			canDisable:
				renewal.status !== AutoRenewalStatus.USER_DISABLED &&
				renewal.status !== AutoRenewalStatus.REVOKED,
			canEnableViaCheckout:
				renewal.status === AutoRenewalStatus.USER_DISABLED ||
				renewal.status === AutoRenewalStatus.TECHNICAL_PAUSE ||
				renewal.status === AutoRenewalStatus.REVOKED,
			serverTime: new Date().toISOString(),
			priceChange: this.serializeRenewalPriceChange(
				renewal,
				priceCanConfirm
			)
		};
	}

	private serializeAdminAutoRenewal(
		renewal: AutoRenewal | null,
		identity: IdentityContactProjection,
		subscription: Subscription | null,
		technical: boolean
	) {
		const userEligible = this.isUserEligible(identity, subscription);
		const chargeWindowEligible = renewal
			? this.isChargeWindowEligible(identity, subscription, renewal)
			: false;
		const hasPaymentMethod = Boolean(renewal?.paymentMethodCiphertext);
		const hasPriceChange = Boolean(renewal?.pendingAmount);
		const canResume =
			(userEligible || chargeWindowEligible) &&
			hasPaymentMethod &&
			!hasPriceChange;
		const canRetryTechnical =
			chargeWindowEligible && hasPaymentMethod && !hasPriceChange;
		const priceCanConfirm =
			hasPriceChange &&
			userEligible &&
			renewal?.status !== AutoRenewalStatus.USER_DISABLED &&
			renewal?.status !== AutoRenewalStatus.REVOKED;
		return {
			id: renewal?.id ?? null,
			user: {
				id: identity.userId,
				name: identity.name,
				email: identity.email
			},
			status: renewal?.status ?? 'NEVER_CONSENTED',
			active:
				renewal?.status === AutoRenewalStatus.ACTIVE &&
				!hasPriceChange &&
				(userEligible || chargeWindowEligible),
			plan: renewal?.plan ?? null,
			billingPeriod: renewal?.billingPeriod ?? null,
			amount: renewal?.amount ?? null,
			currency: renewal?.currency ?? null,
			nextChargeAt: renewal?.nextChargeAt.toISOString() ?? null,
			retry: renewal ? this.serializeRenewalRetry(renewal) : null,
			consentedAt: renewal?.consentedAt.toISOString() ?? null,
			consentVersion: renewal?.consentVersion ?? null,
			disabledAt: renewal?.disabledAt?.toISOString() ?? null,
			disableReason: renewal?.disableReason ?? null,
			lastChargeAttemptAt:
				renewal?.lastChargeAttemptAt?.toISOString() ?? null,
			lastChargeErrorCode: renewal?.lastChargeErrorCode ?? null,
			maskedMethod:
				renewal?.paymentMethodCiphertext && renewal.paymentMethodSavedAt
					? {
							type: renewal.paymentMethodType,
							title: renewal.paymentMethodTitle,
							last4: renewal.paymentMethodLast4,
							savedAt: renewal.paymentMethodSavedAt.toISOString()
						}
					: null,
			validity: {
				hasConsent: Boolean(renewal),
				hasPaymentMethod,
				userEligible
			},
			priceChange: this.serializeRenewalPriceChange(
				renewal,
				Boolean(priceCanConfirm)
			),
			capabilities: {
				canPause: renewal?.status === AutoRenewalStatus.ACTIVE,
				canResumeAdminPause:
					renewal?.status === AutoRenewalStatus.ADMIN_PAUSED && canResume,
				canRevoke:
					Boolean(renewal) &&
					renewal?.status !== AutoRenewalStatus.REVOKED,
				canReconcile: technical,
				canResumeTechnical:
					technical &&
					renewal?.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
					Boolean(
						renewal.lastChargeErrorCode?.startsWith(
							'AUTO_RENEWAL_DELIVERY:'
						)
					) &&
					canRetryTechnical
			},
			updatedAt: renewal?.updatedAt.toISOString() ?? null,
			serverTime: new Date().toISOString()
		};
	}

	private serializeRenewalRetry(renewal: AutoRenewal) {
		return {
			active:
				renewal.status === AutoRenewalStatus.ACTIVE &&
				Boolean(renewal.nextRetryAt),
			attempt: renewal.retryAttempt,
			maxAttempts: 2,
			startedAt: renewal.retryStartedAt?.toISOString() ?? null,
			nextRetryAt: renewal.nextRetryAt?.toISOString() ?? null,
			lastErrorCode: renewal.lastChargeErrorCode
		};
	}

	private serializeRenewalPriceChange(
		renewal: AutoRenewal | null,
		canConfirm: boolean
	) {
		return {
			required: Boolean(renewal?.pendingAmount),
			previousAmount: renewal?.pendingAmount ? renewal.amount : null,
			newAmount: renewal?.pendingAmount ?? null,
			currency: renewal?.pendingAmount ? renewal.currency : null,
			detectedAt: renewal?.priceChangeDetectedAt?.toISOString() ?? null,
			canConfirm
		};
	}

	private publicRenewalDisableReason(renewal: AutoRenewal): string | null {
		switch (renewal.status) {
			case AutoRenewalStatus.USER_DISABLED:
				return 'Автопродление отключено пользователем.';
			case AutoRenewalStatus.ADMIN_PAUSED:
				return 'Автопродление временно приостановлено службой поддержки.';
			case AutoRenewalStatus.REVOKED:
				return 'Согласие на автопродление отозвано.';
			case AutoRenewalStatus.TECHNICAL_PAUSE:
				switch (renewal.lastChargeErrorCode) {
					case 'insufficient_funds':
						return 'Повторные попытки списания из-за недостатка средств исчерпаны. Оформите оплату заново.';
					case 'issuer_unavailable':
						return 'Банк не подтвердил списание после повторных попыток. Оформите оплату заново.';
					case 'CHARGE_MISSED_DURING_GLOBAL_PAUSE':
						return 'Расчётная дата наступила во время общей остановки автосписаний. Оформите оплату заново.';
					case 'CHARGE_WINDOW_MISSED':
					case 'CHARGE_WINDOW_EXPIRED':
						return 'Безопасное окно списания истекло. Оформите оплату заново.';
					case 'PAYMENT_METHOD_MISSING':
					case 'PAYMENT_METHOD_DECRYPT_FAILED':
						return 'Сохранённый способ оплаты недоступен. Оформите оплату заново.';
					case 'RECEIPT_CONTACT_MISSING':
						return 'Для нового платежа требуется подтверждённый email или телефон.';
					case 'SUBSCRIPTION_STATE_MISMATCH':
						return 'Параметры текущей подписки изменились. Оформите оплату заново.';
					default:
						return 'Автопродление приостановлено по технической причине. Оформите оплату заново или обратитесь в поддержку.';
				}
			default:
				return null;
		}
	}

	private adminPaymentItem(payment: any, user: any) {
		return {
			id: payment.id,
			yookassaId: payment.yookassaId,
			status: payment.status,
			kind: payment.kind,
			amount: payment.amount,
			currency: payment.currency,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			autoRenew: payment.autoRenew,
			confirmationUrl: payment.confirmationUrl,
			createdAt: payment.createdAt,
			updatedAt: payment.updatedAt,
			succeededAt: payment.succeededAt,
			user: {
				id: payment.userId,
				name: user?.name ?? null,
				email: user?.email ?? null,
				phone: user?.phone ?? null
			}
		};
	}

	private async identityMap(userIds: string[]) {
		const rows = await this.prisma.identityContactProjection.findMany({
			where: { userId: { in: [...new Set(userIds)] } }
		});
		return new Map(rows.map(row => [row.userId, row]));
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

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}

	private formatAmount(amount: number): string {
		return `${amount}.00`;
	}

	private cuidLikeId(): string {
		return `bill_${randomUUID().replace(/-/g, '')}`;
	}
}
