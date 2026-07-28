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

export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';

export const NOTIFICATION_DELIVERY_KINDS = [
	'email',
	'telegram',
	'payment-email',
	'payment-telegram',
	'limit-email',
	'limit-telegram'
] as const;

export type NotificationDeliveryKind =
	(typeof NOTIFICATION_DELIVERY_KINDS)[number];
export type IntegrationKind = NotificationDeliveryKind;
export type MessagingKind = NotificationDeliveryKind;

export const MESSAGING_KINDS = NOTIFICATION_DELIVERY_KINDS;

export const MESSAGING_ROUTING_KEYS: Record<MessagingKind, string> = {
	email: 'lead.integration.email.v2',
	telegram: 'lead.integration.telegram.v2',
	'payment-email': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'payment-telegram': PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'limit-email': LIMIT_REACHED_EMAIL_EVENT_TYPE,
	'limit-telegram': LIMIT_REACHED_TELEGRAM_EVENT_TYPE
};

export const MESSAGING_QUEUE_NAMES: Record<MessagingKind, string> = {
	email: 'winwidget.lead-integration.email',
	telegram: 'winwidget.lead-integration.telegram',
	'payment-email': 'winwidget.payment-notification.email',
	'payment-telegram': 'winwidget.payment-notification.telegram.v2',
	'limit-email': 'winwidget.limit-notification.email',
	'limit-telegram': 'winwidget.limit-notification.telegram'
};

export const getManualRetryRoutingKey = (kind: MessagingKind): string =>
	`manual.${kind}`;

export const getDeadLetterRoutingKey = (kind: MessagingKind): string =>
	`${kind}.dead-letter`;

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
