import { enqueueAutoRenewalChargeRequestedEvent } from '@/messaging/auto-renewal-charge-event';
import {
	AUTO_RENEWAL_DUE_GRACE_MS,
	AUTO_RENEWAL_RETRY_DELAYS_MS,
	AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS,
	AUTO_RENEWAL_SCHEDULER_INTERVAL_MS,
	buildRecurringCycleKey,
	PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
} from '@/payment/payment.constants';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_PRICES } from '@/subscription/subscription.constants';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import {
	AutoRenewal,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	AuthIdentityType,
	PaymentKind,
	PaymentStatus,
	Prisma,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

const DEFAULT_BATCH_SIZE = 50;
const CHARGE_DATE_DRIFT_MS = 60 * 1000;
const TRANSACTION_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 5000,
	timeout: 15000
} as const;

@Injectable()
export class AutoRenewalSchedulerService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(AutoRenewalSchedulerService.name);
	private timer: NodeJS.Timeout | null = null;
	private destroyed = false;
	private running = false;

	constructor(
		private readonly prisma: PrismaService,
		private readonly paymentService: PaymentService
	) {}

	onModuleInit(): void {
		this.schedule(0);
	}

	onModuleDestroy(): void {
		this.destroyed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	async dispatchDueRenewals(): Promise<number> {
		const settings = await this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		if (!settings.paymentEnabled || !settings.autoRenewalChargesEnabled) {
			return 0;
		}
		const now = new Date();
		const due = await this.prisma.autoRenewal.findMany({
			where: {
				status: AutoRenewalStatus.ACTIVE,
				pendingAmount: null,
				dispatchPending: false,
				OR: [
					{ nextRetryAt: { lte: now } },
					{
						nextRetryAt: null,
						nextChargeAt: { lte: now }
					}
				]
			},
			select: { id: true },
			orderBy: { nextChargeAt: 'asc' },
			take: this.getBatchSize()
		});

		let dispatched = 0;
		for (const item of due) {
			try {
				if (await this.dispatchOne(item.id)) dispatched += 1;
			} catch (error) {
				this.logger.error(
					`Auto-renewal dispatch failed: autoRenewalId=${item.id} error=${
						error instanceof Error ? error.stack : String(error)
					}`
				);
			}
		}
		return dispatched;
	}

	private async dispatchOne(autoRenewalId: string): Promise<boolean> {
		return this.prisma.$transaction(async transaction => {
			await transaction.siteSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "site_settings"
					WHERE "id" = 'singleton'
					FOR UPDATE
				`
			);
			const settings = await transaction.siteSettings.findUniqueOrThrow({
				where: { id: 'singleton' }
			});
			if (
				!settings.paymentEnabled ||
				!settings.autoRenewalChargesEnabled
			) {
				return false;
			}
			const candidate = await transaction.autoRenewal.findUnique({
				where: { id: autoRenewalId },
				select: { userId: true }
			});
			if (!candidate) return false;
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "User"
					WHERE "id" = ${candidate.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "auto_renewals"
					WHERE "id" = ${autoRenewalId}
					FOR UPDATE
				`
			);
			const renewal = await transaction.autoRenewal.findUnique({
				where: { id: autoRenewalId },
				include: {
					user: {
						select: {
							status: true,
							deletedAt: true,
							authIdentities: {
								where: {
									type: {
										in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
									}
								},
								select: { type: true, value: true }
							},
							subscription: true
						}
					}
				}
			});
			if (
				!renewal ||
				renewal.status !== AutoRenewalStatus.ACTIVE ||
				renewal.pendingAmount ||
				renewal.dispatchPending
			) {
				return false;
			}
			const isRetry = Boolean(renewal.nextRetryAt);
			const attempt = isRetry ? renewal.retryAttempt : 0;
			const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
			if (
				dueAt > new Date() ||
				(isRetry &&
					(attempt < 1 || attempt > AUTO_RENEWAL_RETRY_DELAYS_MS.length))
			) {
				return false;
			}
			if (
				this.isMissedDuringGlobalPause(
					dueAt,
					settings.autoRenewalChargesEnabledAt
				)
			) {
				await this.pauseInvalidRenewal(
					transaction,
					renewal,
					'CHARGE_MISSED_DURING_GLOBAL_PAUSE',
					'Расчётная дата наступила во время глобальной остановки автосписаний'
				);
				return false;
			}

			if (
				renewal.user.deletedAt ||
				renewal.user.status !== UserStatus.ACTIVE
			) {
				await this.revokeInvalidRenewal(transaction, renewal);
				return false;
			}

			const subscription = renewal.user.subscription;
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

			const subscriptionCycleChanged =
				Math.abs(
					subscription.expiresAt.getTime() - renewal.nextChargeAt.getTime()
				) > CHARGE_DATE_DRIFT_MS;
			if (subscriptionCycleChanged) {
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
					await transaction.autoRenewalConsentEvent.create({
						data: {
							autoRenewalId: renewal.id,
							userId: renewal.userId,
							type: AutoRenewalConsentEventType.RETRY_CANCELLED,
							source: 'AUTO_RENEWAL_SCHEDULER',
							reason:
								'Повторные попытки отменены: подписка уже продлена другим платежом',
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
								subscriptionExpiresAt: subscription.expiresAt.toISOString()
							}
						}
					});
				}
				return false;
			}

			const now = new Date();
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

			const currentAmount = await this.getCurrentAmount(
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

			const cycleKey = buildRecurringCycleKey(
				renewal.id,
				renewal.nextChargeAt,
				attempt
			);
			const customerEmail = renewal.user.authIdentities.find(
				identity => identity.type === AuthIdentityType.EMAIL
			)?.value;
			const customerPhone = renewal.user.authIdentities.find(
				identity => identity.type === AuthIdentityType.PHONE
			)?.value;
			if (!customerEmail && !customerPhone) {
				await this.pauseInvalidRenewal(
					transaction,
					renewal,
					'RECEIPT_CONTACT_MISSING',
					'Для формирования чека отсутствует подтверждённый контакт'
				);
				return false;
			}

			const existing = await transaction.payment.findUnique({
				where: { recurringCycleKey: cycleKey }
			});
			if (existing) {
				if (
					existing.status === PaymentStatus.CANCELLED &&
					existing.providerStatus === 'not_sent' &&
					!existing.yookassaId
				) {
					const resumedPayment = await transaction.payment.update({
						where: { id: existing.id },
						data: {
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
							customerEmail: customerEmail ?? null,
							customerPhone: customerPhone ?? null,
							paymentMethodCiphertext: renewal.paymentMethodCiphertext,
							checkoutExpiresAt: this.getCheckoutExpiresAt(
								now,
								dueAt,
								isRetry
							),
							cancelledAt: null,
							cancellationReason: null
						}
					});
					await this.enqueueCharge(
						transaction,
						renewal,
						resumedPayment.id,
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
				where: this.getBlockingPaymentWhere(renewal.userId, now),
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
					customerEmail: customerEmail ?? null,
					customerPhone: customerPhone ?? null,
					paymentMethodCiphertext: renewal.paymentMethodCiphertext,
					checkoutExpiresAt: this.getCheckoutExpiresAt(now, dueAt, isRetry)
				}
			});
			await this.enqueueCharge(
				transaction,
				renewal,
				payment.id,
				cycleKey,
				dueAt
			);
			return true;
		}, TRANSACTION_OPTIONS);
	}

	private getCheckoutExpiresAt(
		now: Date,
		dueAt: Date,
		isRetry: boolean
	): Date {
		const providerWindowDeadline =
			now.getTime() + PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS;
		const cycleDeadline = dueAt.getTime() + AUTO_RENEWAL_DUE_GRACE_MS;
		return new Date(
			isRetry
				? dueAt.getTime() + AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
				: Math.min(providerWindowDeadline, cycleDeadline)
		);
	}

	private getBlockingPaymentWhere(
		userId: string,
		now: Date
	): Prisma.PaymentWhereInput {
		return {
			userId,
			OR: [
				{
					kind: PaymentKind.RECURRING,
					status: PaymentStatus.PENDING
				},
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

	private isMissedDuringGlobalPause(
		dueAt: Date,
		chargesEnabledAt: Date
	): boolean {
		return dueAt.getTime() < chargesEnabledAt.getTime();
	}

	private async enqueueCharge(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		paymentId: string,
		cycleKey: string,
		dueAt: Date
	): Promise<void> {
		await enqueueAutoRenewalChargeRequestedEvent(transaction, {
			schemaVersion: 1,
			eventType: 'payment.auto-renewal.charge.requested.v1',
			paymentId,
			autoRenewalId: renewal.id,
			cycleKey,
			scheduledFor: dueAt.toISOString()
		});
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				dispatchPending: true,
				stateVersion: { increment: 1 }
			}
		});
	}

	private async run(): Promise<void> {
		if (this.destroyed || this.running) return;
		this.running = true;
		try {
			const dispatched = await this.dispatchDueRenewals();
			const reconciled =
				await this.paymentService.reconcilePendingPayments();
			if (dispatched || reconciled) {
				this.logger.log(
					`Auto-renewal maintenance complete: dispatched=${dispatched} reconciled=${reconciled}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Auto-renewal maintenance failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
			this.schedule(AUTO_RENEWAL_SCHEDULER_INTERVAL_MS);
		}
	}

	private schedule(delayMs: number): void {
		if (this.destroyed) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.run();
		}, delayMs);
		this.timer.unref?.();
	}

	private async getCurrentAmount(
		transaction: Prisma.TransactionClient,
		plan: AutoRenewal['plan'],
		billingPeriod: AutoRenewal['billingPeriod']
	): Promise<string> {
		const price = await transaction.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		return `${price?.amount ?? PLAN_PRICES[plan][billingPeriod]}.00`;
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
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
				source: 'AUTO_RENEWAL_SCHEDULER',
				reason:
					'Актуальная стоимость требует явного подтверждения пользователя',
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
					previousAmount: renewal.amount,
					newAmount,
					detectedAt: detectedAt.toISOString()
				}
			}
		});
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
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
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
				metadata: { errorCode }
			}
		});
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
				disabledAt: new Date(),
				disableReason: reason,
				stateVersion: { increment: 1 }
			}
		});
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.ADMIN_REVOKED,
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
				currency: renewal.currency
			}
		});
	}

	private getBatchSize(): number {
		const value = Number(process.env.AUTO_RENEWAL_SCHEDULER_BATCH_SIZE);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 500)
			: DEFAULT_BATCH_SIZE;
	}
}
