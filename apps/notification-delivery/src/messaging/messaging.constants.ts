export const OUTBOX_EVENT_TYPE = 'lead.integration.requested.v2';
export const PAYMENT_SUCCEEDED_EVENT_TYPE = 'payment.succeeded.v1';
export const PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'payment.notification.telegram.requested.v1';
export const LIMIT_REACHED_EMAIL_EVENT_TYPE =
	'lead.limit.reached.email.v2';
export const LIMIT_REACHED_TELEGRAM_EVENT_TYPE =
	'lead.limit.reached.telegram.v2';
export const TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE =
	'notification.telegram.destination-unavailable.v1';
export const CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.email.requested.v2';
export const CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.telegram.requested.v2';
export const DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.daily-summary.telegram.requested.v1';
export const SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.email.requested.v1';
export const SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.telegram.requested.v1';
export const WINCRM_INVITATION_EMAIL_EVENT_TYPE =
	'notification.wincrm.invitation.email.requested.v1';
export const NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'notification.delivery.outcome.v1';
export const REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'reporting.notification.delivery.outcome.v1';
export const CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'notification.delivery.outcome.v2';

export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';

export const DEFAULT_NOTIFICATION_DELIVERY_KINDS = [
	'email',
	'telegram',
	'payment-email',
	'payment-telegram',
	'limit-email',
	'limit-telegram',
	'campaign-email',
	'campaign-telegram',
	'daily-summary-delivery-telegram',
	'subscription-expiry-email',
	'subscription-expiry-telegram'
] as const;

// New product delivery is opt-in; existing deployments retain their consumers.
export const NOTIFICATION_DELIVERY_KINDS = [
	...DEFAULT_NOTIFICATION_DELIVERY_KINDS,
	'wincrm-invitation-email'
] as const;

export type NotificationDeliveryKind =
	(typeof NOTIFICATION_DELIVERY_KINDS)[number];
export type IntegrationKind = NotificationDeliveryKind;
export type MessagingKind = NotificationDeliveryKind;

export const MESSAGING_KINDS = NOTIFICATION_DELIVERY_KINDS;

export const isWincrmInvitationDeliveryEnabled = (
	configuredKinds?: string
): boolean =>
	configuredKinds
		?.split(',')
		.some(kind => kind.trim() === 'wincrm-invitation-email') === true;

export const MESSAGING_ROUTING_KEYS: Record<MessagingKind, string> = {
	email: 'lead.integration.email.v2',
	telegram: 'lead.integration.telegram.v2',
	'payment-email': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'payment-telegram': PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'limit-email': LIMIT_REACHED_EMAIL_EVENT_TYPE,
	'limit-telegram': LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	'campaign-email': CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	'campaign-telegram': CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'daily-summary-delivery-telegram':
		DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-email':
		SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-telegram':
		SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'wincrm-invitation-email': WINCRM_INVITATION_EMAIL_EVENT_TYPE
};

export const MESSAGING_QUEUE_NAMES: Record<MessagingKind, string> = {
	email: 'winwidget.lead-integration.email',
	telegram: 'winwidget.lead-integration.telegram',
	'payment-email': 'winwidget.payment-notification.email',
	'payment-telegram': 'winwidget.payment-notification.telegram.v2',
	'limit-email': 'winwidget.limit-notification.email',
	'limit-telegram': 'winwidget.limit-notification.telegram',
	'campaign-email': 'winwidget.notification.campaign.email.v2',
	'campaign-telegram': 'winwidget.notification.campaign.telegram.v2',
	'daily-summary-delivery-telegram':
		'winwidget.notification.daily-summary.telegram',
	'subscription-expiry-email':
		'winwidget.notification.subscription-expiry.email',
	'subscription-expiry-telegram':
		'winwidget.notification.subscription-expiry.telegram',
	'wincrm-invitation-email':
		'winwidget.notification.wincrm.invitation.email'
};

export const getManualRetryRoutingKey = (kind: MessagingKind): string =>
	`manual.${kind}`;

export const getDeadLetterRoutingKey = (kind: MessagingKind): string =>
	`${kind}.dead-letter`;

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
