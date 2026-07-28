import {
	AutoRenewalConsentEventType,
	AutoRenewalStatus,
	PaymentKind,
	PaymentStatus,
	Prisma
} from '@prisma/client';

interface DisableAutoRenewalLifecycleInput {
	userId: string;
	status: AutoRenewalStatus;
	eventType: AutoRenewalConsentEventType;
	source: string;
	reason: string;
	actorUserId?: string | null;
	actorRole?: string | null;
}

export async function disableAutoRenewalForLifecycleInTransaction(
	transaction: Prisma.TransactionClient,
	input: DisableAutoRenewalLifecycleInput
): Promise<boolean> {
	const renewal = await transaction.autoRenewal.findUnique({
		where: { userId: input.userId }
	});
	const now = new Date();
	if (!renewal || renewal.status === input.status) {
		await clearFutureRecurringPaymentMethods(
			transaction,
			input.userId,
			input.reason,
			now
		);
		return false;
	}
	const updated = await transaction.autoRenewal.updateMany({
		where: {
			id: renewal.id,
			stateVersion: renewal.stateVersion
		},
		data: {
			status: input.status,
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
			disableReason: input.reason,
			stateVersion: { increment: 1 }
		}
	});
	if (updated.count !== 1) return false;
	await clearFutureRecurringPaymentMethods(
		transaction,
		input.userId,
		input.reason,
		now
	);

	await transaction.autoRenewalConsentEvent.create({
		data: {
			autoRenewalId: renewal.id,
			userId: renewal.userId,
			type: input.eventType,
			actorUserId: input.actorUserId ?? null,
			actorRole: input.actorRole ?? null,
			source: input.source,
			reason: input.reason,
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
	return true;
}

async function clearFutureRecurringPaymentMethods(
	transaction: Prisma.TransactionClient,
	userId: string,
	reason: string,
	stoppedAt: Date
): Promise<void> {
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
