import { AffiliateService } from '@/affiliate/affiliate.service';
import { enqueuePaymentSucceededEvent } from '@/messaging/payment-succeeded-event';
import { enqueuePaymentTelegramNotificationEvent } from '@/messaging/payment-telegram-notification-event';
import {
	AutoRenewalService,
	PaymentRequestContext
} from '@/payment/auto-renewal.service';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION,
	buildRecurringCycleKey,
	isAutoRenewalOfferCompatible,
	PAYMENT_CHECKOUT_TTL_MS,
	PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
} from '@/payment/payment.constants';
import { PaymentReceiptService } from '@/payment/payment-receipt.service';
import {
	IYookassaPaymentResponse,
	YookassaService
} from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import {
	PLAN_PRICES,
	PLAN_PRIORITY
} from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	AutoRenewal,
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	AuthIdentityType,
	BillingPeriod,
	Payment,
	PaymentKind,
	PaymentStatus,
	Plan,
	Prisma,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

const TRANSACTION_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable
} as const;
const RECURRING_PROVIDER_TRANSACTION_OPTIONS = {
	...TRANSACTION_OPTIONS,
	maxWait: 5000,
	timeout: 30_000
} as const;
const SERIALIZABLE_RETRY_LIMIT = 3;
const CHARGE_DATE_DRIFT_MS = 60 * 1000;

type AdminPaymentWithUser = Payment & {
	user: {
		id: string;
		name: string | null;
		authIdentities: Array<{
			type: AuthIdentityType;
			value: string;
		}>;
	};
};

type PaymentWithReceipts = Prisma.PaymentGetPayload<{
	include: { receipts: true };
}>;

type PreparedRecurringCharge = {
	payment: Payment;
	renewalStateVersion: number | null;
	providerRequestMayExist: boolean;
};

export interface AdminPaymentFilters {
	status?: string;
	plan?: string;
	billingPeriod?: string;
	createdFrom?: string;
	createdTo?: string;
	search?: string;
}

@Injectable()
export class PaymentService {
	private readonly clientUrl =
		process.env.RECAPTCHA_CLIENT_URL?.replace(/\/+$/, '') ?? '';
	private readonly logger = new Logger(PaymentService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly yookassa: YookassaService,
		private readonly subscriptionService: SubscriptionService,
		private readonly paymentCleanupService: PaymentCleanupService,
		private readonly tariffPricesService: TariffPricesService,
		private readonly affiliateService: AffiliateService,
		private readonly autoRenewalService: AutoRenewalService,
		private readonly receiptService: PaymentReceiptService
	) {}

