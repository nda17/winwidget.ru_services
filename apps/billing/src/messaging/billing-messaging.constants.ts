export const BILLING_EVENTS_EXCHANGE = 'winwidget.events';
export const BILLING_ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.billing.v1';
export const BILLING_RETRY_EXCHANGE = 'winwidget.billing.retry';
export const BILLING_DEAD_LETTER_EXCHANGE =
	'winwidget.billing.dead-letter';

export const BILLING_EVENT_TYPES = {
	identityChanged: 'billing.identity.changed.v1',
	offerChanged: 'billing.offer.changed.v2',
	notificationRoutingChanged: 'billing.notification-routing.changed.v1',
	trialRequested: 'billing.trial.requested.v1',
	referralRequested: 'billing.referral.requested.v1',
	lifecycleRepairRequested: 'billing.lifecycle-repair.requested.v1',
	notificationDeliveryOutcome: 'notification.delivery.outcome.v1',
	paymentSucceeded: 'payment.succeeded.v1',
	paymentTelegramRequested: 'payment.notification.telegram.requested.v1',
	autoRenewalChargeRequested: 'payment.auto-renewal.charge.requested.v1',
	subscriptionExpiryEmailRequested:
		'notification.subscription-expiry.email.requested.v1',
	subscriptionExpiryTelegramRequested:
		'notification.subscription-expiry.telegram.requested.v1',
	paymentChanged: 'billing.payment.changed.v1',
	subscriptionChanged: 'billing.subscription.changed.v1',
	affiliateChanged: 'billing.affiliate.changed.v1',
	settingsChanged: 'billing.settings.changed.v1',
	crmEntitlementChanged: 'billing.crm-entitlement.changed.v1',
	adminAudit: 'admin.audit.event.v1'
} as const;

export type BillingConsumerKind =
	| 'identity'
	| 'offer'
	| 'notification-routing'
	| 'trial-request'
	| 'referral-request'
	| 'lifecycle-repair'
	| 'auto-renewal-charge'
	| 'notification-outcome';

export const BILLING_CONSUMER_KINDS: readonly BillingConsumerKind[] = [
	'identity',
	'offer',
	'notification-routing',
	'trial-request',
	'referral-request',
	'lifecycle-repair',
	'auto-renewal-charge',
	'notification-outcome'
];

export const BILLING_QUEUE_NAMES: Record<BillingConsumerKind, string> = {
	identity: 'winwidget.billing.identity.v1',
	offer: 'winwidget.billing.offer.v2',
	'notification-routing': 'winwidget.billing.notification-routing.v1',
	'trial-request': 'winwidget.billing.trial.v1',
	'referral-request': 'winwidget.billing.referral.v1',
	'lifecycle-repair': 'winwidget.billing.lifecycle-repair.v1',
	'auto-renewal-charge': 'winwidget.payment.auto-renewal',
	'notification-outcome': 'winwidget.billing.notification-delivery-outcome'
};

export const BILLING_ROUTING_KEYS: Record<BillingConsumerKind, string> = {
	identity: BILLING_EVENT_TYPES.identityChanged,
	offer: BILLING_EVENT_TYPES.offerChanged,
	'notification-routing': BILLING_EVENT_TYPES.notificationRoutingChanged,
	'trial-request': BILLING_EVENT_TYPES.trialRequested,
	'referral-request': BILLING_EVENT_TYPES.referralRequested,
	'lifecycle-repair': BILLING_EVENT_TYPES.lifecycleRepairRequested,
	'auto-renewal-charge': BILLING_EVENT_TYPES.autoRenewalChargeRequested,
	'notification-outcome': BILLING_EVENT_TYPES.notificationDeliveryOutcome
};

export const BILLING_RETRY_DELAYS_MS = [
	60_000, 300_000, 1_800_000
] as const;

export function billingRetryRoutingKey(
	kind: BillingConsumerKind,
	attempt: number
): string {
	return `${kind}.retry.${attempt}`;
}

export function billingDeadLetterRoutingKey(
	kind: BillingConsumerKind
): string {
	return `${kind}.dead-letter`;
}
