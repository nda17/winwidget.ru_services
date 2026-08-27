import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	AutoRenewal,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	Prisma,
	ScheduledRunStatus,
	SubscriptionExpiryReminderStatus,
	SubscriptionStatus
} from '@prisma/billing-client';
import { randomUUID } from 'node:crypto';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { SubscriptionDomainService } from '../domain/subscription-domain.service';
import {
	AUTO_RENEWAL_DUE_GRACE_MS,
	AUTO_RENEWAL_RETRY_DELAYS_MS,
	AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS,
	buildRecurringCycleKey,
	PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
} from '../domain/billing-legal.constants';

const TICK_MS = 60_000;
const RUN_LEASE_MS = 5 * 60_000;
const RUN_LEASE_RENEW_MS = 60_000;
const CHARGE_DATE_DRIFT_MS = 60_000;
const MOSCOW_UTC_OFFSET_HOURS = 3;
const REMINDER_DAYS_BEFORE_EXPIRY = [6, 3, 0] as const;
const DEFAULT_PRICES: Record<
	'EASY' | 'HARD',
	Record<BillingPeriod, number>
> = {
	EASY: { MONTHLY: 990, YEARLY: 4680 },
	HARD: { MONTHLY: 1690, YEARLY: 9480 }
};

@Injectable()
export class BillingSchedulerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(BillingSchedulerService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;

	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly runtime: BillingRuntimeService,
		private readonly subscriptions: SubscriptionDomainService
	) {}

	onModuleInit(): void {
		if (!this.runtime.schedulerEnabled) return;
		this.ready = true;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref();
		void this.tick();
	}

	isReady(): boolean {
		return !this.runtime.schedulerEnabled || this.ready;
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.ready = false;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const now = new Date();
			await this.runDurable('billing-retention', this.dayKey(now), () =>
				this.runRetention(now)
			);
			await this.runDurable('auto-renewal', this.minuteKey(now), () =>
				this.scheduleRenewals(now)
			);
			await this.runDurable('subscription-expiry', this.hourKey(now), () =>
				this.subscriptions.runExpiryCheck().then(() => undefined)
			);
			await this.runDurable(
				'subscription-expiry-reminders',
				this.moscowReminderSlotKey(now),
				() => this.scheduleExpiryReminders(now)
			);
		} catch (error) {
			this.logger.error(
				`Billing scheduler tick failed: ${this.safeError(error)}`
			);
		} finally {
			this.running = false;
		}
	}

	private async runRetention(now: Date): Promise<void> {
		const outboxBefore = new Date(
			now.getTime() - this.runtime.outboxRetentionDays * 24 * 60 * 60_000
		);
		const receiptBefore = new Date(
			now.getTime() - this.runtime.receiptRetentionDays * 24 * 60 * 60_000
		);
		const failureBefore = new Date(
			now.getTime() -
				this.runtime.failureDetailRetentionDays * 24 * 60 * 60_000
		);
		await this.prisma.$transaction([
			this.prisma.outboxEvent.deleteMany({
				where: {
					status: 'PUBLISHED',
					publishedAt: { lt: outboxBefore }
				}
			}),
			this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					updatedAt: { lt: receiptBefore },
					lastError: { not: null }
				},
				data: { lastError: null }
			}),
			this.prisma.integrationDeliveryFailure.updateMany({
				where: { resolvedAt: { lt: failureBefore } },
				data: {
					payload: { redacted: true, reason: 'retention-expired' },
					lastError: 'Delivery detail expired by retention policy',
					errorCode: null,
					errorSafe: null,
					normalizedCode: null,
					safeReason: null,
					httpStatus: null,
					providerCode: null
				}
			})
		]);
	}

	private async runDurable(
		task: string,
		periodKey: string,
		handler: () => Promise<void>
	): Promise<void> {
		const token = randomUUID();
		const now = new Date();
		let run = await this.prisma.billingScheduledRun.findUnique({
			where: { task_periodKey: { task, periodKey } }
		});
		if (run?.status === ScheduledRunStatus.COMPLETED) return;
		if (
			run?.status === ScheduledRunStatus.PROCESSING &&
			run.leaseUntil > now
		)
			return;
		if (!run) {
			try {
				run = await this.prisma.billingScheduledRun.create({
					data: {
						task,
						periodKey,
						claimToken: token,
						leaseUntil: new Date(now.getTime() + RUN_LEASE_MS)
					}
				});
			} catch (error) {
				if ((error as { code?: string }).code === 'P2002') return;
				throw error;
			}
		} else {
			const claimed = await this.prisma.billingScheduledRun.updateMany({
				where: {
					id: run.id,
					status: { not: ScheduledRunStatus.COMPLETED },
					leaseUntil: { lte: now }
				},
				data: {
					status: ScheduledRunStatus.PROCESSING,
					claimToken: token,
					leaseUntil: new Date(now.getTime() + RUN_LEASE_MS),
					lastError: null
				}
			});
			if (claimed.count !== 1) return;
		}
		let renewalFailure: Error | null = null;
		let renewal = Promise.resolve();
		const renewalTimer = setInterval(() => {
			renewal = renewal
				.then(async () => {
					if (renewalFailure) return;
					const renewed = await this.prisma.billingScheduledRun.updateMany(
						{
							where: {
								id: run!.id,
								status: ScheduledRunStatus.PROCESSING,
								claimToken: token
							},
							data: {
								leaseUntil: new Date(Date.now() + RUN_LEASE_MS)
							}
						}
					);
					if (renewed.count !== 1) {
						throw new Error(
							`Billing scheduler lease was lost task=${task} period=${periodKey}`
						);
					}
				})
				.catch(error => {
					renewalFailure =
						error instanceof Error
							? error
							: new Error('Billing scheduler lease renewal failed');
				});
		}, RUN_LEASE_RENEW_MS);
		renewalTimer.unref();
		let handlerFailure: unknown;
		try {
			await handler();
		} catch (error) {
			handlerFailure = error;
		} finally {
			clearInterval(renewalTimer);
			await renewal;
		}
		try {
			if (handlerFailure) throw handlerFailure;
			if (renewalFailure) throw renewalFailure;
			const completed = await this.prisma.billingScheduledRun.updateMany({
				where: { id: run.id, claimToken: token },
				data: {
					status: ScheduledRunStatus.COMPLETED,
					completedAt: new Date()
				}
			});
			if (completed.count !== 1) {
				throw new Error(
					`Billing scheduler completion lease was lost task=${task} period=${periodKey}`
				);
			}
		} catch (error) {
			await this.prisma.billingScheduledRun.updateMany({
				where: { id: run.id, claimToken: token },
				data: {
					status: ScheduledRunStatus.FAILED,
					leaseUntil: new Date(),
					lastError: this.safeError(error)
				}
			});
			throw error;
		}
	}

	private async scheduleRenewals(now: Date): Promise<void> {
		const settings = await this.prisma.billingSettings.findUnique({
			where: { id: 'singleton' }
		});
		if (
			!settings?.paymentEnabled ||
			!settings?.autoRenewalChargesEnabled ||
			settings.autoRenewalChargesEnabledAt > now
		)
			return;
		const renewals = await this.prisma.autoRenewal.findMany({
			where: {
				status: AutoRenewalStatus.ACTIVE,
				pendingAmount: null,
				dispatchPending: false,
				OR: [
					{ nextRetryAt: { lte: now } },
					{ nextRetryAt: null, nextChargeAt: { lte: now } }
				]
			},
			orderBy: { nextChargeAt: 'asc' },
			take: 250
		});
		for (const renewal of renewals) {
			await this.createRecurringIntent(renewal.id);
		}
	}

	private async createRecurringIntent(
		renewalId: string
	): Promise<boolean> {
		return this.prisma.$transaction(
			async transaction => {
				await transaction.billingSettings.upsert({
					where: { id: 'singleton' },
					create: { id: 'singleton' },
					update: {}
				});
				await transaction.$queryRaw`
					SELECT id FROM billing.settings
					WHERE id = 'singleton'
					FOR UPDATE
				`;
				const settings =
					await transaction.billingSettings.findUniqueOrThrow({
						where: { id: 'singleton' }
					});
				if (
					!settings.paymentEnabled ||
					!settings.autoRenewalChargesEnabled
				) {
					return false;
				}
				const candidate = await transaction.autoRenewal.findUnique({
					where: { id: renewalId },
					select: { userId: true }
				});
				if (!candidate) return false;
				await transaction.$queryRaw`
					SELECT user_id FROM billing.identity_contact_projections
					WHERE user_id = ${candidate.userId}
					FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.auto_renewals WHERE id = ${renewalId} FOR UPDATE
				`;
				await transaction.$queryRaw`
					SELECT id FROM billing.subscriptions
					WHERE user_id = ${candidate.userId}
					FOR UPDATE
				`;
				const [renewal, identity, subscription] = await Promise.all([
					transaction.autoRenewal.findUnique({ where: { id: renewalId } }),
					transaction.identityContactProjection.findUnique({
						where: { userId: candidate.userId }
					}),
					transaction.subscription.findUnique({
						where: { userId: candidate.userId }
					})
				]);
				if (
					!renewal ||
					renewal.status !== AutoRenewalStatus.ACTIVE ||
					renewal.pendingAmount ||
					renewal.dispatchPending
				)
					return false;
				const now = new Date();
				const isRetry = Boolean(renewal.nextRetryAt);
				const attempt = isRetry ? renewal.retryAttempt : 0;
				const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
				if (
					dueAt > now ||
					(isRetry &&
						(attempt < 1 || attempt > AUTO_RENEWAL_RETRY_DELAYS_MS.length))
				)
					return false;
				if (dueAt < settings.autoRenewalChargesEnabledAt) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'CHARGE_MISSED_DURING_GLOBAL_PAUSE',
						'Расчётная дата наступила во время глобальной остановки автосписаний'
					);
					return false;
				}
				if (
					!identity ||
					identity.tombstone ||
					identity.deletedAt ||
					identity.status !== 'ACTIVE'
				) {
					await this.revokeInvalidRenewal(transaction, renewal);
					return false;
				}
				if (
					!subscription?.expiresAt ||
					(subscription.status !== SubscriptionStatus.ACTIVE &&
						subscription.status !== SubscriptionStatus.EXPIRED) ||
					subscription.plan !== renewal.plan ||
					subscription.billingPeriod !== renewal.billingPeriod
				) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'SUBSCRIPTION_STATE_MISMATCH',
						'Текущая подписка не соответствует условиям автопродления'
					);
					return false;
				}
				if (
					Math.abs(
						subscription.expiresAt.getTime() -
							renewal.nextChargeAt.getTime()
					) > CHARGE_DATE_DRIFT_MS
				) {
					await transaction.autoRenewal.update({
						where: { id: renewal.id },
						data: {
							nextChargeAt: subscription.expiresAt,
							...(isRetry
								? {
										retryStartedAt: null,
										retryAttempt: 0,
										nextRetryAt: null,
										dispatchPending: false,
										lastChargeErrorCode: null
									}
								: {}),
							stateVersion: { increment: 1 }
						}
					});
					if (isRetry) {
						await this.createRenewalEvent(
							transaction,
							renewal,
							AutoRenewalConsentEventType.RETRY_CANCELLED,
							'Повторные попытки отменены: подписка уже продлена другим платежом',
							{
								subscriptionExpiresAt: subscription.expiresAt.toISOString()
							}
						);
					}
					return false;
				}
				const dispatchGraceMs = isRetry
					? AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
					: AUTO_RENEWAL_DUE_GRACE_MS;
				if (now.getTime() - dueAt.getTime() > dispatchGraceMs) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'CHARGE_WINDOW_MISSED',
						'Безопасное окно планового списания пропущено'
					);
					return false;
				}
				const currentAmount = await this.currentAmount(
					transaction,
					renewal.plan,
					renewal.billingPeriod
				);
				if (currentAmount !== renewal.amount) {
					await this.requirePriceConfirmation(
						transaction,
						renewal,
						currentAmount
					);
					return false;
				}
				if (!renewal.paymentMethodCiphertext) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'PAYMENT_METHOD_MISSING',
						'Сохранённый способ оплаты отсутствует'
					);
					return false;
				}
				if (!identity.email && !identity.phone) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'RECEIPT_CONTACT_MISSING',
						'Для формирования чека отсутствует подтверждённый контакт'
					);
					return false;
				}
				const cycleKey = buildRecurringCycleKey(
					renewal.id,
					renewal.nextChargeAt,
					attempt
				);
				const existing = await transaction.payment.findUnique({
					where: { recurringCycleKey: cycleKey }
				});
				if (existing) {
					if (
						existing.status === PaymentStatus.CANCELLED &&
						existing.providerStatus === 'not_sent' &&
						!existing.yookassaId
					) {
						const sequence = await this.nextSequence(transaction);
						const resumed = await transaction.payment.update({
							where: { id: existing.id },
							data: {
								providerIdempotencyKey:
									existing.providerIdempotencyKey ?? randomUUID(),
								amount: renewal.amount,
								currency: renewal.currency,
								status: PaymentStatus.PENDING,
								providerStatus: 'queued',
								plan: renewal.plan,
								billingPeriod: renewal.billingPeriod,
								consentVersion: renewal.consentVersion,
								consentText: renewal.consentText,
								consentedAt: renewal.consentedAt,
								offerSnapshot: renewal.offerSnapshot,
								offerSha256: renewal.offerSha256,
								offerUpdatedAt: renewal.offerUpdatedAt,
								customerEmail: identity.email,
								customerPhone: identity.phone,
								paymentMethodCiphertext: renewal.paymentMethodCiphertext,
								checkoutExpiresAt: this.checkoutExpiresAt(
									now,
									dueAt,
									isRetry
								),
								cancelledAt: null,
								cancellationReason: null,
								aggregateVersion: { increment: 1n },
								sourceSequence: sequence
							}
						});
						await this.enqueueCharge(
							transaction,
							renewal,
							resumed,
							cycleKey,
							dueAt
						);
						return true;
					}
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'RECURRING_CYCLE_STATE_CONFLICT',
						'Текущий цикл автопродления требует ручной сверки'
					);
					return false;
				}
				const blocking = await transaction.payment.findFirst({
					where: this.blockingPaymentWhere(renewal.userId, now),
					select: { id: true }
				});
				if (blocking) {
					await this.pauseInvalidRenewal(
						transaction,
						renewal,
						'OTHER_PAYMENT_IN_PROGRESS',
						'Автопродление приостановлено из-за другого незавершённого платежа'
					);
					return false;
				}
				const sequence = await this.nextSequence(transaction);
				const payment = await transaction.payment.create({
					data: {
						userId: renewal.userId,
						providerIdempotencyKey: randomUUID(),
						recurringCycleKey: cycleKey,
						recurringAttempt: attempt,
						kind: PaymentKind.RECURRING,
						amount: renewal.amount,
						currency: renewal.currency,
						status: PaymentStatus.PENDING,
						providerStatus: 'queued',
						plan: renewal.plan,
						billingPeriod: renewal.billingPeriod,
						autoRenew: true,
						consentVersion: renewal.consentVersion,
						consentText: renewal.consentText,
						consentedAt: renewal.consentedAt,
						offerSnapshot: renewal.offerSnapshot,
						offerSha256: renewal.offerSha256,
						offerUpdatedAt: renewal.offerUpdatedAt,
						customerEmail: identity.email,
						customerPhone: identity.phone,
						paymentMethodCiphertext: renewal.paymentMethodCiphertext,
						checkoutExpiresAt: this.checkoutExpiresAt(now, dueAt, isRetry),
						aggregateVersion: 1n,
						sourceSequence: sequence
					}
				});
				await this.enqueueCharge(
					transaction,
					renewal,
					payment,
					cycleKey,
					dueAt
				);
				return true;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 5_000,
				timeout: 30_000
			}
		);
	}

	private async enqueueCharge(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		payment: {
			id: string;
			userId: string;
			yookassaId: string | null;
			amount: string;
			status: PaymentStatus;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			recurringCycleKey: string | null;
			aggregateVersion: bigint;
			sourceSequence: bigint;
			createdAt: Date;
			updatedAt: Date;
		},
		cycleKey: string,
		dueAt: Date
	): Promise<void> {
		const chargeEventId = randomUUID();
		await transaction.outboxEvent.createMany({
			data: [
				this.paymentOutbox(payment, BILLING_EVENT_TYPES.paymentChanged, {
					id: payment.id,
					userId: payment.userId,
					amount: payment.amount,
					status: payment.status,
					createdAt: payment.createdAt.toISOString(),
					updatedAt: payment.updatedAt.toISOString()
				}),
				{
					eventId: chargeEventId,
					eventType: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
					aggregateType: 'payment.auto-renewal',
					aggregateId: payment.id,
					exchange: BILLING_EVENTS_EXCHANGE,
					routingKey: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
					payload: {
						schemaVersion: 1,
						eventType: BILLING_EVENT_TYPES.autoRenewalChargeRequested,
						paymentId: payment.id,
						autoRenewalId: renewal.id,
						cycleKey,
						scheduledFor: dueAt.toISOString()
					} as Prisma.InputJsonValue
				}
			]
		});
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				dispatchPending: true,
				lastChargeAttemptAt: new Date(),
				stateVersion: { increment: 1 }
			}
		});
	}

	private checkoutExpiresAt(
		now: Date,
		dueAt: Date,
		isRetry: boolean
	): Date {
		const providerDeadline =
			now.getTime() + PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS;
		const cycleDeadline = dueAt.getTime() + AUTO_RENEWAL_DUE_GRACE_MS;
		return new Date(
			isRetry
				? dueAt.getTime() + AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
				: Math.min(providerDeadline, cycleDeadline)
		);
	}

	private blockingPaymentWhere(
		userId: string,
		now: Date
	): Prisma.PaymentWhereInput {
		return {
			userId,
			OR: [
				{ kind: PaymentKind.RECURRING, status: PaymentStatus.PENDING },
				{
					kind: PaymentKind.ONE_TIME,
					status: PaymentStatus.PENDING,
					checkoutExpiresAt: { gt: now }
				},
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.EXPIRED,
					OR: [{ providerStatus: 'pending' }, { yookassaId: null }]
				},
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.CANCELLED,
					providerStatus: 'pending'
				}
			]
		};
	}

	private async currentAmount(
		transaction: Prisma.TransactionClient,
		plan: AutoRenewal['plan'],
		billingPeriod: AutoRenewal['billingPeriod']
	): Promise<string> {
		const price = await transaction.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		const fallback =
			plan === Plan.EASY || plan === Plan.HARD
				? DEFAULT_PRICES[plan][billingPeriod]
				: null;
		if (price?.amount === undefined && fallback === null) {
			throw new Error('Paid auto-renewal plan has no price');
		}
		return `${price?.amount ?? fallback}.00`;
	}

	private async requirePriceConfirmation(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		newAmount: string
	): Promise<void> {
		if (renewal.pendingAmount === newAmount) return;
		const detectedAt = new Date();
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				pendingAmount: newAmount,
				priceChangeDetectedAt: detectedAt,
				stateVersion: { increment: 1 }
			}
		});
		await this.createRenewalEvent(
			transaction,
			renewal,
			AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
			'Актуальная стоимость требует явного подтверждения пользователя',
			{
				previousAmount: renewal.amount,
				newAmount,
				detectedAt: detectedAt.toISOString()
			}
		);
	}

	private async pauseInvalidRenewal(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		errorCode: string,
		reason: string
	): Promise<void> {
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				status: AutoRenewalStatus.TECHNICAL_PAUSE,
				nextRetryAt: null,
				dispatchPending: false,
				disabledAt: new Date(),
				disableReason: reason,
				lastChargeErrorCode: errorCode,
				stateVersion: { increment: 1 }
			}
		});
		await this.createRenewalEvent(
			transaction,
			renewal,
			AutoRenewalConsentEventType.TECHNICAL_PAUSED,
			reason,
			{ errorCode }
		);
	}

	private async revokeInvalidRenewal(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal
	): Promise<void> {
		const reason =
			'Автопродление отозвано: пользователь неактивен или удалён';
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
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
				disabledAt: new Date(),
				disableReason: reason,
				stateVersion: { increment: 1 }
			}
		});
		await this.createRenewalEvent(
			transaction,
			renewal,
			AutoRenewalConsentEventType.ADMIN_REVOKED,
			reason
		);
	}

	private async createRenewalEvent(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		type: AutoRenewalConsentEventType,
		reason: string,
		metadata: Prisma.InputJsonObject = {}
	): Promise<void> {
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type,
				source: 'AUTO_RENEWAL_SCHEDULER',
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
				metadata
			}
		});
	}

	private async scheduleExpiryReminders(now: Date): Promise<void> {
		for (const daysBeforeExpiry of REMINDER_DAYS_BEFORE_EXPIRY) {
			const { start, end } = this.moscowDayRange(now, daysBeforeExpiry);
			const subscriptions = await this.prisma.subscription.findMany({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: { gte: start, lt: end }
				},
				orderBy: { expiresAt: 'asc' },
				take: 1000
			});
			for (const subscription of subscriptions) {
				if (!subscription.expiresAt) continue;
				const identity =
					await this.prisma.identityContactProjection.findUnique({
						where: { userId: subscription.userId }
					});
				if (
					!identity ||
					identity.tombstone ||
					identity.status !== 'ACTIVE' ||
					identity.deletedAt
				)
					continue;
				const email = identity.email?.trim().toLowerCase() || null;
				const telegramChatId =
					identity.telegramChannelActive && identity.telegramChatId?.trim()
						? identity.telegramChatId.trim()
						: null;
				const destinations: Array<{
					sentTo: string;
					eventType: string;
					destination: Record<string, string>;
				}> = [];
				if (email) {
					destinations.push({
						sentTo: email,
						eventType:
							BILLING_EVENT_TYPES.subscriptionExpiryEmailRequested,
						destination: { email }
					});
				}
				if (telegramChatId) {
					destinations.push({
						sentTo: `telegram:${telegramChatId}`,
						eventType:
							BILLING_EVENT_TYPES.subscriptionExpiryTelegramRequested,
						destination: { telegramChatId }
					});
				}
				for (const destination of destinations) {
					await this.prisma.$transaction(async transaction => {
						const prior =
							await transaction.subscriptionExpiryReminder.findUnique({
								where: {
									subscriptionId_daysBeforeExpiry_expiresAt_sentTo: {
										subscriptionId: subscription.id,
										daysBeforeExpiry,
										expiresAt: subscription.expiresAt!,
										sentTo: destination.sentTo
									}
								}
							});
						if (prior) return;
						const reminder =
							await transaction.subscriptionExpiryReminder.create({
								data: {
									subscriptionId: subscription.id,
									userId: subscription.userId,
									daysBeforeExpiry,
									expiresAt: subscription.expiresAt!,
									sentTo: destination.sentTo,
									status: SubscriptionExpiryReminderStatus.PROCESSING,
									lockedAt: now,
									lockedBy: 'billing-scheduler',
									attempts: 1
								}
							});
						const eventId = randomUUID();
						await transaction.outboxEvent.create({
							data: {
								eventId,
								eventType: destination.eventType,
								aggregateType: 'subscription-expiry-reminder',
								aggregateId: reminder.id,
								exchange: BILLING_EVENTS_EXCHANGE,
								routingKey: destination.eventType,
								payload: {
									schemaVersion: 1,
									eventType: destination.eventType,
									reference: {
										type: 'subscription-expiry-reminder',
										id: reminder.id
									},
									destination: destination.destination,
									content: {
										daysBeforeExpiry,
										planLabel: this.planLabel(subscription.plan),
										expiresAtLabel: this.formatMoscowDateTime(
											subscription.expiresAt!
										)
									}
								} as Prisma.InputJsonValue
							}
						});
					});
				}
			}
		}
	}

	private paymentOutbox(
		payment: any,
		eventType: string,
		state: Record<string, unknown>
	) {
		const eventId = randomUUID();
		return {
			eventId,
			eventType,
			aggregateType: eventType.replace('.changed.v1', ''),
			aggregateId: payment.id,
			aggregateVersion: payment.aggregateVersion,
			sourceSequence: payment.sourceSequence,
			exchange: BILLING_EVENTS_EXCHANGE,
			routingKey: eventType,
			payload: {
				schemaVersion: 1,
				eventType,
				eventId,
				aggregateId: payment.id,
				aggregateVersion: payment.aggregateVersion.toString(),
				sourceSequence: payment.sourceSequence.toString(),
				occurredAt: payment.updatedAt.toISOString(),
				tombstone: false,
				state
			} as Prisma.InputJsonValue
		};
	}

	private minuteKey(date: Date) {
		return date.toISOString().slice(0, 16);
	}
	private hourKey(date: Date) {
		return date.toISOString().slice(0, 13);
	}
	private dayKey(date: Date) {
		return date.toISOString().slice(0, 10);
	}

	private moscowDayRange(now: Date, daysFromToday: number) {
		const offsetMs = MOSCOW_UTC_OFFSET_HOURS * 60 * 60_000;
		const startMoscow = new Date(now.getTime() + offsetMs);
		startMoscow.setUTCHours(0, 0, 0, 0);
		startMoscow.setUTCDate(startMoscow.getUTCDate() + daysFromToday);
		const endMoscow = new Date(startMoscow);
		endMoscow.setUTCDate(endMoscow.getUTCDate() + 1);
		return {
			start: new Date(startMoscow.getTime() - offsetMs),
			end: new Date(endMoscow.getTime() - offsetMs)
		};
	}

	private moscowReminderSlotKey(now: Date): string {
		const offsetMs = MOSCOW_UTC_OFFSET_HOURS * 60 * 60_000;
		const moscow = new Date(now.getTime() + offsetMs);
		let slotHour = 15;
		if (moscow.getUTCHours() >= 15) {
			slotHour = 15;
		} else if (moscow.getUTCHours() >= 3) {
			slotHour = 3;
		} else {
			moscow.setUTCDate(moscow.getUTCDate() - 1);
		}
		return `${moscow.toISOString().slice(0, 10)}T${String(slotHour).padStart(2, '0')}:00+03:00`;
	}

	private planLabel(plan: Plan): string {
		if (plan === Plan.TRIAL) return 'Тест-драйв';
		if (plan === Plan.EASY) return 'Easy';
		if (plan === Plan.HARD) return 'Hard';
		return plan;
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

	private async nextSequence(transaction: Prisma.TransactionClient) {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}

	private safeError(error: unknown) {
		return error instanceof Error
			? error.message.slice(0, 2_000)
			: 'Unknown scheduler failure';
	}
}