	async createPayment(
		userId: string,
		plan: Plan,
		billingPeriod: BillingPeriod,
		expectedAmount: number,
		autoRenew = false,
		consentVersion?: string,
		context: PaymentRequestContext = {}
	) {
		if (plan === Plan.TRIAL) {
			throw new BadRequestException('Нельзя оплатить тестовый тариф');
		}
		const paymentSettings = await this.prisma.siteSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
		if (!paymentSettings.paymentEnabled) {
			throw new ServiceUnavailableException(
				'Приём платежей временно отключён'
			);
		}
		if (autoRenew && !paymentSettings.autoRenewalSignupEnabled) {
			throw new BadRequestException(
				'Подключение автопродления временно недоступно. Выберите разовую оплату'
			);
		}
		if (autoRenew) {
			this.autoRenewalService.assertEncryptionConfigured();
			if (consentVersion !== AUTO_RENEWAL_CONSENT_VERSION) {
				throw new ConflictException(
					'Условия автопродления обновились. Обновите страницу и подтвердите их заново'
				);
			}
		}

		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: { authIdentities: true }
		});
		if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
			throw new BadRequestException(
				'Пользователь не найден или неактивен'
			);
		}

		const emailIdentity = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.EMAIL
		);
		const phoneIdentity = user.authIdentities.find(
			identity => identity.type === AuthIdentityType.PHONE
		);
		if (!emailIdentity && !phoneIdentity) {
			throw new BadRequestException(
				'Для оформления подписки необходимо привязать email или телефон в профиле'
			);
		}

		const currentSubscription =
			await this.subscriptionService.checkAndResetPeriod(userId);
		if (
			currentSubscription?.status === SubscriptionStatus.ACTIVE &&
			PLAN_PRIORITY[currentSubscription.plan] > PLAN_PRIORITY[plan]
		) {
			throw new BadRequestException(
				`Пока у вас активен тариф ${this.getPlanLabel(
					currentSubscription.plan
				)}, оплатить ${this.getPlanLabel(
					plan
				)} нельзя. Дождитесь окончания текущего тарифа или продлите текущий.`
			);
		}

		const price = await this.tariffPricesService.getPrice(
			plan,
			billingPeriod
		);
		if (price !== expectedAmount) {
			throw new ConflictException(
				'Стоимость тарифа изменилась. Обновите страницу перед оплатой'
			);
		}
		const amount = this.formatAmount(price);
		await this.paymentCleanupService.cleanupStalePendingPaymentsForUser(
			userId
		);
		const intent = await this.reserveOneTimeIntent({
			userId,
			plan,
			billingPeriod,
			amount,
			autoRenew,
			context,
			customerEmail: emailIdentity?.value,
			customerPhone: phoneIdentity?.value
		});

		if (intent.yookassaId && intent.confirmationUrl) {
			return this.serializeCreatedPayment(intent);
		}

		return this.provisionOneTimeIntent(intent, {
			email: emailIdentity?.value,
			phone: phoneIdentity?.value
		});
	}

	async getPendingPayment(userId: string) {
		await this.paymentCleanupService.cleanupStalePendingPaymentsForUser(
			userId
		);
		let payment = await this.findBlockingPayment(userId);
		if (!payment) return null;

		if (
			payment.status === PaymentStatus.PENDING &&
			!payment.yookassaId &&
			payment.providerStatus === 'creating' &&
			Date.now() - payment.createdAt.getTime() <=
				PROVIDER_IDEMPOTENCY_RETRY_WINDOW_MS
		) {
			try {
				const recovered =
					await this.createOrRecoverOneTimeProviderPayment(payment);
				payment = recovered.payment;
				if (recovered.providerPayment.status === 'succeeded') {
					await this.handlePaymentSucceeded(
						recovered.providerPayment.id,
						recovered.providerPayment
					);
					return null;
				}
				if (recovered.providerPayment.status === 'canceled') {
					await this.handlePaymentCanceled(
						recovered.providerPayment.id,
						recovered.providerPayment
					);
					return null;
				}
			} catch (error) {
				this.logger.warn(
					`Pending provider creation recovery failed: paymentId=${
						payment.id
					} error=${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
		}

		const synchronized = await this.syncPaymentWithProvider(payment);
		if (!synchronized) return null;
		if (synchronized.status !== PaymentStatus.PENDING) {
			return null;
		}
		return this.serializePendingPayment(synchronized);
	}

	async cancelPendingPayment(userId: string, paymentId: string) {
		const normalizedPaymentId = paymentId.trim();
		if (!normalizedPaymentId) {
			throw new BadRequestException('Незавершённый платёж не найден');
		}

		return this.withSerializableRetry(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "User"
					WHERE "id" = ${userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "payments"
					WHERE "id" = ${normalizedPaymentId}
						AND "user_id" = ${userId}
						AND "kind" = 'ONE_TIME'
					FOR UPDATE
				`
			);
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
			await transaction.payment.update({
				where: { id: payment.id },
				data: {
					status: PaymentStatus.CANCELLED,
					confirmationUrl: null,
					cancelledAt,
					cancellationReason: 'user_cancelled'
				}
			});
			return {
				cancelled: true,
				message: 'Незавершённый платёж отменён.',
				cancelledAt: cancelledAt.toISOString()
			};
		});
	}

	async verifyPayment(userId: string, paymentId?: string) {
		const payment = paymentId
			? await this.prisma.payment.findFirst({
					where: { id: paymentId, userId }
				})
			: await this.prisma.payment.findFirst({
					where: { userId },
					orderBy: { createdAt: 'desc' }
				});
		if (!payment) return this.notFoundVerification();
		if (!payment.yookassaId) {
			return this.serializePaymentVerification(payment, false);
		}

		await this.syncPaymentWithProvider(payment);
		const updated = await this.prisma.payment.findUnique({
			where: { id: payment.id }
		});
		if (!updated) return this.notFoundVerification();
		return this.serializePaymentVerification(
			updated,
			updated.status === PaymentStatus.SUCCEEDED
		);
	}

	async getPaymentHistory(userId: string, page = 1, limit = 10) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
		const skip = (normalizedPage - 1) * normalizedLimit;

		const [initialPayments, total] = await this.prisma.$transaction([
			this.prisma.payment.findMany({
				where: { userId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit,
				include: {
					receipts: {
						orderBy: [{ registeredAt: 'desc' }, { createdAt: 'desc' }]
					}
				}
			}),
			this.prisma.payment.count({ where: { userId } })
		]);
		let payments = initialPayments;

		await this.receiptService.syncMissingForHistory(payments);
		if (
			payments.some(
				payment =>
					payment.status === PaymentStatus.SUCCEEDED &&
					Boolean(payment.yookassaId) &&
					payment.receiptSyncEligible &&
					payment.receipts.length === 0
			)
		) {
			payments = await this.prisma.payment.findMany({
				where: { userId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit,
				include: {
					receipts: {
						orderBy: [{ registeredAt: 'desc' }, { createdAt: 'desc' }]
					}
				}
			});
		}

		return {
			items: payments.map(payment =>
				this.serializeHistoryPayment(payment)
			),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
			serverTime: new Date().toISOString()
		};
	}

	async handleWebhook(body: unknown) {
		const webhook = this.asRecord(body);
		const event = typeof webhook?.event === 'string' ? webhook.event : '';
		const object = this.asRecord(webhook?.object);
		const providerId =
			typeof object?.id === 'string' ? object.id : undefined;

		if (event === 'payment.succeeded' && providerId) {
			await this.handlePaymentSucceeded(providerId);
		} else if (event === 'payment.canceled' && providerId) {
			await this.handlePaymentCanceled(providerId);
		} else if (
			(event === 'receipt.succeeded' || event === 'receipt.canceled') &&
			typeof object?.payment_id === 'string'
		) {
			await this.receiptService.syncForProviderPayment(object.payment_id);
		}
		return { ok: true };
	}

	async executeRecurringCharge(paymentId: string): Promise<void> {
		const prepared = await this.prepareRecurringCharge(paymentId);
		if (!prepared) return;

		let payment = prepared.payment;
		let providerPayment: IYookassaPaymentResponse;
		if (payment.yookassaId) {
			providerPayment = await this.yookassa.getPayment(payment.yookassaId);
			payment = await this.applyProviderCreation(payment, providerPayment);
		} else {
			const created =
				await this.createRecurringProviderPaymentUnderLock(prepared);
			if (!created) return;
			payment = created.payment;
			if (created.providerPayment) {
				providerPayment = created.providerPayment;
			} else if (payment.yookassaId) {
				providerPayment = await this.yookassa.getPayment(
					payment.yookassaId
				);
				payment = await this.applyProviderCreation(
					payment,
					providerPayment
				);
			} else {
				return;
			}
		}

		if (providerPayment.status === 'succeeded') {
			await this.handlePaymentSucceeded(
				providerPayment.id,
				providerPayment
			);
		} else if (providerPayment.status === 'canceled') {
			await this.handlePaymentCanceled(
				providerPayment.id,
				providerPayment
			);
		}
	}

	async reconcilePendingPayments(limit = 20): Promise<number> {
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const payments = await this.prisma.payment.findMany({
			where: {
				yookassaId: { not: null },
				AND: [
					{
						OR: [
							{
								status: {
									in: [PaymentStatus.PENDING, PaymentStatus.EXPIRED]
								}
							},
							{
								kind: PaymentKind.ONE_TIME,
								status: PaymentStatus.CANCELLED,
								providerStatus: 'pending',
								cancellationReason: 'user_cancelled'
							}
						]
					},
					{
						OR: [
							{ lastProviderCheckedAt: null },
							{
								lastProviderCheckedAt: {
									lte: new Date(Date.now() - 30_000)
								}
							}
						]
					}
				]
			},
			orderBy: [{ lastProviderCheckedAt: 'asc' }, { createdAt: 'asc' }],
			take: normalizedLimit
		});
		for (const payment of payments) {
			await this.syncPaymentWithProvider(payment);
		}
		return payments.length;
	}

	handleRecurringDeliveryTerminalFailure(
		paymentId: string,
		errorCode: string,
		reason: string
	): Promise<void> {
		return this.autoRenewalService.markDeliveryTerminalFailure(
			paymentId,
			errorCode,
			reason
		);
	}

	async adminGetPayments(
		page = 1,
		limit = 20,
		filters: AdminPaymentFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.getAdminPaymentWhere(filters);
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [payments, total] = await this.prisma.$transaction([
			this.prisma.payment.findMany({
				where,
				skip,
				take: normalizedLimit,
				orderBy: { createdAt: 'desc' },
				include: {
					user: {
						select: {
							id: true,
							name: true,
							authIdentities: {
								where: {
									type: {
										in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
									}
								},
								select: { type: true, value: true }
							}
						}
					}
				}
			}),
			this.prisma.payment.count({ where })
		]);
		return {
			items: payments.map(payment => this.serializeAdminPayment(payment)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async adminCheckPayment(paymentId: string) {
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
			await this.syncPaymentWithProvider(payment, true);
		}
		const updated = await this.prisma.payment.findUnique({
			where: { id: payment.id },
			include: {
				user: {
					select: {
						id: true,
						name: true,
						authIdentities: {
							where: {
								type: {
									in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
								}
							},
							select: { type: true, value: true }
						}
					}
				}
			}
		});
		if (!updated) throw new NotFoundException('Платёж не найден');
		return {
			payment: this.serializeAdminPayment(updated),
			providerStatus:
				updated.providerStatus ??
				(updated.yookassaId ? 'unknown' : 'not_created'),
			message: this.getAdminCheckMessage(
				updated.status,
				updated.providerStatus ?? 'not_created'
			),
			checkedAt: new Date().toISOString()
		};
	}

	private async prepareRecurringCharge(
		paymentId: string
	): Promise<PreparedRecurringCharge | null> {
		return this.withSerializableRetry(async transaction => {
			const candidate = await transaction.payment.findUnique({
				where: { id: paymentId },
				select: { userId: true }
			});
			if (!candidate) {
				throw new NotFoundException('Рекуррентный платёж не найден');
			}
			const settings = await transaction.siteSettings.upsert({
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
					FROM "subscriptions"
					WHERE "user_id" = ${candidate.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "auto_renewals"
					WHERE "user_id" = ${candidate.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "payments"
					WHERE "id" = ${paymentId}
					FOR UPDATE
				`
			);
			const payment = await transaction.payment.findUnique({
				where: { id: paymentId },
				include: {
					user: {
						include: {
							authIdentities: true,
							autoRenewal: true,
							subscription: true
						}
					}
				}
			});
			if (!payment || payment.kind !== PaymentKind.RECURRING) {
				throw new NotFoundException('Рекуррентный платёж не найден');
			}
			if (
				payment.status === PaymentStatus.SUCCEEDED ||
				payment.status === PaymentStatus.CANCELLED
			) {
				return null;
			}
			if (payment.yookassaId) {
				return {
					payment,
					renewalStateVersion: null,
					providerRequestMayExist: false
				};
			}

			const renewal = payment.user.autoRenewal;
			const isUnresolvedReplay = payment.providerStatus === 'creating';
			if (
				!settings.paymentEnabled ||
				!settings.autoRenewalChargesEnabled
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'auto_renewal_charges_disabled',
					isUnresolvedReplay
				);
				if (renewal && isUnresolvedReplay) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PROVIDER_STATUS_UNKNOWN',
						'Статус уже начатого запроса требует ручной сверки'
					);
				}
				return null;
			}
			if (
				renewal?.status === AutoRenewalStatus.ACTIVE &&
				this.isRecurringChargeMissedDuringGlobalPause(
					renewal,
					settings.autoRenewalChargesEnabledAt
				)
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'charge_missed_during_global_pause',
					isUnresolvedReplay
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'CHARGE_MISSED_DURING_GLOBAL_PAUSE',
					'Расчётная дата наступила во время глобальной остановки автосписаний'
				);
				return null;
			}
			if (payment.checkoutExpiresAt <= new Date()) {
				if (isUnresolvedReplay) {
					await transaction.payment.update({
						where: { id: payment.id },
						data: {
							status: PaymentStatus.EXPIRED,
							providerStatus: 'unknown',
							paymentMethodCiphertext: null,
							confirmationUrl: null,
							cancellationReason: 'charge_window_expired'
						}
					});
				} else {
					await this.cancelRecurringIntentInTransaction(
						transaction,
						payment,
						'charge_window_expired'
					);
				}
				if (renewal) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'CHARGE_WINDOW_EXPIRED',
						'Безопасное окно списания истекло'
					);
				}
				return null;
			}

			const subscription = payment.user.subscription;
			const validSubscriptionStatus =
				subscription?.status === SubscriptionStatus.ACTIVE ||
				subscription?.status === SubscriptionStatus.EXPIRED;
			const expectedAttempt = renewal?.nextRetryAt
				? renewal.retryAttempt
				: 0;
			const validCycle =
				renewal &&
				payment.recurringAttempt === expectedAttempt &&
				payment.recurringCycleKey ===
					buildRecurringCycleKey(
						renewal.id,
						renewal.nextChargeAt,
						payment.recurringAttempt
					);
			if (
				!renewal ||
				renewal.status !== AutoRenewalStatus.ACTIVE ||
				!renewal.dispatchPending ||
				renewal.pendingAmount ||
				renewal.plan !== payment.plan ||
				renewal.billingPeriod !== payment.billingPeriod ||
				renewal.amount !== payment.amount ||
				!validCycle ||
				payment.user.deletedAt ||
				payment.user.status !== UserStatus.ACTIVE ||
				!subscription ||
				!subscription.expiresAt ||
				!validSubscriptionStatus ||
				subscription.plan !== payment.plan ||
				subscription.billingPeriod !== payment.billingPeriod
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'auto_renewal_state_changed',
					isUnresolvedReplay
				);
				return null;
			}

			if (
				Math.abs(
					subscription.expiresAt.getTime() - renewal.nextChargeAt.getTime()
				) > CHARGE_DATE_DRIFT_MS
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'subscription_cycle_changed',
					isUnresolvedReplay
				);
				if (!isUnresolvedReplay) {
					await this.autoRenewalService.alignAfterOneTimePaymentInTransaction(
						transaction,
						payment.userId,
						subscription.expiresAt
					);
				} else {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PROVIDER_STATUS_UNKNOWN',
						'Статус уже начатого запроса требует ручной сверки'
					);
				}
				return null;
			}

			const currentPrice = await this.getCurrentAmountInTransaction(
				transaction,
				renewal.plan,
				renewal.billingPeriod
			);
			if (currentPrice !== renewal.amount) {
				await this.requireRecurringPriceConfirmationInTransaction(
					transaction,
					renewal,
					currentPrice,
					isUnresolvedReplay
				);
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'price_confirmation_required',
					isUnresolvedReplay
				);
				return null;
			}

			const email =
				payment.customerEmail ??
				payment.user.authIdentities.find(
					identity => identity.type === AuthIdentityType.EMAIL
				)?.value;
			const phone =
				payment.customerPhone ??
				payment.user.authIdentities.find(
					identity => identity.type === AuthIdentityType.PHONE
				)?.value;
			const ciphertext =
				payment.paymentMethodCiphertext ??
				renewal?.paymentMethodCiphertext;
			if (!email && !phone) {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'receipt_contact_missing'
				);
				if (renewal) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'RECEIPT_CONTACT_MISSING',
						'Для формирования чека отсутствует подтверждённый контакт'
					);
				}
				return null;
			}
			if (!ciphertext) {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'payment_method_missing'
				);
				if (renewal) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PAYMENT_METHOD_MISSING',
						'Сохранённый способ оплаты отсутствует'
					);
				}
				return null;
			}

			try {
				this.autoRenewalService.decryptPaymentMethod({
					paymentMethodCiphertext: ciphertext
				});
			} catch {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'payment_method_decrypt_failed'
				);
				if (renewal) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PAYMENT_METHOD_DECRYPT_FAILED',
						'Сохранённый способ оплаты не удалось расшифровать'
					);
				}
				return null;
			}

			const attemptedAt = new Date();
			const preparedPayment = await transaction.payment.update({
				where: { id: payment.id },
				data: {
					status: PaymentStatus.PENDING,
					providerStatus: 'creating',
					customerEmail: email ?? null,
					customerPhone: phone ?? null,
					paymentMethodCiphertext: ciphertext,
					lastProviderCheckedAt: attemptedAt
				}
			});
			if (renewal) {
				await transaction.autoRenewal.updateMany({
					where: { id: renewal.id },
					data: {
						lastChargeAttemptAt: attemptedAt,
						lastChargeErrorCode: null,
						stateVersion: { increment: 1 }
					}
				});
			}
			return {
				payment: preparedPayment,
				renewalStateVersion: renewal.stateVersion + 1,
				providerRequestMayExist: isUnresolvedReplay
			};
		});
	}

	private async createRecurringProviderPaymentUnderLock(
		prepared: PreparedRecurringCharge
	): Promise<{
		payment: Payment;
		providerPayment: IYookassaPaymentResponse | null;
	} | null> {
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
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "User"
					WHERE "id" = ${prepared.payment.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "subscriptions"
					WHERE "user_id" = ${prepared.payment.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "auto_renewals"
					WHERE "user_id" = ${prepared.payment.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "payments"
					WHERE "id" = ${prepared.payment.id}
					FOR UPDATE
				`
			);

			const payment = await transaction.payment.findUnique({
				where: { id: prepared.payment.id }
			});
			if (
				!payment ||
				payment.kind !== PaymentKind.RECURRING ||
				payment.status === PaymentStatus.SUCCEEDED ||
				payment.status === PaymentStatus.CANCELLED
			) {
				return null;
			}
			if (payment.yookassaId) {
				return { payment, providerPayment: null };
			}

			const renewal = await transaction.autoRenewal.findUnique({
				where: { userId: payment.userId }
			});
			const settings = await transaction.siteSettings.findUniqueOrThrow({
				where: { id: 'singleton' }
			});
			if (
				renewal?.status === AutoRenewalStatus.ACTIVE &&
				this.isRecurringChargeMissedDuringGlobalPause(
					renewal,
					settings.autoRenewalChargesEnabledAt
				)
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'charge_missed_during_global_pause',
					prepared.providerRequestMayExist
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'CHARGE_MISSED_DURING_GLOBAL_PAUSE',
					'Расчётная дата наступила во время глобальной остановки автосписаний'
				);
				return null;
			}

			const user = await transaction.user.findUnique({
				where: { id: payment.userId },
				select: {
					status: true,
					deletedAt: true,
					subscription: true
				}
			});
			const subscription = user?.subscription;
			const validSubscriptionStatus =
				subscription?.status === SubscriptionStatus.ACTIVE ||
				subscription?.status === SubscriptionStatus.EXPIRED;
			if (
				!renewal ||
				!user ||
				user.deletedAt ||
				user.status !== UserStatus.ACTIVE ||
				!subscription ||
				!subscription.expiresAt ||
				!validSubscriptionStatus ||
				subscription.plan !== renewal.plan ||
				subscription.billingPeriod !== renewal.billingPeriod
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'subscription_state_changed_before_provider_call',
					prepared.providerRequestMayExist
				);
				if (renewal) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'SUBSCRIPTION_STATE_MISMATCH',
						'Текущая подписка не соответствует условиям автопродления'
					);
				}
				return null;
			}
			if (
				Math.abs(
					subscription.expiresAt.getTime() - renewal.nextChargeAt.getTime()
				) > CHARGE_DATE_DRIFT_MS
			) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'subscription_cycle_changed_before_provider_call',
					prepared.providerRequestMayExist
				);
				if (prepared.providerRequestMayExist) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PROVIDER_STATUS_UNKNOWN',
						'Статус уже начатого запроса требует ручной сверки'
					);
				} else {
					await this.autoRenewalService.alignAfterOneTimePaymentInTransaction(
						transaction,
						payment.userId,
						subscription.expiresAt
					);
				}
				return null;
			}
			const expectedAttempt = renewal?.nextRetryAt
				? renewal.retryAttempt
				: 0;
			const validCycle =
				renewal &&
				payment.recurringAttempt === expectedAttempt &&
				payment.recurringCycleKey ===
					buildRecurringCycleKey(
						renewal.id,
						renewal.nextChargeAt,
						payment.recurringAttempt
					);
			const stateStillAllowsCharge =
				settings.paymentEnabled &&
				settings.autoRenewalChargesEnabled &&
				renewal?.status === AutoRenewalStatus.ACTIVE &&
				renewal.dispatchPending &&
				!renewal.pendingAmount &&
				renewal.stateVersion === prepared.renewalStateVersion &&
				renewal.plan === payment.plan &&
				renewal.billingPeriod === payment.billingPeriod &&
				renewal.amount === payment.amount &&
				validCycle &&
				payment.status === PaymentStatus.PENDING &&
				payment.providerStatus === 'creating';
			if (!renewal || !stateStillAllowsCharge) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'auto_renewal_state_changed_before_provider_call',
					prepared.providerRequestMayExist
				);
				if (
					renewal?.status === AutoRenewalStatus.ACTIVE &&
					prepared.providerRequestMayExist &&
					(!settings.paymentEnabled || !settings.autoRenewalChargesEnabled)
				) {
					await this.pauseRecurringRenewalInTransaction(
						transaction,
						renewal,
						'PROVIDER_STATUS_UNKNOWN',
						'Статус уже начатого запроса требует ручной сверки'
					);
				}
				return null;
			}

			if (payment.checkoutExpiresAt <= new Date()) {
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'charge_window_expired',
					prepared.providerRequestMayExist
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'CHARGE_WINDOW_EXPIRED',
					'Безопасное окно списания истекло'
				);
				return null;
			}

			const currentPrice = await this.getCurrentAmountInTransaction(
				transaction,
				renewal.plan,
				renewal.billingPeriod
			);
			if (currentPrice !== renewal.amount) {
				await this.requireRecurringPriceConfirmationInTransaction(
					transaction,
					renewal,
					currentPrice,
					prepared.providerRequestMayExist
				);
				await this.stopRecurringIntentBeforeProviderCall(
					transaction,
					payment,
					'price_confirmation_required',
					prepared.providerRequestMayExist
				);
				return null;
			}

			if (
				!payment.plan ||
				!payment.billingPeriod ||
				!payment.providerIdempotencyKey
			) {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'recurring_payment_data_missing'
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'RECURRING_PAYMENT_DATA_MISSING',
					'Локальный платёж не готов к созданию в ЮKassa'
				);
				return null;
			}

			const ciphertext =
				payment.paymentMethodCiphertext ?? renewal.paymentMethodCiphertext;
			if (!ciphertext) {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'payment_method_missing'
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'PAYMENT_METHOD_MISSING',
					'Сохранённый способ оплаты отсутствует'
				);
				return null;
			}

			let paymentMethodId: string;
			try {
				paymentMethodId = this.autoRenewalService.decryptPaymentMethod({
					paymentMethodCiphertext: ciphertext
				});
			} catch {
				await this.cancelRecurringIntentInTransaction(
					transaction,
					payment,
					'payment_method_decrypt_failed'
				);
				await this.pauseRecurringRenewalInTransaction(
					transaction,
					renewal,
					'PAYMENT_METHOD_DECRYPT_FAILED',
					'Сохранённый способ оплаты не удалось расшифровать'
				);
				return null;
			}

			const providerPayment = await this.yookassa.createPayment({
				amount: payment.amount,
				description: this.getPaymentDescription(
					payment.plan,
					payment.billingPeriod
				),
				userId: payment.userId,
				localPaymentId: payment.id,
				idempotencyKey: payment.providerIdempotencyKey,
				customerEmail: payment.customerEmail ?? undefined,
				customerPhone: payment.customerPhone ?? undefined,
				savePaymentMethod: false,
				paymentMethodId
			});
			return {
				providerPayment,
				payment: await this.applyProviderCreation(
					payment,
					providerPayment,
					transaction
				)
			};
		}, RECURRING_PROVIDER_TRANSACTION_OPTIONS);
	}

	private async cancelRecurringIntentInTransaction(
		transaction: Prisma.TransactionClient,
		payment: Pick<Payment, 'id'>,
		reason: string
	): Promise<void> {
		await transaction.payment.update({
			where: { id: payment.id },
			data: {
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_sent',
				paymentMethodCiphertext: null,
				confirmationUrl: null,
				cancelledAt: new Date(),
				cancellationReason: reason
			}
		});
	}

	private async stopRecurringIntentBeforeProviderCall(
		transaction: Prisma.TransactionClient,
		payment: Pick<Payment, 'id' | 'userId'>,
		reason: string,
		providerRequestMayExist: boolean
	): Promise<void> {
		if (providerRequestMayExist) {
			await transaction.payment.update({
				where: { id: payment.id },
				data: {
					status: PaymentStatus.EXPIRED,
					providerStatus: 'unknown',
					paymentMethodCiphertext: null,
					confirmationUrl: null,
					cancellationReason: reason
				}
			});
			return;
		}

		await this.cancelRecurringIntentInTransaction(
			transaction,
			payment,
			reason
		);
		await transaction.autoRenewal.updateMany({
			where: { userId: payment.userId },
			data: {
				dispatchPending: false,
				stateVersion: { increment: 1 }
			}
		});
	}

	private async pauseRecurringRenewalInTransaction(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		errorCode: string,
		reason: string
	): Promise<void> {
		if (renewal.status !== AutoRenewalStatus.ACTIVE) return;
		const changed = await transaction.autoRenewal.updateMany({
			where: {
				id: renewal.id,
				status: AutoRenewalStatus.ACTIVE
			},
			data: {
				status: AutoRenewalStatus.TECHNICAL_PAUSE,
				dispatchPending: false,
				disabledAt: new Date(),
				disableReason: reason,
				lastChargeErrorCode: errorCode,
				stateVersion: { increment: 1 }
			}
		});
		if (changed.count !== 1) return;
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
				source: 'AUTO_RENEWAL_WORKER',
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

	private async requireRecurringPriceConfirmationInTransaction(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		newAmount: string,
		preserveDispatchPending = false
	): Promise<void> {
		if (renewal.pendingAmount === newAmount) return;
		const detectedAt = new Date();
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				pendingAmount: newAmount,
				priceChangeDetectedAt: detectedAt,
				...(preserveDispatchPending ? {} : { dispatchPending: false }),
				stateVersion: { increment: 1 }
			}
		});
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.PRICE_CHANGE_REQUIRED,
				source: 'AUTO_RENEWAL_WORKER',
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

	private async getCurrentAmountInTransaction(
		transaction: Prisma.TransactionClient,
		plan: Plan,
		billingPeriod: BillingPeriod
	): Promise<string> {
		const price = await transaction.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		return this.formatAmount(
			price?.amount ?? PLAN_PRICES[plan][billingPeriod]
		);
	}

	private async reserveOneTimeIntent(input: {
		userId: string;
		plan: Plan;
		billingPeriod: BillingPeriod;
		amount: string;
		autoRenew: boolean;
		context: PaymentRequestContext;
		customerEmail?: string;
		customerPhone?: string;
	}) {
		return this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "User"
					WHERE "id" = ${input.userId}
					FOR UPDATE
				`
			);
			const user = await transaction.user.findUnique({
				where: { id: input.userId },
				select: { status: true, deletedAt: true }
			});
			if (!user || user.deletedAt || user.status !== UserStatus.ACTIVE) {
				throw new BadRequestException(
					'Пользователь не найден или неактивен'
				);
			}

			const now = new Date();
			const blocking = await transaction.payment.findFirst({
				where: {
					userId: input.userId,
					OR: [
						{
							kind: PaymentKind.RECURRING,
							status: PaymentStatus.PENDING
						},
						{
							kind: PaymentKind.ONE_TIME,
							status: PaymentStatus.PENDING,
							checkoutExpiresAt: { gt: now }
						}
					]
				},
				orderBy: { createdAt: 'desc' }
			});
			if (blocking) {
				const sameRequest =
					blocking.kind === PaymentKind.ONE_TIME &&
					blocking.plan === input.plan &&
					blocking.billingPeriod === input.billingPeriod &&
					blocking.amount === input.amount &&
					blocking.autoRenew === input.autoRenew &&
					blocking.status === PaymentStatus.PENDING;
				if (sameRequest) return blocking;
				throw new ConflictException(
					'Другой активный платёж ещё не завершён. Повторите попытку после его завершения.'
				);
			}

			const offer = input.autoRenew
				? await transaction.legalPage.findUnique({
						where: { slug: 'oferta' },
						select: { content: true, updatedAt: true }
					})
				: null;
			if (
				input.autoRenew &&
				!isAutoRenewalOfferCompatible(offer?.content)
			) {
				throw new ServiceUnavailableException(
					'Условия автопродления обновляются. Выберите разовую оплату или повторите позже'
				);
			}
			const offerSha256 = offer
				? createHash('sha256').update(offer.content, 'utf8').digest('hex')
				: null;
			return transaction.payment.create({
				data: {
					userId: input.userId,
					providerIdempotencyKey: randomUUID(),
					kind: PaymentKind.ONE_TIME,
					amount: input.amount,
					currency: 'RUB',
					status: PaymentStatus.PENDING,
					providerStatus: 'creating',
					plan: input.plan,
					billingPeriod: input.billingPeriod,
					autoRenew: input.autoRenew,
					consentVersion: input.autoRenew
						? AUTO_RENEWAL_CONSENT_VERSION
						: null,
					consentText: input.autoRenew ? AUTO_RENEWAL_CONSENT_TEXT : null,
					consentedAt: input.autoRenew ? now : null,
					consentIp: input.autoRenew
						? this.normalizeContextValue(input.context.ip, 128)
						: null,
					consentUserAgent: input.autoRenew
						? this.normalizeContextValue(input.context.userAgent, 1000)
						: null,
					offerSnapshot: offer?.content ?? null,
					offerSha256,
					offerUpdatedAt: offer?.updatedAt ?? null,
					customerEmail: input.customerEmail ?? null,
					customerPhone: input.customerPhone ?? null,
					checkoutExpiresAt: new Date(
						now.getTime() + PAYMENT_CHECKOUT_TTL_MS
					)
				}
			});
		}, TRANSACTION_OPTIONS);
	}

	private async provisionOneTimeIntent(
		intent: Payment,
		contact: { email?: string; phone?: string }
	) {
		let providerPayment: IYookassaPaymentResponse;
		let updated: Payment;
		try {
			const recovered = await this.createOrRecoverOneTimeProviderPayment(
				intent,
				contact
			);
			providerPayment = recovered.providerPayment;
			updated = recovered.payment;
		} catch (error) {
			this.logger.warn(
				`Payment provider creation is unresolved: paymentId=${intent.id} error=${
					error instanceof Error ? error.message : String(error)
				}`
			);
			throw new ServiceUnavailableException(
				'ЮKassa временно недоступна. Повторите создание этого же платежа — двойного списания не будет'
			);
		}

		if (providerPayment.status === 'succeeded') {
			await this.handlePaymentSucceeded(
				providerPayment.id,
				providerPayment
			);
		}
		if (providerPayment.status === 'canceled') {
			await this.handlePaymentCanceled(
				providerPayment.id,
				providerPayment
			);
			throw new BadRequestException('ЮKassa отклонила создание платежа');
		}
		if (!updated.confirmationUrl) {
			throw new ServiceUnavailableException(
				'ЮKassa не вернула ссылку на оплату'
			);
		}
		return this.serializeCreatedPayment(updated);
	}

	private async createOrRecoverOneTimeProviderPayment(
		intent: Payment,
		contact: { email?: string; phone?: string } = {}
	): Promise<{
		payment: Payment;
		providerPayment: IYookassaPaymentResponse;
	}> {
		if (
			intent.kind !== PaymentKind.ONE_TIME ||
			!intent.plan ||
			!intent.billingPeriod ||
			!intent.providerIdempotencyKey
		) {
			throw new ConflictException(
				'Локальный платёж не готов к созданию в ЮKassa'
			);
		}
		const providerPayment = await this.yookassa.createPayment({
			amount: intent.amount,
			description: this.getPaymentDescription(
				intent.plan,
				intent.billingPeriod
			),
			returnUrl: this.getReturnUrl(intent.id),
			userId: intent.userId,
			localPaymentId: intent.id,
			idempotencyKey: intent.providerIdempotencyKey,
			customerEmail: intent.customerEmail ?? contact.email,
			customerPhone: intent.customerPhone ?? contact.phone,
			savePaymentMethod: intent.autoRenew
		});
		return {
			providerPayment,
			payment: await this.applyProviderCreation(intent, providerPayment)
		};
	}

	private async applyProviderCreation(
		intent: Payment,
		providerPayment: IYookassaPaymentResponse,
		transaction?: Prisma.TransactionClient
	): Promise<Payment> {
		if (!providerPayment.id?.trim()) {
			throw new ServiceUnavailableException(
				'ЮKassa вернула некорректный идентификатор платежа'
			);
		}
		if (
			providerPayment.amount &&
			(providerPayment.amount.value !== intent.amount ||
				providerPayment.amount.currency !== intent.currency)
		) {
			throw new ConflictException(
				'Сумма платежа в ЮKassa не совпадает с локальным заказом'
			);
		}
		if (
			providerPayment.metadata?.paymentId &&
			providerPayment.metadata.paymentId !== intent.id
		) {
			throw new ConflictException(
				'ЮKassa вернула платёж от другого локального заказа'
			);
		}

		const providerCreatedAt = this.parseProviderDate(
			providerPayment.created_at
		);
		const providerExpiresAt = this.parseProviderDate(
			providerPayment.expires_at
		);
		const checkoutExpiresAt = this.getCheckoutExpiresAt(
			intent.checkoutExpiresAt,
			providerExpiresAt
		);
		const confirmationUrl =
			providerPayment.confirmation?.confirmation_url?.trim() || null;
		const paymentClient = transaction?.payment ?? this.prisma.payment;
		return paymentClient.update({
			where: { id: intent.id },
			data: {
				yookassaId: providerPayment.id,
				providerStatus: providerPayment.status,
				paymentMethodCiphertext: null,
				confirmationUrl,
				providerCreatedAt,
				providerExpiresAt,
				checkoutExpiresAt,
				lastProviderCheckedAt: new Date()
			}
		});
	}

	private async syncPaymentWithProvider(
		payment: Payment,
		throwOnProviderError = false
	): Promise<Payment | null> {
		if (!payment.yookassaId) return payment;
		try {
			const providerPayment = await this.yookassa.getPayment(
				payment.yookassaId
			);
			if (providerPayment.status === 'succeeded') {
				await this.handlePaymentSucceeded(
					payment.yookassaId,
					providerPayment
				);
				return null;
			}
			if (providerPayment.status === 'canceled') {
				await this.handlePaymentCanceled(
					payment.yookassaId,
					providerPayment
				);
				return null;
			}

			const providerExpiresAt = this.parseProviderDate(
				providerPayment.expires_at
			);
			const shouldExpire =
				payment.checkoutExpiresAt <= new Date() &&
				payment.status === PaymentStatus.PENDING;
			return this.prisma.payment.update({
				where: { id: payment.id },
				data: {
					providerStatus: providerPayment.status,
					providerExpiresAt,
					lastProviderCheckedAt: new Date(),
					...(shouldExpire
						? {
								status: PaymentStatus.EXPIRED,
								confirmationUrl: null
							}
						: {})
				}
			});
		} catch (error) {
			this.logger.warn(
				`Failed to synchronize YooKassa payment: paymentId=${
					payment.id
				} error=${error instanceof Error ? error.message : String(error)}`
			);
			if (throwOnProviderError) throw error;
			return payment;
		}
	}

	private async handlePaymentSucceeded(
		yookassaId: string,
		providerSnapshot?: IYookassaPaymentResponse
	) {
		const resolved = await this.resolveProviderPayment(
			yookassaId,
			providerSnapshot
		);
		if (!resolved) return;
		const { localPayment, providerPayment } = resolved;
		if (localPayment.status === PaymentStatus.SUCCEEDED) {
			await this.syncReceiptSafely(localPayment.id);
			return;
		}
		if (providerPayment.status !== 'succeeded') return;
		this.assertProviderPaymentMatches(localPayment, providerPayment);
		if (!localPayment.plan || !localPayment.billingPeriod) {
			throw new ConflictException(
				'У локального платежа отсутствует тариф или период'
			);
		}

		const succeededAt =
			this.parseProviderDate(providerPayment.captured_at) ?? new Date();
		const result = await this.withSerializableRetry(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
						SELECT "id"
						FROM "User"
						WHERE "id" = ${localPayment.userId}
						FOR UPDATE
					`
			);
			await transaction.$queryRaw(
				Prisma.sql`
						SELECT "id"
						FROM "auto_renewals"
						WHERE "user_id" = ${localPayment.userId}
						FOR UPDATE
					`
			);
			await transaction.$queryRaw(
				Prisma.sql`
						SELECT "id"
						FROM "payments"
						WHERE "id" = ${localPayment.id}
						FOR UPDATE
					`
			);
			const currentPayment = await transaction.payment.findUnique({
				where: { id: localPayment.id }
			});
			if (
				!currentPayment ||
				currentPayment.status === PaymentStatus.SUCCEEDED
			) {
				return null;
			}
			const wasLocallyClosed =
				currentPayment.kind === PaymentKind.ONE_TIME &&
				(currentPayment.status === PaymentStatus.CANCELLED ||
					currentPayment.status === PaymentStatus.EXPIRED);
			const transition = await transaction.payment.updateMany({
				where: {
					id: localPayment.id,
					status: { not: PaymentStatus.SUCCEEDED }
				},
				data: {
					status: PaymentStatus.SUCCEEDED,
					providerStatus: 'succeeded',
					paymentMethodCiphertext: null,
					confirmationUrl: null,
					succeededAt,
					cancelledAt: null,
					lastProviderCheckedAt: new Date(),
					cancellationReason: null
				}
			});
			if (transition.count !== 1) return null;

			const updatedPayment = await transaction.payment.findUniqueOrThrow({
				where: { id: localPayment.id }
			});
			const subscription =
				await this.subscriptionService.createOrUpgradeSubscriptionInTransaction(
					transaction,
					localPayment.userId,
					localPayment.plan!,
					localPayment.billingPeriod!
				);
			if (subscription.expiresAt) {
				if (localPayment.kind === PaymentKind.RECURRING) {
					await this.autoRenewalService.markRecurringSucceededInTransaction(
						transaction,
						localPayment.userId,
						subscription.expiresAt
					);
				} else if (updatedPayment.autoRenew && !wasLocallyClosed) {
					const activated =
						await this.autoRenewalService.activateFromSuccessfulPaymentInTransaction(
							transaction,
							updatedPayment,
							providerPayment.payment_method,
							subscription.expiresAt
						);
					if (updatedPayment.autoRenew && !activated) {
						this.logger.warn(
							`YooKassa did not save payment method: paymentId=${updatedPayment.id}`
						);
					}
				} else {
					await this.autoRenewalService.alignAfterOneTimePaymentInTransaction(
						transaction,
						updatedPayment.userId,
						subscription.expiresAt
					);
				}
			}

			await this.affiliateService.processPaymentSucceededInTransaction(
				transaction,
				updatedPayment
			);
			await this.enqueueSucceededSideEffects(
				transaction,
				updatedPayment,
				subscription.expiresAt
			);
			return updatedPayment;
		});
		if (!result) return;

		await this.syncReceiptSafely(result.id);
		this.logger.log(
			`Payment succeeded: paymentId=${result.id} yookassaId=${yookassaId}`
		);
	}

	private async handlePaymentCanceled(
		yookassaId: string,
		providerSnapshot?: IYookassaPaymentResponse
	) {
		const resolved = await this.resolveProviderPayment(
			yookassaId,
			providerSnapshot
		);
		if (
			!resolved ||
			resolved.localPayment.status === PaymentStatus.SUCCEEDED
		) {
			return;
		}
		const payment = resolved.localPayment;
		const providerPayment = resolved.providerPayment;
		if (providerPayment.status !== 'canceled') return;
		const reason =
			providerPayment.cancellation_details?.reason ?? 'provider_cancelled';
		const transitioned = await this.withSerializableRetry(
			async transaction => {
				await transaction.$queryRaw(
					Prisma.sql`
						SELECT "id"
						FROM "User"
						WHERE "id" = ${payment.userId}
						FOR UPDATE
					`
				);
				await transaction.$queryRaw(
					Prisma.sql`
						SELECT "id"
						FROM "auto_renewals"
						WHERE "user_id" = ${payment.userId}
						FOR UPDATE
					`
				);
				await transaction.$queryRaw(
					Prisma.sql`
						SELECT "id"
						FROM "payments"
						WHERE "id" = ${payment.id}
						FOR UPDATE
					`
				);
				const current = await transaction.payment.findUnique({
					where: { id: payment.id }
				});
				if (
					!current ||
					current.status === PaymentStatus.SUCCEEDED ||
					(current.status === PaymentStatus.CANCELLED &&
						current.providerStatus === 'canceled')
				) {
					return false;
				}

				await transaction.payment.update({
					where: { id: current.id },
					data: {
						status: PaymentStatus.CANCELLED,
						providerStatus: 'canceled',
						paymentMethodCiphertext: null,
						confirmationUrl: null,
						cancelledAt: current.cancelledAt ?? new Date(),
						cancellationReason: reason,
						lastProviderCheckedAt: new Date()
					}
				});
				await this.autoRenewalService.markRecurringCancelledInTransaction(
					transaction,
					current,
					reason
				);
				await this.affiliateService.cancelRewardForPaymentInTransaction(
					transaction,
					current.id
				);
				return true;
			}
		);
		if (!transitioned) return;
		this.logger.log(
			`Payment cancelled: paymentId=${payment.id} reason=${reason}`
		);
	}

	private async resolveProviderPayment(
		yookassaId: string,
		providerSnapshot?: IYookassaPaymentResponse
	): Promise<{
		localPayment: Payment;
		providerPayment: IYookassaPaymentResponse;
	} | null> {
		const providerPayment =
			providerSnapshot ?? (await this.yookassa.getPayment(yookassaId));
		let localPayment = await this.prisma.payment.findUnique({
			where: { yookassaId }
		});
		if (!localPayment) {
			const localPaymentId = providerPayment.metadata?.paymentId;
			if (!localPaymentId) return null;
			const candidate = await this.prisma.payment.findUnique({
				where: { id: localPaymentId }
			});
			if (!candidate) return null;
			if (candidate.yookassaId && candidate.yookassaId !== yookassaId) {
				throw new ConflictException(
					'Локальный платёж уже связан с другим платежом ЮKassa'
				);
			}
			this.assertProviderPaymentMatches(candidate, providerPayment);
			localPayment = await this.prisma.payment.update({
				where: { id: candidate.id },
				data: {
					yookassaId,
					providerStatus: providerPayment.status,
					paymentMethodCiphertext: null,
					providerCreatedAt: this.parseProviderDate(
						providerPayment.created_at
					),
					providerExpiresAt: this.parseProviderDate(
						providerPayment.expires_at
					),
					lastProviderCheckedAt: new Date()
				}
			});
		}
		return { localPayment, providerPayment };
	}

	private async enqueueSucceededSideEffects(
		transaction: Prisma.TransactionClient,
		payment: Payment,
		subscriptionExpiresAt: Date | null
	) {
		if (!payment.yookassaId || !payment.plan || !payment.billingPeriod) {
			throw new ConflictException(
				'Платёж не готов к созданию событий успешной оплаты'
			);
		}
		const user = await transaction.user.findUnique({
			where: { id: payment.userId },
			select: {
				name: true,
				authIdentities: {
					where: {
						type: {
							in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
						}
					},
					select: { type: true, value: true }
				}
			}
		});
		const email = user?.authIdentities.find(
			identity => identity.type === AuthIdentityType.EMAIL
		)?.value;
		const phone = user?.authIdentities.find(
			identity => identity.type === AuthIdentityType.PHONE
		)?.value;
		const telegramSettings =
			await transaction.telegramBotSettings.findUnique({
				where: { id: 'singleton' },
				select: {
					dailySummaryChatId: true,
					paymentsThreadId: true
				}
			});
		const telegramChatId =
			telegramSettings?.dailySummaryChatId?.trim() || null;
		const messageThreadId =
			Number.isInteger(telegramSettings?.paymentsThreadId) &&
			Number(telegramSettings?.paymentsThreadId) > 0
				? Number(telegramSettings?.paymentsThreadId)
				: null;
		const succeededAt = (
			payment.succeededAt ?? payment.updatedAt
		).toISOString();
		const paymentEvent = {
			id: payment.id,
			yookassaId: payment.yookassaId,
			amount: payment.amount,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			succeededAt
		};
		const userEvent = {
			id: payment.userId,
			name: user?.name ?? null,
			email: email ?? null,
			phone: phone ?? null
		};

		await enqueuePaymentSucceededEvent(transaction, {
			schemaVersion: 1,
			eventType: 'payment.succeeded.v1',
			payment: paymentEvent,
			user: userEvent,
			subscription: {
				expiresAt: subscriptionExpiresAt?.toISOString() ?? null
			}
		});
		await enqueuePaymentTelegramNotificationEvent(transaction, {
			schemaVersion: 1,
			eventType: 'payment.notification.telegram.requested.v1',
			payment: paymentEvent,
			user: userEvent,
			destination: { telegramChatId, messageThreadId }
		});
	}

	private async findBlockingPayment(userId: string) {
		return this.prisma.payment.findFirst({
			where: {
				userId,
				kind: PaymentKind.ONE_TIME,
				status: PaymentStatus.PENDING,
				checkoutExpiresAt: { gt: new Date() }
			},
			orderBy: { createdAt: 'desc' }
		});
	}

	private serializeCreatedPayment(payment: Payment) {
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

	private serializePendingPayment(payment: Payment) {
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
			confirmationUrl:
				payment.status === PaymentStatus.PENDING
					? payment.confirmationUrl
					: null,
			createdAt: payment.createdAt.toISOString(),
			expiresAt: payment.checkoutExpiresAt.toISOString(),
			providerExpiresAt: payment.providerExpiresAt?.toISOString() ?? null,
			serverTime: new Date().toISOString()
		};
	}

	private serializeHistoryPayment(payment: PaymentWithReceipts) {
		const receipt =
			payment.receipts.find(item => item.publicUrl) ??
			payment.receipts[0] ??
			null;
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
			createdAt: payment.createdAt.toISOString(),
			succeededAt: payment.succeededAt?.toISOString() ?? null,
			receiptSyncEligible: payment.receiptSyncEligible,
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

	private serializePaymentVerification(
		payment: Payment,
		activated: boolean
	) {
		const status =
			payment.status === PaymentStatus.SUCCEEDED
				? 'succeeded'
				: payment.status === PaymentStatus.CANCELLED ||
					  payment.status === PaymentStatus.EXPIRED
					? 'cancelled'
					: 'pending';
		const message =
			payment.status === PaymentStatus.EXPIRED
				? 'Срок ссылки истёк. Создайте новый платёж.'
				: status === 'succeeded'
					? 'Оплата подтверждена'
					: status === 'cancelled'
						? 'Оплата отменена или не завершена'
						: 'Ожидаем подтверждение оплаты';
		return {
			activated,
			status,
			plan: payment.plan,
			billingPeriod: payment.billingPeriod,
			message
		};
	}

	private notFoundVerification() {
		return {
			activated: false,
			status: 'not_found' as const,
			plan: null,
			billingPeriod: null,
			message: 'Платёж не найден'
		};
	}

	private serializeAdminPayment(payment: AdminPaymentWithUser) {
		const email = payment.user.authIdentities.find(
			identity => identity.type === AuthIdentityType.EMAIL
		)?.value;
		const phone = payment.user.authIdentities.find(
			identity => identity.type === AuthIdentityType.PHONE
		)?.value;
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
				id: payment.user.id,
				name: payment.user.name,
				email: email ?? null,
				phone: phone ?? null
			}
		};
	}

	private getAdminPaymentWhere(
		filters: AdminPaymentFilters
	): Prisma.PaymentWhereInput | undefined {
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
		const search = filters.search?.trim();
		if (status) and.push({ status });
		if (plan !== undefined) and.push({ plan });
		if (billingPeriod !== undefined) and.push({ billingPeriod });
		if (createdAt) and.push({ createdAt });
		if (search) {
			and.push({
				OR: [
					{ id: { contains: search, mode: 'insensitive' } },
					{
						yookassaId: {
							contains: search,
							mode: 'insensitive'
						}
					},
					{
						user: {
							name: { contains: search, mode: 'insensitive' }
						}
					},
					{
						user: {
							authIdentities: {
								some: {
									type: {
										in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
									},
									value: {
										contains: search,
										mode: 'insensitive'
									}
								}
							}
						}
					}
				]
			});
		}
		return and.length ? { AND: and } : undefined;
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

	private getAdminCheckMessage(
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

	private assertProviderPaymentMatches(
		payment: Payment,
		providerPayment: IYookassaPaymentResponse
	) {
		if (
			providerPayment.amount &&
			(providerPayment.amount.value !== payment.amount ||
				providerPayment.amount.currency !== payment.currency)
		) {
			throw new ConflictException(
				'Сумма успешного платежа не совпадает с локальным заказом'
			);
		}
		if (
			providerPayment.metadata?.paymentId &&
			providerPayment.metadata.paymentId !== payment.id
		) {
			throw new ConflictException(
				'Успешный платёж относится к другому локальному заказу'
			);
		}
		if (
			providerPayment.metadata?.userId &&
			providerPayment.metadata.userId !== payment.userId
		) {
			throw new ConflictException(
				'Платёж ЮKassa относится к другому пользователю'
			);
		}
	}

	private async withSerializableRetry<T>(
		operation: (transaction: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt++) {
			try {
				return await this.prisma.$transaction(
					operation,
					TRANSACTION_OPTIONS
				);
			} catch (error) {
				lastError = error;
				if (
					!this.isSerializableConflict(error) ||
					attempt === SERIALIZABLE_RETRY_LIMIT
				) {
					throw error;
				}
			}
		}
		throw lastError;
	}

	private isSerializableConflict(error: unknown) {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2034'
		);
	}

	private async syncReceiptSafely(paymentId: string) {
		try {
			await this.receiptService.syncForPayment(paymentId);
		} catch (error) {
			this.logger.warn(
				`Receipt sync deferred: paymentId=${paymentId} error=${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private getCheckoutExpiresAt(
		localExpiry: Date,
		providerExpiry: Date | null
	) {
		if (!providerExpiry || providerExpiry <= new Date())
			return localExpiry;
		return providerExpiry < localExpiry ? providerExpiry : localExpiry;
	}

	private isRecurringChargeMissedDuringGlobalPause(
		renewal: Pick<AutoRenewal, 'nextChargeAt' | 'nextRetryAt'>,
		chargesEnabledAt: Date
	): boolean {
		const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
		return dueAt.getTime() < chargesEnabledAt.getTime();
	}

	private getReturnUrl(paymentId: string) {
		if (!this.clientUrl) {
			throw new ServiceUnavailableException(
				'Не настроен адрес возврата после оплаты'
			);
		}
		const url = new URL(`${this.clientUrl}/payment/success`);
		url.searchParams.set('paymentId', paymentId);
		return url.toString();
	}

	private getPaymentDescription(plan: Plan, billingPeriod: BillingPeriod) {
		const period =
			billingPeriod === BillingPeriod.MONTHLY ? 'месяц' : 'год';
		return `Тариф ${this.getPlanLabel(plan)} на ${period} — winwidget.ru`;
	}

	private getPlanLabel(plan: Plan) {
		switch (plan) {
			case Plan.TRIAL:
				return 'Тест-драйв';
			case Plan.EASY:
				return 'Easy';
			case Plan.HARD:
				return 'Hard';
			default:
				return plan;
		}
	}

	private formatAmount(amount: number) {
		return `${amount}.00`;
	}

	private parseProviderDate(value?: string): Date | null {
		if (!value) return null;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	private normalizeContextValue(
		value: string | null | undefined,
		maxLength: number
	) {
		const normalized = value?.trim();
		return normalized ? normalized.slice(0, maxLength) : null;
	}

	private asRecord(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}
}
