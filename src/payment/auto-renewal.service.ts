import { enqueueAutoRenewalChargeRequestedEvent } from '@/messaging/auto-renewal-charge-event';
import { PaymentMethodCryptoService } from '@/payment/payment-method-crypto.service';
import {
	AUTO_RENEWAL_DUE_GRACE_MS,
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION,
	AUTO_RENEWAL_RETRY_DELAYS_MS,
	AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS,
	buildRecurringCycleKey,
	isAutoRenewalOfferCompatible,
	isAutoRenewalRetryableCancellation
} from '@/payment/payment.constants';
import { PrismaService } from '@/prisma.service';
import { PLAN_PRICES } from '@/subscription/subscription.constants';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
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
	Role,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { createHash } from 'node:crypto';

const TRANSACTION_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable
} as const;

export interface PaymentRequestContext {
	ip?: string | null;
	userAgent?: string | null;
}

type ProviderSavedPaymentMethod = {
	id?: string;
	type?: string;
	saved?: boolean;
	title?: string;
	card?: { last4?: string };
};

@Injectable()
export class AutoRenewalService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly crypto: PaymentMethodCryptoService
	) {}

	assertEncryptionConfigured(): void {
		this.crypto.assertConfigured();
	}

	async activateFromSuccessfulPaymentInTransaction(
		transaction: Prisma.TransactionClient,
		payment: Payment,
		paymentMethod: ProviderSavedPaymentMethod | undefined,
		nextChargeAt: Date
	): Promise<AutoRenewal | null> {
		if (!payment.autoRenew) return null;
		if (
			!paymentMethod?.saved ||
			!paymentMethod.id ||
			!payment.plan ||
			!payment.billingPeriod ||
			!payment.consentedAt ||
			!payment.consentVersion ||
			!payment.consentText ||
			!payment.offerSnapshot ||
			!payment.offerSha256 ||
			!payment.offerUpdatedAt
		) {
			return null;
		}

		await transaction.$queryRaw(
			Prisma.sql`
				SELECT "id"
				FROM "auto_renewals"
				WHERE "user_id" = ${payment.userId}
				FOR UPDATE
			`
		);
		const currentRenewal = await transaction.autoRenewal.findUnique({
			where: { userId: payment.userId }
		});
		if (
			currentRenewal &&
			currentRenewal.status !== AutoRenewalStatus.ACTIVE &&
			currentRenewal.disabledAt &&
			currentRenewal.disabledAt >= payment.consentedAt
		) {
			return currentRenewal;
		}

		const ciphertext = this.crypto.encrypt(paymentMethod.id);
		const savedAt = new Date();
		const renewal = await transaction.autoRenewal.upsert({
			where: { userId: payment.userId },
			update: {
				status: AutoRenewalStatus.ACTIVE,
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				amount: payment.amount,
				pendingAmount: null,
				priceChangeDetectedAt: null,
				currency: payment.currency,
				paymentMethodCiphertext: ciphertext,
				paymentMethodType: this.normalizeOptionalText(paymentMethod.type),
				paymentMethodTitle: this.normalizeOptionalText(
					paymentMethod.title
				),
				paymentMethodLast4: this.normalizeLast4(paymentMethod.card?.last4),
				paymentMethodSavedAt: savedAt,
				consentVersion: payment.consentVersion,
				consentText: payment.consentText,
				consentedAt: payment.consentedAt,
				offerSnapshot: payment.offerSnapshot,
				offerSha256: payment.offerSha256,
				offerUpdatedAt: payment.offerUpdatedAt,
				nextChargeAt,
				retryStartedAt: null,
				retryAttempt: 0,
				nextRetryAt: null,
				dispatchPending: false,
				disabledAt: null,
				disableReason: null,
				lastChargeAttemptAt: null,
				lastChargeErrorCode: null,
				stateVersion: { increment: 1 }
			},
			create: {
				userId: payment.userId,
				status: AutoRenewalStatus.ACTIVE,
				plan: payment.plan,
				billingPeriod: payment.billingPeriod,
				amount: payment.amount,
				currency: payment.currency,
				paymentMethodCiphertext: ciphertext,
				paymentMethodType: this.normalizeOptionalText(paymentMethod.type),
				paymentMethodTitle: this.normalizeOptionalText(
					paymentMethod.title
				),
				paymentMethodLast4: this.normalizeLast4(paymentMethod.card?.last4),
				paymentMethodSavedAt: savedAt,
				consentVersion: payment.consentVersion,
				consentText: payment.consentText,
				consentedAt: payment.consentedAt,
				offerSnapshot: payment.offerSnapshot,
				offerSha256: payment.offerSha256,
				offerUpdatedAt: payment.offerUpdatedAt,
				nextChargeAt
			}
		});

		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: AutoRenewalConsentEventType.CONSENT_GRANTED,
				actorUserId: renewal.userId,
				actorRole: Role.USER,
				source: 'CHECKOUT',
				consentVersion: renewal.consentVersion,
				consentText: renewal.consentText,
				offerSnapshot: renewal.offerSnapshot,
				offerSha256: renewal.offerSha256,
				offerUpdatedAt: renewal.offerUpdatedAt,
				plan: renewal.plan,
				billingPeriod: renewal.billingPeriod,
				amount: renewal.amount,
				currency: renewal.currency,
				ip: payment.consentIp,
				userAgent: payment.consentUserAgent,
				metadata: {
					paymentId: payment.id,
					offerSha256: renewal.offerSha256
				}
			}
		});

		return renewal;
	}

	async markRecurringSucceededInTransaction(
		transaction: Prisma.TransactionClient,
		userId: string,
		nextChargeAt: Date
	): Promise<void> {
		const renewal = await transaction.autoRenewal.findUnique({
			where: { userId }
		});
		if (!renewal) return;
		const recoverWorkerPause =
			renewal.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
			renewal.lastChargeErrorCode?.startsWith('AUTO_RENEWAL_DELIVERY:');
		await transaction.autoRenewal.updateMany({
			where: { userId },
			data: {
				nextChargeAt,
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
			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.TECHNICAL_RESUMED,
				source: 'AUTO_RENEWAL_WORKER',
				reason:
					'Автопродление восстановлено после успешного завершения списания'
			});
		}
	}

	async alignAfterOneTimePaymentInTransaction(
		transaction: Prisma.TransactionClient,
		userId: string,
		nextChargeAt: Date
	): Promise<void> {
		const renewal = await this.lockRenewal(transaction, userId);
		if (!renewal) return;
		const hadScheduledRetry = Boolean(renewal.nextRetryAt);
		await transaction.autoRenewal.update({
			where: { id: renewal.id },
			data: {
				nextChargeAt,
				retryStartedAt: null,
				retryAttempt: 0,
				nextRetryAt: null,
				dispatchPending: false,
				lastChargeErrorCode: null,
				stateVersion: { increment: 1 }
			}
		});
		if (hadScheduledRetry) {
			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.RETRY_CANCELLED,
				source: 'PAYMENT_SUCCESS',
				reason: 'Повторные попытки отменены после успешной разовой оплаты',
				metadata: { nextChargeAt: nextChargeAt.toISOString() }
			});
		}
	}

	async markDeliveryTerminalFailure(
		paymentId: string,
		errorCode: string,
		reason: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const candidate = await transaction.payment.findUnique({
				where: { id: paymentId },
				select: {
					id: true,
					userId: true,
					kind: true,
					status: true
				}
			});
			if (
				!candidate ||
				candidate.kind !== 'RECURRING' ||
				candidate.status === 'SUCCEEDED' ||
				candidate.status === 'CANCELLED'
			) {
				return;
			}
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
					WHERE "user_id" = ${candidate.userId}
					FOR UPDATE
				`
			);
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "payments"
					WHERE "id" = ${candidate.id}
					FOR UPDATE
				`
			);
			const payment = await transaction.payment.findUnique({
				where: { id: candidate.id },
				select: {
					id: true,
					userId: true,
					kind: true,
					status: true
				}
			});
			if (
				!payment ||
				payment.kind !== 'RECURRING' ||
				payment.status === 'SUCCEEDED' ||
				payment.status === 'CANCELLED'
			) {
				return;
			}
			await transaction.payment.update({
				where: { id: payment.id },
				data: {
					lastProviderCheckedAt: new Date(),
					cancellationReason: `delivery_failed:${errorCode}`
				}
			});

			const renewal = await this.lockRenewal(transaction, payment.userId);
			if (
				!renewal ||
				renewal.status === AutoRenewalStatus.USER_DISABLED ||
				renewal.status === AutoRenewalStatus.ADMIN_PAUSED ||
				renewal.status === AutoRenewalStatus.REVOKED
			) {
				return;
			}
			const storedErrorCode = `AUTO_RENEWAL_DELIVERY:${errorCode}`.slice(
				0,
				255
			);
			const alreadyRecorded =
				renewal.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
				renewal.lastChargeErrorCode === storedErrorCode;
			await transaction.autoRenewal.update({
				where: { id: renewal.id },
				data: {
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					disabledAt: renewal.disabledAt ?? new Date(),
					disableReason:
						'Автопродление приостановлено после ошибки ЮKassa',
					lastChargeErrorCode: storedErrorCode,
					stateVersion: { increment: 1 }
				}
			});
			if (!alreadyRecorded) {
				await this.createConsentEvent(transaction, renewal, {
					type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
					source: 'AUTO_RENEWAL_WORKER',
					reason: reason.slice(0, 1000),
					metadata: { errorCode }
				});
			}
		}, TRANSACTION_OPTIONS);
	}

	async markRecurringCancelledInTransaction(
		transaction: Prisma.TransactionClient,
		payment: Pick<
			Payment,
			| 'id'
			| 'userId'
			| 'kind'
			| 'recurringAttempt'
			| 'recurringCycleKey'
			| 'consentedAt'
		>,
		reason: string
	): Promise<void> {
		if (payment.kind !== 'RECURRING') return;

		const renewal = await this.lockRenewal(transaction, payment.userId);
		if (!renewal) return;
		if (
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

		const now = new Date();
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
			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.RETRY_SCHEDULED,
				source: 'YOOKASSA',
				reason,
				metadata: {
					paymentId: payment.id,
					failedAttempt: payment.recurringAttempt,
					nextAttempt,
					nextRetryAt: nextRetryAt.toISOString(),
					maxRetryAttempts: AUTO_RENEWAL_RETRY_DELAYS_MS.length
				}
			});
			return;
		}

		const permissionRevoked = reason === 'permission_revoked';
		const retriesExhausted =
			isAutoRenewalRetryableCancellation(reason) &&
			payment.recurringAttempt >= AUTO_RENEWAL_RETRY_DELAYS_MS.length;
		const targetStatus = permissionRevoked
			? AutoRenewalStatus.REVOKED
			: AutoRenewalStatus.TECHNICAL_PAUSE;
		const changed = await transaction.autoRenewal.updateMany({
			where: {
				id: renewal.id,
				stateVersion: renewal.stateVersion
			},
			data: {
				status: targetStatus,
				disabledAt: new Date(),
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

		await this.createConsentEvent(transaction, renewal, {
			type: permissionRevoked
				? AutoRenewalConsentEventType.ADMIN_REVOKED
				: retriesExhausted
					? AutoRenewalConsentEventType.RETRY_EXHAUSTED
					: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
			source: 'YOOKASSA',
			reason,
			metadata: {
				paymentId: payment.id,
				failedAttempt: payment.recurringAttempt,
				maxRetryAttempts: AUTO_RENEWAL_RETRY_DELAYS_MS.length
			}
		});
	}

	async getForUser(userId: string) {
		const detail = await this.getRenewalContext(userId);
		return this.serializeUser(detail);
	}

	async disableByUser(userId: string, context: PaymentRequestContext) {
		await this.prisma.$transaction(async transaction => {
			const renewal = await this.lockRenewal(transaction, userId);
			if (!renewal) {
				throw new BadRequestException('Автопродление не подключено');
			}
			if (
				renewal.status === AutoRenewalStatus.USER_DISABLED ||
				renewal.status === AutoRenewalStatus.REVOKED
			) {
				await this.clearFutureRecurringPaymentMethods(
					transaction,
					userId,
					'user_disabled_before_provider_call'
				);
				return;
			}

			const changed = await transaction.autoRenewal.updateMany({
				where: {
					id: renewal.id,
					stateVersion: renewal.stateVersion
				},
				data: {
					status: AutoRenewalStatus.USER_DISABLED,
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
					disableReason: 'Отключено пользователем в личном кабинете',
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления уже изменилось'
				);
			}
			await this.clearFutureRecurringPaymentMethods(
				transaction,
				userId,
				'user_disabled_before_provider_call'
			);

			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.USER_DISABLED,
				source: 'CABINET',
				reason: 'Отключено пользователем',
				actorUserId: userId,
				actorRole: Role.USER,
				context
			});
		}, TRANSACTION_OPTIONS);

		return this.getForUser(userId);
	}

	async confirmCurrentPrice(
		userId: string,
		context: PaymentRequestContext
	) {
		let chargeMayStartImmediately = false;
		await this.prisma.$transaction(async transaction => {
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

			const user = await transaction.user.findUnique({
				where: { id: userId },
				select: { status: true, deletedAt: true, subscription: true }
			});
			if (
				!this.isUserEligible(user, user?.subscription ?? null) &&
				!this.isChargeWindowEligible(
					user,
					user?.subscription ?? null,
					renewal
				)
			) {
				throw new ForbiddenException(
					'Текущий оплаченный период завершён. Оформите подписку заново'
				);
			}

			const currentAmount = await this.getCurrentAmountInTransaction(
				transaction,
				renewal.plan,
				renewal.billingPeriod
			);
			if (currentAmount !== renewal.pendingAmount) {
				throw new ConflictException(
					'Стоимость изменилась повторно. Обновите страницу'
				);
			}
			const offer = await transaction.legalPage.findUnique({
				where: { slug: 'oferta' },
				select: { content: true, updatedAt: true }
			});
			if (
				!offer?.content.trim() ||
				!isAutoRenewalOfferCompatible(offer.content)
			) {
				throw new ConflictException(
					'Условия автопродления обновляются. Повторите подтверждение позже'
				);
			}
			const offerSha256 = createHash('sha256')
				.update(offer.content, 'utf8')
				.digest('hex');
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
					offerSnapshot: offer.content,
					offerSha256,
					offerUpdatedAt: offer.updatedAt,
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Стоимость или состояние автопродления уже изменилось'
				);
			}

			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.PRICE_CHANGE_CONFIRMED,
				source: 'CABINET',
				reason: `Подтверждена новая стоимость ${currentAmount} ${renewal.currency}`,
				actorUserId: userId,
				actorRole: Role.USER,
				context,
				amount: currentAmount,
				consentVersion: AUTO_RENEWAL_CONSENT_VERSION,
				consentText: AUTO_RENEWAL_CONSENT_TEXT,
				offerSnapshot: offer.content,
				offerSha256,
				offerUpdatedAt: offer.updatedAt,
				metadata: {
					previousAmount: renewal.amount,
					newAmount: currentAmount,
					offerSha256
				}
			});
		}, TRANSACTION_OPTIONS);

		return {
			autoRenewal: await this.getForUser(userId),
			message: chargeMayStartImmediately
				? 'Новая стоимость подтверждена. Расчётная дата уже наступила, поэтому списание может начаться сразу.'
				: 'Новая стоимость подтверждена и будет применена при следующем плановом продлении.'
		};
	}

	async getForAdmin(userId: string, isDev: boolean) {
		const detail = await this.getRenewalContext(userId);
		if (!detail.user) {
			throw new NotFoundException('Пользователь не найден');
		}
		return this.serializeAdmin(detail, isDev);
	}

	async pauseByAdmin(
		userId: string,
		adminId: string,
		adminRole: Role,
		reason: string
	) {
		await this.transitionByAdmin(userId, {
			from: AutoRenewalStatus.ACTIVE,
			to: AutoRenewalStatus.ADMIN_PAUSED,
			eventType: AutoRenewalConsentEventType.ADMIN_PAUSED,
			source: 'ADMIN',
			reason,
			adminId,
			adminRole
		});
		return {
			autoRenewal: await this.getForAdmin(userId, adminRole === Role.DEV),
			message: 'Автопродление приостановлено.'
		};
	}

	async resumeAdminPause(
		userId: string,
		adminId: string,
		adminRole: Role,
		reason: string
	) {
		await this.transitionByAdmin(userId, {
			from: AutoRenewalStatus.ADMIN_PAUSED,
			to: AutoRenewalStatus.ACTIVE,
			eventType: AutoRenewalConsentEventType.ADMIN_RESUMED,
			source: 'ADMIN',
			reason,
			adminId,
			adminRole,
			requireValid: true
		});
		return {
			autoRenewal: await this.getForAdmin(userId, adminRole === Role.DEV),
			message: 'Автопродление возобновлено.'
		};
	}

	async revokeByAdmin(
		userId: string,
		adminId: string,
		adminRole: Role,
		reason: string
	) {
		await this.prisma.$transaction(async transaction => {
			const renewal = await this.lockRenewal(transaction, userId);
			if (!renewal) {
				throw new BadRequestException('Автопродление не подключено');
			}
			if (renewal.status === AutoRenewalStatus.REVOKED) {
				await this.clearFutureRecurringPaymentMethods(
					transaction,
					userId,
					'consent_revoked_before_provider_call'
				);
				return;
			}

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
					disabledAt: new Date(),
					disableReason: reason,
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления уже изменилось'
				);
			}
			await this.clearFutureRecurringPaymentMethods(
				transaction,
				userId,
				'consent_revoked_before_provider_call'
			);
			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.ADMIN_REVOKED,
				source: 'ADMIN',
				reason,
				actorUserId: adminId,
				actorRole: adminRole
			});
		}, TRANSACTION_OPTIONS);

		return {
			autoRenewal: await this.getForAdmin(userId, adminRole === Role.DEV),
			message: 'Отзыв согласия зафиксирован.'
		};
	}

	async reconcileByDev(userId: string) {
		const detail = await this.getRenewalContext(userId);
		if (!detail.user) {
			throw new NotFoundException('Пользователь не найден');
		}
		if (!detail.renewal) {
			return {
				autoRenewal: this.serializeAdmin(detail, true),
				message: 'Автопродление ранее не подключалось.'
			};
		}

		const currentAmount = await this.getCurrentAmount(
			detail.renewal.plan,
			detail.renewal.billingPeriod
		);
		let technicalError: string | null = null;
		if (!detail.renewal.paymentMethodCiphertext) {
			technicalError = 'PAYMENT_METHOD_MISSING';
		} else {
			try {
				this.crypto.decrypt(detail.renewal.paymentMethodCiphertext);
			} catch {
				technicalError = 'PAYMENT_METHOD_DECRYPT_FAILED';
			}
		}

		await this.prisma.$transaction(async transaction => {
			const renewal = await this.lockRenewal(transaction, userId);
			if (!renewal) return;
			const data: Prisma.AutoRenewalUpdateManyMutationInput = {};

			if (currentAmount !== renewal.amount) {
				data.pendingAmount = currentAmount;
				data.priceChangeDetectedAt =
					renewal.priceChangeDetectedAt ?? new Date();
			}
			if (
				technicalError &&
				renewal.status !== AutoRenewalStatus.REVOKED &&
				renewal.status !== AutoRenewalStatus.USER_DISABLED
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
				where: { id: renewal.id, stateVersion: renewal.stateVersion },
				data
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления изменилось параллельно'
				);
			}
			if (
				data.status === AutoRenewalStatus.TECHNICAL_PAUSE &&
				renewal.status !== AutoRenewalStatus.TECHNICAL_PAUSE
			) {
				await this.createConsentEvent(transaction, renewal, {
					type: AutoRenewalConsentEventType.TECHNICAL_PAUSED,
					source: 'DEV_RECONCILE',
					reason: technicalError ?? 'TECHNICAL_RECONCILE'
				});
			}
		}, TRANSACTION_OPTIONS);

		return {
			autoRenewal: await this.getForAdmin(userId, true),
			message: 'Состояние автопродления сверено.'
		};
	}

	async resumeTechnicalPause(
		userId: string,
		adminId: string,
		reason: string
	) {
		await this.prisma.$transaction(async transaction => {
			const renewal = await this.lockRenewal(transaction, userId);
			if (!renewal) {
				throw new BadRequestException('Автопродление не подключено');
			}
			if (renewal.status !== AutoRenewalStatus.TECHNICAL_PAUSE) {
				throw new ConflictException(
					'Автопродление не находится на технической паузе'
				);
			}
			if (
				!renewal.lastChargeErrorCode?.startsWith('AUTO_RENEWAL_DELIVERY:')
			) {
				throw new ForbiddenException(
					'Автоматический повтор небезопасен. Пользователь должен оформить подписку заново'
				);
			}
			await this.assertCanResume(transaction, renewal, true);

			const attempt = renewal.nextRetryAt ? renewal.retryAttempt : 0;
			const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
			const cycleKey = buildRecurringCycleKey(
				renewal.id,
				renewal.nextChargeAt,
				attempt
			);
			const payment = await transaction.payment.findFirst({
				where: {
					userId,
					recurringCycleKey: cycleKey,
					status: {
						in: ['PENDING', 'EXPIRED']
					},
					checkoutExpiresAt: {
						gt: new Date()
					}
				},
				orderBy: { createdAt: 'desc' }
			});
			if (!payment) {
				throw new ForbiddenException(
					'Безопасный запрос для повтора не найден. Пользователь должен оформить подписку заново'
				);
			}

			const changed = await transaction.autoRenewal.updateMany({
				where: {
					id: renewal.id,
					status: AutoRenewalStatus.TECHNICAL_PAUSE,
					stateVersion: renewal.stateVersion
				},
				data: {
					status: AutoRenewalStatus.ACTIVE,
					disabledAt: null,
					disableReason: null,
					lastChargeErrorCode: null,
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления уже изменилось'
				);
			}
			await this.createConsentEvent(transaction, renewal, {
				type: AutoRenewalConsentEventType.TECHNICAL_RESUMED,
				source: 'DEV',
				reason,
				actorUserId: adminId,
				actorRole: Role.DEV,
				metadata: { paymentId: payment.id, cycleKey }
			});
			await enqueueAutoRenewalChargeRequestedEvent(transaction, {
				schemaVersion: 1,
				eventType: 'payment.auto-renewal.charge.requested.v1',
				paymentId: payment.id,
				autoRenewalId: renewal.id,
				cycleKey,
				scheduledFor: dueAt.toISOString()
			});
		}, TRANSACTION_OPTIONS);

		return {
			autoRenewal: await this.getForAdmin(userId, true),
			message:
				'Техническая пауза снята. Тот же идемпотентный запрос поставлен на безопасный повтор.'
		};
	}

	decryptPaymentMethod(
		renewal: Pick<AutoRenewal, 'paymentMethodCiphertext'>
	) {
		if (!renewal.paymentMethodCiphertext) {
			throw new BadRequestException(
				'Сохранённый способ оплаты отсутствует'
			);
		}
		return this.crypto.decrypt(renewal.paymentMethodCiphertext);
	}

	private async transitionByAdmin(
		userId: string,
		input: {
			from: AutoRenewalStatus;
			to: AutoRenewalStatus;
			eventType: AutoRenewalConsentEventType;
			source: string;
			reason: string;
			adminId: string;
			adminRole: Role;
			requireValid?: boolean;
		}
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const renewal = await this.lockRenewal(transaction, userId);
			if (!renewal) {
				throw new BadRequestException('Автопродление не подключено');
			}
			if (renewal.status !== input.from) {
				throw new ConflictException(
					'Действие недоступно для текущего состояния автопродления'
				);
			}
			if (input.requireValid) {
				await this.assertCanResume(
					transaction,
					renewal,
					Boolean(renewal.nextRetryAt)
				);
			}

			const changed = await transaction.autoRenewal.updateMany({
				where: {
					id: renewal.id,
					status: input.from,
					stateVersion: renewal.stateVersion
				},
				data: {
					status: input.to,
					disabledAt:
						input.to === AutoRenewalStatus.ACTIVE ? null : new Date(),
					disableReason:
						input.to === AutoRenewalStatus.ACTIVE ? null : input.reason,
					stateVersion: { increment: 1 }
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Состояние автопродления уже изменилось'
				);
			}
			await this.createConsentEvent(transaction, renewal, {
				type: input.eventType,
				source: input.source,
				reason: input.reason,
				actorUserId: input.adminId,
				actorRole: input.adminRole
			});
		}, TRANSACTION_OPTIONS);
	}

	private async assertCanResume(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		allowTechnicalGrace = false
	): Promise<void> {
		const user = await transaction.user.findUnique({
			where: { id: renewal.userId },
			select: { status: true, deletedAt: true, subscription: true }
		});
		const subscription = user?.subscription;
		const activeSubscription =
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.plan === renewal.plan &&
			subscription.billingPeriod === renewal.billingPeriod &&
			Boolean(
				subscription.expiresAt && subscription.expiresAt > new Date()
			);
		const technicalGraceSubscription =
			allowTechnicalGrace &&
			this.isChargeWindowEligible(
				user ?? null,
				subscription ?? null,
				renewal
			);
		if (
			!user ||
			user.deletedAt ||
			user.status !== UserStatus.ACTIVE ||
			(!activeSubscription && !technicalGraceSubscription)
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
		const currentAmount = await this.getCurrentAmountInTransaction(
			transaction,
			renewal.plan,
			renewal.billingPeriod
		);
		if (renewal.pendingAmount || currentAmount !== renewal.amount) {
			throw new ForbiddenException(
				'Пользователь должен подтвердить актуальную стоимость'
			);
		}
	}

	private async getRenewalContext(userId: string) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: {
				id: true,
				name: true,
				status: true,
				deletedAt: true,
				authIdentities: {
					where: { type: AuthIdentityType.EMAIL },
					select: { value: true }
				},
				subscription: true,
				autoRenewal: true
			}
		});
		return {
			user,
			renewal: user?.autoRenewal ?? null,
			subscription: user?.subscription ?? null
		};
	}

	private serializeUser(
		detail: Awaited<ReturnType<typeof this.getRenewalContext>>
	) {
		const { user, renewal, subscription } = detail;
		if (!renewal) {
			return {
				status: 'NEVER_CONSENTED' as const,
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
				priceChange: this.serializePriceChange(null, false)
			};
		}

		const userEligible = this.isUserEligible(user, subscription);
		const chargeWindowEligible = this.isChargeWindowEligible(
			user,
			subscription,
			renewal
		);
		const priceCanConfirm =
			Boolean(renewal.pendingAmount) &&
			(userEligible || chargeWindowEligible) &&
			renewal.status !== AutoRenewalStatus.USER_DISABLED &&
			renewal.status !== AutoRenewalStatus.REVOKED;
		const active =
			renewal.status === AutoRenewalStatus.ACTIVE &&
			!renewal.pendingAmount &&
			(userEligible || chargeWindowEligible);

		return {
			status: renewal.status,
			active,
			plan: renewal.plan,
			billingPeriod: renewal.billingPeriod,
			amount: renewal.amount,
			currency: renewal.currency,
			nextChargeAt: renewal.nextChargeAt.toISOString(),
			retry: this.serializeRetry(renewal),
			disabledAt: renewal.disabledAt?.toISOString() ?? null,
			disableReason: this.getPublicDisableReason(renewal),
			canDisable:
				renewal.status !== AutoRenewalStatus.USER_DISABLED &&
				renewal.status !== AutoRenewalStatus.REVOKED,
			canEnableViaCheckout:
				renewal.status === AutoRenewalStatus.USER_DISABLED ||
				renewal.status === AutoRenewalStatus.TECHNICAL_PAUSE ||
				renewal.status === AutoRenewalStatus.REVOKED,
			serverTime: new Date().toISOString(),
			priceChange: this.serializePriceChange(renewal, priceCanConfirm)
		};
	}

	private getPublicDisableReason(renewal: AutoRenewal): string | null {
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

	private serializeAdmin(
		detail: Awaited<ReturnType<typeof this.getRenewalContext>>,
		isDev: boolean
	) {
		const { user, renewal, subscription } = detail;
		if (!user) {
			throw new NotFoundException('Пользователь не найден');
		}
		const userEligible = this.isUserEligible(user, subscription);
		const chargeWindowEligible = renewal
			? this.isChargeWindowEligible(user, subscription, renewal)
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
				id: user.id,
				name: user.name,
				email: user.authIdentities[0]?.value ?? null
			},
			status: renewal?.status ?? ('NEVER_CONSENTED' as const),
			active:
				renewal?.status === AutoRenewalStatus.ACTIVE &&
				!hasPriceChange &&
				(userEligible || chargeWindowEligible),
			plan: renewal?.plan ?? null,
			billingPeriod: renewal?.billingPeriod ?? null,
			amount: renewal?.amount ?? null,
			currency: renewal?.currency ?? null,
			nextChargeAt: renewal?.nextChargeAt.toISOString() ?? null,
			retry: renewal ? this.serializeRetry(renewal) : null,
			consentedAt: renewal?.consentedAt.toISOString() ?? null,
			consentVersion: renewal?.consentVersion ?? null,
			disabledAt: renewal?.disabledAt?.toISOString() ?? null,
			disableReason: renewal?.disableReason ?? null,
			lastChargeAttemptAt:
				renewal?.lastChargeAttemptAt?.toISOString() ?? null,
			lastChargeErrorCode: renewal?.lastChargeErrorCode ?? null,
			maskedMethod:
				renewal?.paymentMethodSavedAt && hasPaymentMethod
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
			priceChange: this.serializePriceChange(
				renewal ?? null,
				Boolean(priceCanConfirm)
			),
			capabilities: {
				canPause: renewal?.status === AutoRenewalStatus.ACTIVE,
				canResumeAdminPause:
					renewal?.status === AutoRenewalStatus.ADMIN_PAUSED && canResume,
				canRevoke:
					Boolean(renewal) &&
					renewal?.status !== AutoRenewalStatus.REVOKED,
				canReconcile: isDev,
				canResumeTechnical:
					isDev &&
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

	private serializeRetry(renewal: AutoRenewal) {
		return {
			active:
				renewal.status === AutoRenewalStatus.ACTIVE &&
				Boolean(renewal.nextRetryAt),
			attempt: renewal.retryAttempt,
			maxAttempts: AUTO_RENEWAL_RETRY_DELAYS_MS.length,
			startedAt: renewal.retryStartedAt?.toISOString() ?? null,
			nextRetryAt: renewal.nextRetryAt?.toISOString() ?? null,
			lastErrorCode: renewal.lastChargeErrorCode
		};
	}

	private serializePriceChange(
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

	private isUserEligible(
		user: {
			status: UserStatus;
			deletedAt: Date | null;
		} | null,
		subscription: {
			status: SubscriptionStatus;
			expiresAt: Date | null;
		} | null
	) {
		return Boolean(
			user &&
			!user.deletedAt &&
			user.status === UserStatus.ACTIVE &&
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.expiresAt &&
			subscription.expiresAt > new Date()
		);
	}

	private isChargeWindowEligible(
		user: {
			status: UserStatus;
			deletedAt: Date | null;
		} | null,
		subscription: {
			status: SubscriptionStatus;
			expiresAt: Date | null;
			plan: Plan;
			billingPeriod: BillingPeriod;
		} | null,
		renewal: AutoRenewal
	) {
		const dueAt = renewal.nextRetryAt ?? renewal.nextChargeAt;
		const graceMs = renewal.nextRetryAt
			? AUTO_RENEWAL_RETRY_DISPATCH_GRACE_MS
			: AUTO_RENEWAL_DUE_GRACE_MS;
		return Boolean(
			user &&
			!user.deletedAt &&
			user.status === UserStatus.ACTIVE &&
			subscription?.expiresAt &&
			(subscription.status === SubscriptionStatus.ACTIVE ||
				subscription.status === SubscriptionStatus.EXPIRED) &&
			subscription.plan === renewal.plan &&
			subscription.billingPeriod === renewal.billingPeriod &&
			Date.now() <= dueAt.getTime() + graceMs
		);
	}

	private async lockRenewal(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<AutoRenewal | null> {
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
				FROM "auto_renewals"
				WHERE "user_id" = ${userId}
				FOR UPDATE
			`
		);
		return transaction.autoRenewal.findUnique({ where: { userId } });
	}

	private async clearFutureRecurringPaymentMethods(
		transaction: Prisma.TransactionClient,
		userId: string,
		reason: string
	): Promise<void> {
		const stoppedAt = new Date();
		await transaction.payment.updateMany({
			where: {
				userId,
				kind: PaymentKind.RECURRING,
				status: PaymentStatus.PENDING,
				yookassaId: null,
				providerStatus: { in: ['queued', 'not_sent'] }
			},
			data: {
				status: PaymentStatus.CANCELLED,
				providerStatus: 'not_sent',
				paymentMethodCiphertext: null,
				confirmationUrl: null,
				cancelledAt: stoppedAt,
				cancellationReason: reason
			}
		});
		await transaction.payment.updateMany({
			where: {
				userId,
				kind: PaymentKind.RECURRING,
				status: PaymentStatus.PENDING,
				yookassaId: null,
				providerStatus: 'creating'
			},
			data: {
				status: PaymentStatus.EXPIRED,
				providerStatus: 'unknown',
				paymentMethodCiphertext: null,
				confirmationUrl: null,
				cancellationReason: reason
			}
		});
		await transaction.payment.updateMany({
			where: {
				userId,
				kind: PaymentKind.RECURRING,
				paymentMethodCiphertext: { not: null }
			},
			data: {
				paymentMethodCiphertext: null
			}
		});
	}

	private async getCurrentAmount(
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		const price = await this.prisma.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		return this.formatAmount(
			price?.amount ?? PLAN_PRICES[plan][billingPeriod]
		);
	}

	private async getCurrentAmountInTransaction(
		transaction: Prisma.TransactionClient,
		plan: Plan,
		billingPeriod: BillingPeriod
	) {
		const price = await transaction.tariffPrice.findUnique({
			where: { plan_billingPeriod: { plan, billingPeriod } },
			select: { amount: true }
		});
		return this.formatAmount(
			price?.amount ?? PLAN_PRICES[plan][billingPeriod]
		);
	}

	private formatAmount(amount: number) {
		return `${amount}.00`;
	}

	private async createConsentEvent(
		transaction: Prisma.TransactionClient,
		renewal: AutoRenewal,
		input: {
			type: AutoRenewalConsentEventType;
			source: string;
			reason?: string | null;
			actorUserId?: string | null;
			actorRole?: Role | null;
			context?: PaymentRequestContext;
			amount?: string;
			consentVersion?: string;
			consentText?: string;
			offerSnapshot?: string | null;
			offerSha256?: string | null;
			offerUpdatedAt?: Date | null;
			metadata?: Prisma.InputJsonValue;
		}
	) {
		await transaction.autoRenewalConsentEvent.create({
			data: {
				autoRenewalId: renewal.id,
				userId: renewal.userId,
				type: input.type,
				actorUserId: input.actorUserId ?? null,
				actorRole: input.actorRole ?? null,
				source: input.source,
				reason: input.reason ?? null,
				consentVersion: input.consentVersion ?? renewal.consentVersion,
				consentText: input.consentText ?? renewal.consentText,
				offerSnapshot:
					input.offerSnapshot === undefined
						? renewal.offerSnapshot
						: input.offerSnapshot,
				offerSha256:
					input.offerSha256 === undefined
						? renewal.offerSha256
						: input.offerSha256,
				offerUpdatedAt:
					input.offerUpdatedAt === undefined
						? renewal.offerUpdatedAt
						: input.offerUpdatedAt,
				plan: renewal.plan,
				billingPeriod: renewal.billingPeriod,
				amount: input.amount ?? renewal.amount,
				currency: renewal.currency,
				ip: input.context?.ip ?? null,
				userAgent: input.context?.userAgent ?? null,
				metadata: input.metadata ?? {}
			}
		});
	}

	private normalizeOptionalText(value?: string): string | null {
		const normalized = value?.trim();
		return normalized ? normalized.slice(0, 255) : null;
	}

	private normalizeLast4(value?: string): string | null {
		const normalized = value?.trim() ?? '';
		return /^\d{4}$/.test(normalized) ? normalized : null;
	}
}
