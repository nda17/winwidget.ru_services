import {
	AffiliateReferralStatus,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	BillingPeriod,
	PaymentKind,
	PaymentStatus,
	Plan,
	Prisma,
	SubscriptionStatus
} from '@prisma/billing-client';
import {
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getBillingCorrelationId } from '../common/billing-request-context';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import {
	BILLING_EVENT_TYPES,
	BILLING_EVENTS_EXCHANGE
} from '../messaging/billing-messaging.constants';

export interface VerifiedPaymentSuccess {
	paymentId: string;
	providerPaymentId: string;
	providerAmount: string;
	providerCurrency: string;
	succeededAt: Date;
	paymentMethodCiphertext?: string | null;
	paymentMethodType?: string | null;
	paymentMethodTitle?: string | null;
	paymentMethodLast4?: string | null;
	providerSnapshot?: Record<string, unknown>;
}

@Injectable()
export class PaymentSuccessTransaction {
	constructor(private readonly prisma: BillingPrismaService) {}

	async apply(
		input: VerifiedPaymentSuccess
	): Promise<Record<string, unknown>> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await this.prisma.$transaction(
					transaction => this.applyInTransaction(transaction, input),
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 5_000,
						timeout: 30_000
					}
				);
			} catch (error) {
				if (attempt === 3 || !this.isSerializationConflict(error))
					throw error;
			}
		}
		throw new Error('Unreachable payment transaction state');
	}

	private async applyInTransaction(
		transaction: Prisma.TransactionClient,
		input: VerifiedPaymentSuccess
	): Promise<Record<string, unknown>> {
		const candidate = await transaction.payment.findUnique({
			where: { id: input.paymentId },
			select: { userId: true }
		});
		if (!candidate) throw new NotFoundException('Платёж не найден');
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
			SELECT id FROM billing.payments
			WHERE id = ${input.paymentId}
			FOR UPDATE
		`;
		const payment = await transaction.payment.findUnique({
			where: { id: input.paymentId }
		});
		if (!payment) throw new NotFoundException('Платёж не найден');
		if (
			payment.yookassaId &&
			payment.yookassaId !== input.providerPaymentId
		) {
			throw new ConflictException(
				'Provider payment ID conflicts with local payment'
			);
		}
		const duplicateProvider = await transaction.payment.findFirst({
			where: {
				yookassaId: input.providerPaymentId,
				id: { not: payment.id }
			},
			select: { id: true }
		});
		if (duplicateProvider) {
			throw new ConflictException('Provider payment ID is already bound');
		}
		if (
			payment.amount !== input.providerAmount ||
			payment.currency !== input.providerCurrency
		) {
			throw new ConflictException(
				'Provider amount or currency does not match'
			);
		}
		if (payment.status === PaymentStatus.SUCCEEDED) {
			return {
				paymentId: payment.id,
				status: payment.status,
				duplicate: true
			};
		}
		if (!payment.plan || !payment.billingPeriod) {
			throw new ConflictException('Payment tariff snapshot is incomplete');
		}
		const wasLocallyClosed =
			payment.kind === PaymentKind.ONE_TIME &&
			(payment.status === PaymentStatus.CANCELLED ||
				payment.status === PaymentStatus.EXPIRED);
		const transactionNow = new Date();

		const identity =
			await transaction.identityContactProjection.findUnique({
				where: { userId: payment.userId }
			});
		if (!identity) {
			throw new ConflictException(
				'Billing identity projection is missing'
			);
		}
		const paymentSequence = await this.nextSourceSequence(transaction);
		const paymentVersion = payment.aggregateVersion + 1n;
		const updatedPayment = await transaction.payment.update({
			where: { id: payment.id },
			data: {
				yookassaId: input.providerPaymentId,
				status: PaymentStatus.SUCCEEDED,
				providerStatus: 'succeeded',
				confirmationUrl: null,
				succeededAt: input.succeededAt,
				cancelledAt: null,
				cancellationReason: null,
				lastProviderCheckedAt: transactionNow,
				paymentMethodCiphertext: null,
				providerSnapshot: (input.providerSnapshot ||
					payment.providerSnapshot) as Prisma.InputJsonValue,
				aggregateVersion: paymentVersion,
				sourceSequence: paymentSequence
			}
		});

		await transaction.$queryRaw`
			SELECT id FROM billing.subscriptions
			WHERE user_id = ${payment.userId}
			FOR UPDATE
		`;
		const currentSubscription = await transaction.subscription.findUnique({
			where: { userId: payment.userId }
		});
		const activeSubscription = Boolean(
			currentSubscription?.status === SubscriptionStatus.ACTIVE &&
			currentSubscription.expiresAt &&
			currentSubscription.expiresAt.getTime() > transactionNow.getTime()
		);
		let base = transactionNow;
		if (activeSubscription && currentSubscription?.expiresAt) {
			if (currentSubscription.plan === payment.plan) {
				base = currentSubscription.expiresAt;
			} else {
				const remainingFullDays = Math.floor(
					(currentSubscription.expiresAt.getTime() -
						transactionNow.getTime()) /
						(24 * 60 * 60 * 1000)
				);
				base = new Date(
					transactionNow.getTime() +
						remainingFullDays * 24 * 60 * 60 * 1000
				);
			}
		}
		const subscriptionSequence =
			await this.nextSourceSequence(transaction);
		const subscriptionVersion =
			(currentSubscription?.aggregateVersion || 0n) + 1n;
		const expiresAt = this.addBillingPeriod(base, payment.billingPeriod);
		const periodResetsAt = this.addCalendarMonthsClamped(
			transactionNow,
			1
		);
		const subscription = await transaction.subscription.upsert({
			where: { userId: payment.userId },
			create: {
				userId: payment.userId,
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt: transactionNow,
				expiresAt,
				periodResetsAt,
				aggregateVersion: subscriptionVersion,
				sourceSequence: subscriptionSequence
			},
			update: {
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				status: SubscriptionStatus.ACTIVE,
				startsAt:
					activeSubscription && currentSubscription
						? currentSubscription.startsAt
						: transactionNow,
				expiresAt,
				periodResetsAt,
				leadsThisPeriod: 0,
				aggregateVersion: subscriptionVersion,
				sourceSequence: subscriptionSequence
			}
		});

		const currentRenewal = await transaction.autoRenewal.findUnique({
			where: { userId: payment.userId }
		});
		if (payment.kind === PaymentKind.RECURRING && currentRenewal) {
			const recoverWorkerPause =
				currentRenewal.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
				currentRenewal.lastChargeErrorCode?.startsWith(
					'AUTO_RENEWAL_DELIVERY:'
				);
			await transaction.autoRenewal.update({
				where: { id: currentRenewal.id },
				data: {
					nextChargeAt: expiresAt,
					retryStartedAt: null,
					retryAttempt: 0,
					nextRetryAt: null,
					dispatchPending: false,
					lastChargeErrorCode: null,
					...(recoverWorkerPause
						? {
								status: AutoRenewalStatus.ACTIVE,
								disabledAt: null,
								disableReason: null
							}
						: {}),
					stateVersion: { increment: 1 }
				}
			});
			if (recoverWorkerPause) {
				await transaction.autoRenewalConsentEvent.create({
					data: {
						autoRenewalId: currentRenewal.id,
						userId: currentRenewal.userId,
						type: AutoRenewalConsentEventType.TECHNICAL_RESUMED,
						source: 'AUTO_RENEWAL_WORKER',
						reason:
							'Автопродление восстановлено после успешного завершения списания',
						consentVersion: currentRenewal.consentVersion,
						consentText: currentRenewal.consentText,
						offerSnapshot: currentRenewal.offerSnapshot,
						offerSha256: currentRenewal.offerSha256,
						offerUpdatedAt: currentRenewal.offerUpdatedAt,
						plan: currentRenewal.plan,
						billingPeriod: currentRenewal.billingPeriod,
						amount: currentRenewal.amount,
						currency: currentRenewal.currency,
						metadata: { paymentId: payment.id }
					}
				});
			}
		} else if (
			payment.kind === PaymentKind.ONE_TIME &&
			payment.autoRenew &&
			!wasLocallyClosed &&
			input.paymentMethodCiphertext &&
			payment.consentedAt &&
			payment.consentVersion &&
			payment.consentText &&
			payment.offerSnapshot &&
			payment.offerSha256 &&
			payment.offerUpdatedAt &&
			!(
				currentRenewal &&
				currentRenewal.status !== AutoRenewalStatus.ACTIVE &&
				currentRenewal.disabledAt &&
				currentRenewal.disabledAt >= payment.consentedAt
			)
		) {
			const renewal = await transaction.autoRenewal.upsert({
				where: { userId: payment.userId },
				create: {
					userId: payment.userId,
					status: AutoRenewalStatus.ACTIVE,
					plan: payment.plan,
					billingPeriod: payment.billingPeriod,
					amount: payment.amount,
					currency: payment.currency,
					nextChargeAt: expiresAt,
					consentedAt: payment.consentedAt,
					consentVersion: payment.consentVersion,
					consentText: payment.consentText,
					offerSnapshot: payment.offerSnapshot,
					offerSha256: payment.offerSha256,
					offerUpdatedAt: payment.offerUpdatedAt,
					paymentMethodCiphertext: input.paymentMethodCiphertext,
					paymentMethodType:
						input.paymentMethodType || currentRenewal?.paymentMethodType,
					paymentMethodTitle:
						input.paymentMethodTitle || currentRenewal?.paymentMethodTitle,
					paymentMethodLast4:
						input.paymentMethodLast4 || currentRenewal?.paymentMethodLast4,
					paymentMethodSavedAt: transactionNow
				},
				update: {
					status: AutoRenewalStatus.ACTIVE,
					plan: payment.plan,
					billingPeriod: payment.billingPeriod,
					amount: payment.amount,
					pendingAmount: null,
					priceChangeDetectedAt: null,
					currency: payment.currency,
					consentedAt: payment.consentedAt,
					consentVersion: payment.consentVersion,
					consentText: payment.consentText,
					offerSnapshot: payment.offerSnapshot,
					offerSha256: payment.offerSha256,
					offerUpdatedAt: payment.offerUpdatedAt,
					nextChargeAt: expiresAt,
					retryAttempt: 0,
					retryStartedAt: null,
					nextRetryAt: null,
					lastChargeErrorCode: null,
					disabledAt: null,
					disableReason: null,
					paymentMethodCiphertext: input.paymentMethodCiphertext,
					paymentMethodType:
						input.paymentMethodType || currentRenewal?.paymentMethodType,
					paymentMethodTitle:
						input.paymentMethodTitle || currentRenewal?.paymentMethodTitle,
					paymentMethodLast4:
						input.paymentMethodLast4 || currentRenewal?.paymentMethodLast4,
					paymentMethodSavedAt: transactionNow,
					dispatchPending: false,
					stateVersion: { increment: 1 }
				}
			});
			await transaction.autoRenewalConsentEvent.create({
				data: {
					autoRenewalId: renewal.id,
					userId: payment.userId,
					type: AutoRenewalConsentEventType.CONSENT_GRANTED,
					actorUserId: payment.userId,
					actorRole: 'USER',
					source: 'CHECKOUT',
					consentVersion: payment.consentVersion,
					consentText: payment.consentText,
					offerSnapshot: payment.offerSnapshot,
					offerSha256: payment.offerSha256,
					offerUpdatedAt: payment.offerUpdatedAt,
					plan: payment.plan,
					billingPeriod: payment.billingPeriod,
					amount: payment.amount,
					currency: payment.currency,
					ip: payment.consentIp,
					userAgent: payment.consentUserAgent,
					metadata: {
						paymentId: payment.id,
						offerSha256: payment.offerSha256
					}
				}
			});
		} else if (
			payment.kind === PaymentKind.ONE_TIME &&
			currentRenewal &&
			currentRenewal.status === AutoRenewalStatus.ACTIVE
		) {
			const hadRetry = Boolean(
				currentRenewal.retryStartedAt ||
				currentRenewal.nextRetryAt ||
				currentRenewal.retryAttempt > 0 ||
				currentRenewal.dispatchPending
			);
			await transaction.autoRenewal.update({
				where: { id: currentRenewal.id },
				data: {
					nextChargeAt: expiresAt,
					retryStartedAt: null,
					retryAttempt: 0,
					nextRetryAt: null,
					dispatchPending: false,
					lastChargeErrorCode: null,
					stateVersion: { increment: 1 }
				}
			});
			if (hadRetry) {
				await transaction.autoRenewalConsentEvent.create({
					data: {
						autoRenewalId: currentRenewal.id,
						userId: currentRenewal.userId,
						type: AutoRenewalConsentEventType.RETRY_CANCELLED,
						source: 'ONE_TIME_PAYMENT_SUCCEEDED',
						reason:
							'Ручная оплата синхронизировала следующую дату списания',
						consentVersion: currentRenewal.consentVersion,
						consentText: currentRenewal.consentText,
						offerSnapshot: currentRenewal.offerSnapshot,
						offerSha256: currentRenewal.offerSha256,
						offerUpdatedAt: currentRenewal.offerUpdatedAt,
						plan: currentRenewal.plan,
						billingPeriod: currentRenewal.billingPeriod,
						amount: currentRenewal.amount,
						currency: currentRenewal.currency,
						metadata: { paymentId: payment.id }
					}
				});
			}
		}

		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`billing.referral:${payment.userId}`}, 0)
			)
		`;
		const affiliate = await this.applyAffiliate(
			transaction,
			updatedPayment
		);
		await transaction.providerOperation.upsert({
			where: { idempotencyKey: `receipt:${payment.id}` },
			create: {
				paymentId: payment.id,
				providerPaymentId: input.providerPaymentId,
				idempotencyKey: `receipt:${payment.id}`,
				kind: 'SYNC_RECEIPT',
				payload: {
					paymentId: payment.id,
					providerPaymentId: input.providerPaymentId
				}
			},
			update: {}
		});

		const occurredAt = input.succeededAt.toISOString();
		await Promise.all([
			this.createOutbox(transaction, {
				eventType: BILLING_EVENT_TYPES.paymentSucceeded,
				aggregateType: 'payment',
				aggregateId: payment.id,
				aggregateVersion: paymentVersion,
				sourceSequence: paymentSequence,
				payload: {
					schemaVersion: 1,
					eventType: BILLING_EVENT_TYPES.paymentSucceeded,
					payment: {
						id: payment.id,
						yookassaId: input.providerPaymentId,
						amount: payment.amount,
						plan: payment.plan,
						billingPeriod: payment.billingPeriod,
						succeededAt: occurredAt
					},
					user: {
						id: payment.userId,
						name: identity.name,
						email: identity.email,
						phone: identity.phone
					},
					subscription: {
						expiresAt: subscription.expiresAt?.toISOString() || null
					}
				}
			}),
			this.createOutbox(transaction, {
				eventType: BILLING_EVENT_TYPES.paymentChanged,
				aggregateType: 'billing.payment',
				aggregateId: payment.id,
				aggregateVersion: paymentVersion,
				sourceSequence: paymentSequence,
				payload: this.paymentProjection(updatedPayment, occurredAt)
			}),
			this.createOutbox(transaction, {
				eventType: BILLING_EVENT_TYPES.paymentDetailsChanged,
				aggregateType: 'billing.payment',
				aggregateId: payment.id,
				aggregateVersion: paymentVersion,
				sourceSequence: paymentSequence,
				payload: this.paymentDetailsProjection(updatedPayment, occurredAt)
			}),
			this.createOutbox(transaction, {
				eventType: BILLING_EVENT_TYPES.subscriptionChanged,
				aggregateType: 'billing.subscription',
				aggregateId: subscription.id,
				aggregateVersion: subscriptionVersion,
				sourceSequence: subscriptionSequence,
				payload: this.subscriptionProjection(subscription, occurredAt)
			}),
			this.createOutbox(transaction, {
				eventType: BILLING_EVENT_TYPES.subscriptionDetailsChanged,
				aggregateType: 'billing.subscription',
				aggregateId: subscription.id,
				aggregateVersion: subscriptionVersion,
				sourceSequence: subscriptionSequence,
				payload: this.subscriptionDetailsProjection(
					subscription,
					occurredAt
				)
			}),
			...(affiliate
				? [
						this.createOutbox(transaction, {
							eventType: BILLING_EVENT_TYPES.affiliateChanged,
							aggregateType: 'billing.affiliate',
							aggregateId: affiliate.id,
							aggregateVersion: affiliate.aggregateVersion,
							sourceSequence: affiliate.sourceSequence,
							payload: this.affiliateProjection(affiliate, occurredAt)
						})
					]
				: []),
			this.createTelegramNotification(
				transaction,
				updatedPayment,
				identity,
				paymentVersion,
				paymentSequence,
				occurredAt
			)
		]);

		return {
			paymentId: payment.id,
			status: PaymentStatus.SUCCEEDED,
			subscriptionId: subscription.id,
			duplicate: false
		};
	}

	private async applyAffiliate(
		transaction: Prisma.TransactionClient,
		payment: { id: string; userId: string; amount: string }
	): Promise<{
		id: string;
		referrerId: string;
		referredUserId: string;
		firstPaymentId: string | null;
		status: AffiliateReferralStatus;
		paymentAmount: number | null;
		cashbackPercent: number | null;
		cashbackAmount: number | null;
		availableAt: Date | null;
		cancelledAt: Date | null;
		paidAt: Date | null;
		aggregateVersion: bigint;
		sourceSequence: bigint;
		createdAt: Date;
		updatedAt: Date;
	} | null> {
		const referral = await transaction.affiliateReferral.findUnique({
			where: { referredUserId: payment.userId }
		});
		if (
			!referral ||
			referral.status !== AffiliateReferralStatus.REGISTERED
		)
			return null;
		const settings = await transaction.billingSettings.upsert({
			where: { id: 'singleton' },
			create: { id: 'singleton' },
			update: {}
		});
		const count = await transaction.payment.count({
			where: { userId: payment.userId, status: PaymentStatus.SUCCEEDED }
		});
		const sequence = await this.nextSourceSequence(transaction);
		const version = referral.aggregateVersion + 1n;
		if (!settings.affiliateProgramEnabled || count !== 1) {
			return transaction.affiliateReferral.update({
				where: { id: referral.id },
				data: {
					status: AffiliateReferralStatus.CANCELLED,
					cancelledAt: new Date(),
					aggregateVersion: version,
					sourceSequence: sequence
				}
			});
		}
		const paymentAmount = Math.round(Number(payment.amount));
		const cashbackAmount = Math.floor(
			(paymentAmount * settings.affiliateCashbackPercent) / 100
		);
		return transaction.affiliateReferral.update({
			where: { id: referral.id },
			data: {
				firstPaymentId: payment.id,
				status: AffiliateReferralStatus.REWARD_PENDING,
				paymentAmount,
				cashbackPercent: settings.affiliateCashbackPercent,
				cashbackAmount,
				availableAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
				aggregateVersion: version,
				sourceSequence: sequence
			}
		});
	}

	private async createTelegramNotification(
		transaction: Prisma.TransactionClient,
		payment: {
			id: string;
			userId: string;
			yookassaId: string | null;
			amount: string;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			succeededAt: Date | null;
		},
		identity: {
			name: string | null;
			email: string | null;
			phone: string | null;
		},
		aggregateVersion: bigint,
		sourceSequence: bigint,
		occurredAt: string
	): Promise<void> {
		const routing =
			await transaction.notificationRoutingProjection.findUnique({
				where: { id: 'singleton' }
			});
		await this.createOutbox(transaction, {
			eventType: BILLING_EVENT_TYPES.paymentTelegramRequested,
			aggregateType: 'payment',
			aggregateId: payment.id,
			aggregateVersion,
			sourceSequence,
			payload: {
				schemaVersion: 1,
				eventType: BILLING_EVENT_TYPES.paymentTelegramRequested,
				payment: {
					id: payment.id,
					yookassaId: payment.yookassaId,
					amount: payment.amount,
					plan: payment.plan,
					billingPeriod: payment.billingPeriod,
					succeededAt: payment.succeededAt?.toISOString() || occurredAt
				},
				user: {
					id: payment.userId,
					...identity
				},
				destination: {
					telegramChatId: routing?.telegramChatId ?? null,
					messageThreadId:
						routing?.paymentsThreadId && routing.paymentsThreadId > 0
							? routing.paymentsThreadId
							: null
				}
			}
		});
	}

	private async nextSourceSequence(
		transaction: Prisma.TransactionClient
	): Promise<bigint> {
		const state = await transaction.billingSourceSequence.upsert({
			where: { id: 'billing' },
			create: { id: 'billing', nextValue: 2n },
			update: { nextValue: { increment: 1n } }
		});
		return state.nextValue - 1n;
	}

	private createOutbox(
		transaction: Prisma.TransactionClient,
		input: {
			eventType: string;
			aggregateType: string;
			aggregateId: string;
			aggregateVersion: bigint;
			sourceSequence: bigint;
			payload: Record<string, unknown>;
		}
	): Promise<unknown> {
		const eventId = randomUUID();
		const versioned = input.eventType.startsWith('billing.');
		return transaction.outboxEvent.create({
			data: {
				eventId,
				eventType: input.eventType,
				aggregateType: input.aggregateType,
				aggregateId: input.aggregateId,
				aggregateVersion: input.aggregateVersion,
				sourceSequence: input.sourceSequence,
				correlationId: getBillingCorrelationId(),
				exchange: BILLING_EVENTS_EXCHANGE,
				routingKey: input.eventType,
				payload: (versioned
					? {
							eventId,
							eventType: input.eventType,
							aggregateId: input.aggregateId,
							aggregateVersion: input.aggregateVersion.toString(),
							sourceSequence: input.sourceSequence.toString(),
							tombstone: false,
							...input.payload
						}
					: input.payload) as Prisma.InputJsonValue
			}
		});
	}

	private paymentProjection(
		payment: {
			id: string;
			userId: string;
			status: PaymentStatus;
			kind: PaymentKind;
			amount: string;
			currency: string;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			autoRenew: boolean;
			succeededAt: Date | null;
			createdAt: Date;
			updatedAt: Date;
		},
		occurredAt: string
	): Record<string, unknown> {
		return {
			schemaVersion: 1,
			occurredAt,
			state: {
				id: payment.id,
				userId: payment.userId,
				amount: payment.amount,
				status: payment.status,
				createdAt: payment.createdAt.toISOString(),
				updatedAt: payment.updatedAt.toISOString()
			}
		};
	}

	private subscriptionProjection(
		subscription: {
			id: string;
			userId: string;
			plan: Plan;
			billingPeriod: BillingPeriod | null;
			status: SubscriptionStatus;
			startsAt: Date;
			expiresAt: Date | null;
			leadsThisPeriod: number;
			periodResetsAt: Date | null;
			createdAt: Date;
			updatedAt: Date;
		},
		occurredAt: string
	): Record<string, unknown> {
		return {
			schemaVersion: 1,
			occurredAt,
			state: {
				id: subscription.id,
				userId: subscription.userId,
				plan: subscription.plan,
				billingPeriod: subscription.billingPeriod,
				status: subscription.status,
				startsAt: subscription.startsAt.toISOString(),
				expiresAt: subscription.expiresAt?.toISOString() || null,
				periodResetsAt: subscription.periodResetsAt?.toISOString() || null,
				maxWidgets: subscription.plan === Plan.HARD ? 10 : 1,
				maxLeadsPerPeriod:
					subscription.plan === Plan.TRIAL
						? 10
						: subscription.plan === Plan.EASY
							? 100
							: null,
				unlimited: subscription.plan === Plan.HARD,
				createdAt: subscription.createdAt.toISOString()
			}
		};
	}

	private paymentDetailsProjection(
		payment: {
			id: string;
			userId: string;
			yookassaId: string | null;
			status: PaymentStatus;
			amount: string;
			plan: Plan | null;
			billingPeriod: BillingPeriod | null;
			createdAt: Date;
			updatedAt: Date;
		},
		occurredAt: string
	): Record<string, unknown> {
		return {
			schemaVersion: 1,
			occurredAt,
			state: {
				id: payment.id,
				userId: payment.userId,
				yookassaId: payment.yookassaId,
				status: payment.status,
				amount: payment.amount,
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				createdAt: payment.createdAt.toISOString(),
				updatedAt: payment.updatedAt.toISOString()
			}
		};
	}

	private subscriptionDetailsProjection(
		subscription: {
			id: string;
			userId: string;
			plan: Plan;
			billingPeriod: BillingPeriod | null;
			status: SubscriptionStatus;
			startsAt: Date;
			expiresAt: Date | null;
			leadsThisPeriod: number;
			periodResetsAt: Date | null;
			createdAt: Date;
			updatedAt: Date;
		},
		occurredAt: string
	): Record<string, unknown> {
		return {
			schemaVersion: 1,
			occurredAt,
			state: {
				id: subscription.id,
				userId: subscription.userId,
				plan: subscription.plan,
				billingPeriod: subscription.billingPeriod,
				status: subscription.status,
				startsAt: subscription.startsAt.toISOString(),
				expiresAt: subscription.expiresAt?.toISOString() || null,
				leadsThisPeriod: subscription.leadsThisPeriod,
				periodResetsAt: subscription.periodResetsAt?.toISOString() || null,
				createdAt: subscription.createdAt.toISOString(),
				updatedAt: subscription.updatedAt.toISOString()
			}
		};
	}

	private affiliateProjection(
		affiliate: {
			id: string;
			referrerId: string;
			referredUserId: string;
			firstPaymentId: string | null;
			status: AffiliateReferralStatus;
			cashbackAmount: number | null;
			availableAt: Date | null;
			cancelledAt: Date | null;
			updatedAt: Date;
		},
		occurredAt: string
	): Record<string, unknown> {
		return {
			schemaVersion: 1,
			occurredAt,
			state: {
				id: affiliate.id,
				referrerId: affiliate.referrerId,
				referredUserId: affiliate.referredUserId,
				firstPaymentId: affiliate.firstPaymentId,
				status: affiliate.status,
				cashbackAmount: affiliate.cashbackAmount,
				availableAt: affiliate.availableAt?.toISOString() || null,
				cancelledAt: affiliate.cancelledAt?.toISOString() || null,
				updatedAt: affiliate.updatedAt.toISOString()
			}
		};
	}

	private addBillingPeriod(date: Date, period: BillingPeriod): Date {
		return period === BillingPeriod.YEARLY
			? this.addCalendarMonthsClamped(date, 12)
			: this.addCalendarMonthsClamped(date, 1);
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

	private isSerializationConflict(error: unknown): boolean {
		if (typeof error !== 'object' || error === null) return false;
		const candidate = error as {
			code?: string;
			meta?: { code?: string };
		};
		return (
			candidate.code === 'P2034' ||
			(candidate.code === 'P2010' &&
				['40001', '40P01'].includes(candidate.meta?.code || ''))
		);
	}
}
