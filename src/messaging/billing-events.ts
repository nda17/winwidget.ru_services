import {
	AffiliateReferralStatus,
	BillingPeriod,
	PaymentStatus,
	Plan,
	SubscriptionStatus
} from '@prisma/client';

interface BillingVersionedEventBase {
	schemaVersion: 1;
	eventType: string;
	eventId: string;
	aggregateId: string;
	aggregateVersion: string;
	sourceSequence: string;
	occurredAt: string;
	tombstone: boolean;
}

export interface BillingIdentityState {
	id: string;
	name: string | null;
	email: string | null;
	phone: string | null;
	status: 'ACTIVE' | 'DEACTIVATED';
	deletedAt: string | null;
	roles: Array<'USER' | 'ADMIN' | 'DEV'>;
	telegramChatId: string | null;
	telegramChannelActive: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface BillingTrialRequestedState {
	userId: string;
	trialDays: number;
	registeredAt: string;
}

export interface BillingReferralRequestedState {
	referrerId: string;
	referredUserId: string;
	requestedAt: string;
}

export interface BillingNotificationRoutingState {
	id: string;
	telegramChatId: string | null;
	paymentsThreadId: number | null;
	updatedAt: string;
}

export interface BillingOfferState {
	id: 'offer';
	content: string;
	sha256: string;
	updatedAt: string;
	consentVersion: 'auto-renewal-2026-07-28-v4';
	consentText: string;
}

export interface BillingPaymentDetailsState {
	id: string;
	userId: string;
	yookassaId: string | null;
	status: PaymentStatus;
	amount: string;
	plan: Plan | null;
	billingPeriod: BillingPeriod | null;
	createdAt: string;
	updatedAt: string;
}

export interface BillingSubscriptionDetailsState {
	id: string;
	userId: string;
	plan: Plan;
	billingPeriod: BillingPeriod | null;
	status: SubscriptionStatus;
	startsAt: string;
	expiresAt: string | null;
	leadsThisPeriod: number;
	periodResetsAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface BillingAffiliateState {
	id: string;
	referrerId: string;
	referredUserId: string;
	firstPaymentId: string | null;
	status: AffiliateReferralStatus;
	cashbackAmount: number | null;
	availableAt: string | null;
	cancelledAt: string | null;
	updatedAt: string;
}

export type BillingProjectionEventPayload = BillingVersionedEventBase &
	(
		| {
				eventType: 'billing.payment.details.changed.v1';
				state: BillingPaymentDetailsState | null;
		  }
		| {
				eventType: 'billing.subscription.details.changed.v1';
				state: BillingSubscriptionDetailsState | null;
		  }
		| {
				eventType: 'billing.affiliate.changed.v1';
				state: BillingAffiliateState | null;
		  }
	);

export const BILLING_ADMIN_AUDIT_ACTIONS = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'TARIFF_PRICES_UPDATE',
	'SUBSCRIPTION_ACTIVATE',
	'SUBSCRIPTION_EXTEND_DAYS',
	'SUBSCRIPTION_CANCEL',
	'SUBSCRIPTION_EXPIRY_CHECK_RUN',
	'AUTO_RENEWAL_ADMIN_PAUSE',
	'AUTO_RENEWAL_ADMIN_RESUME',
	'AUTO_RENEWAL_REVOKE',
	'AUTO_RENEWAL_RECONCILE',
	'AUTO_RENEWAL_TECHNICAL_RESUME',
	'AFFILIATE_SETTINGS_UPDATE',
	'SITE_SETTINGS_UPDATE',
	'BILLING_DELIVERY_RETRY'
] as const;

export type BillingAdminAuditAction =
	(typeof BILLING_ADMIN_AUDIT_ACTIONS)[number];

export const BILLING_ADMIN_AUDIT_SECTIONS = [
	'PAYMENTS',
	'SUBSCRIPTIONS',
	'AFFILIATE',
	'SITE_SETTINGS',
	'TASKS',
	'MESSAGING'
] as const;

export type BillingAdminAuditSection =
	(typeof BILLING_ADMIN_AUDIT_SECTIONS)[number];

export interface BillingAdminAuditEventPayload {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	section: BillingAdminAuditSection;
	action: BillingAdminAuditAction;
	description: string;
	entity: {
		type: string;
		id: string;
		label: string | null;
		targetUserId: string | null;
	};
	metadata: Record<string, unknown>;
}
