export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');

export const OUTBOX_EVENT_TYPE = 'lead.integration.requested.v2';
export const PAYMENT_SUCCEEDED_EVENT_TYPE = 'payment.succeeded.v1';
export const PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'payment.notification.telegram.requested.v1';
export const MAILING_DELIVERY_EVENT_TYPE = 'mailing.delivery.requested.v1';
export const LIMIT_REACHED_EMAIL_EVENT_TYPE =
	'lead.limit.reached.email.v2';
export const LIMIT_REACHED_TELEGRAM_EVENT_TYPE =
	'lead.limit.reached.telegram.v2';
export const DAILY_SUMMARY_EVENT_TYPE =
	'report.daily-summary.requested.v1';
export const TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE =
	'notification.telegram.destination-unavailable.v1';
export const CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.email.requested.v1';
export const CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.telegram.requested.v1';
export const DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.daily-summary.telegram.requested.v1';
export const SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.email.requested.v1';
export const SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.telegram.requested.v1';
export const NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'notification.delivery.outcome.v1';
export const DATABASE_BACKUP_EVENT_TYPE = 'database.backup.requested.v1';
export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';

export const LEAD_INTEGRATION_KINDS = [
	'email',
	'webhook',
	'telegram',
	'bitrix24',
	'amo-crm'
] as const;

export type LeadIntegrationKind = (typeof LEAD_INTEGRATION_KINDS)[number];

export const INTEGRATION_KINDS = [
	...LEAD_INTEGRATION_KINDS,
	'payment-email',
	'payment-telegram',
	'mailing-email',
	'mailing-telegram',
	'limit-email',
	'limit-telegram',
	'daily-summary-telegram',
	'telegram-destination-unavailable',
	'campaign-email',
	'campaign-telegram',
	'daily-summary-delivery-telegram',
	'subscription-expiry-email',
	'subscription-expiry-telegram',
	'notification-delivery-outcome'
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const NOTIFICATION_DELIVERY_KINDS = [
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
] as const satisfies readonly IntegrationKind[];

export type NotificationDeliveryKind =
	(typeof NOTIFICATION_DELIVERY_KINDS)[number];

export type MonolithIntegrationKind = Exclude<
	IntegrationKind,
	NotificationDeliveryKind
>;

export const MONOLITH_INTEGRATION_KINDS = INTEGRATION_KINDS.filter(
	(kind): kind is MonolithIntegrationKind =>
		!NOTIFICATION_DELIVERY_KINDS.includes(kind as NotificationDeliveryKind)
);

export const MAINTENANCE_KINDS = ['database-backup'] as const;

export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MESSAGING_KINDS = [
	...INTEGRATION_KINDS,
	...MAINTENANCE_KINDS
] as const;

export type MessagingKind = (typeof MESSAGING_KINDS)[number];

export const MESSAGING_ROUTING_KEYS: Record<MessagingKind, string> = {
	email: 'lead.integration.email.v2',
	webhook: 'lead.integration.webhook.v2',
	telegram: 'lead.integration.telegram.v2',
	bitrix24: 'lead.integration.bitrix24.v2',
	'amo-crm': 'lead.integration.amo-crm.v2',
	'payment-email': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'payment-telegram': PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'mailing-email': 'mailing.delivery.email.v1',
	'mailing-telegram': 'mailing.delivery.telegram.v1',
	'limit-email': LIMIT_REACHED_EMAIL_EVENT_TYPE,
	'limit-telegram': LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	'daily-summary-telegram': DAILY_SUMMARY_EVENT_TYPE,
	'telegram-destination-unavailable':
		TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
	'campaign-email': CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	'campaign-telegram': CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'daily-summary-delivery-telegram':
		DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-email':
		SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-telegram':
		SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'notification-delivery-outcome':
		NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	'database-backup': DATABASE_BACKUP_EVENT_TYPE
};

export const MESSAGING_QUEUE_NAMES: Record<MessagingKind, string> = {
	email: 'winwidget.lead-integration.email',
	webhook: 'winwidget.lead-integration.webhook',
	telegram: 'winwidget.lead-integration.telegram',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm',
	'payment-email': 'winwidget.payment-notification.email',
	'payment-telegram': 'winwidget.payment-notification.telegram.v2',
	'mailing-email': 'winwidget.mailing.email',
	'mailing-telegram': 'winwidget.mailing.telegram',
	'limit-email': 'winwidget.limit-notification.email',
	'limit-telegram': 'winwidget.limit-notification.telegram',
	'daily-summary-telegram': 'winwidget.report.daily-summary.telegram',
	'telegram-destination-unavailable':
		'winwidget.notification.telegram-destination-unavailable',
	'campaign-email': 'winwidget.notification.campaign.email',
	'campaign-telegram': 'winwidget.notification.campaign.telegram',
	'daily-summary-delivery-telegram':
		'winwidget.notification.daily-summary.telegram',
	'subscription-expiry-email':
		'winwidget.notification.subscription-expiry.email',
	'subscription-expiry-telegram':
		'winwidget.notification.subscription-expiry.telegram',
	'notification-delivery-outcome':
		'winwidget.notification.delivery-outcome',
	'database-backup': 'winwidget.maintenance.database-backup'
};

export const INTEGRATION_ROUTING_KEYS = MESSAGING_ROUTING_KEYS;
export const INTEGRATION_QUEUE_NAMES = MESSAGING_QUEUE_NAMES;

export const getManualRetryRoutingKey = (kind: MessagingKind): string =>
	`manual.${kind}`;

export const getDeadLetterRoutingKey = (kind: MessagingKind): string =>
	`${kind}.dead-letter`;

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
export const OUTBOX_DEFAULT_BATCH_SIZE = 50;
export const OUTBOX_DEFAULT_POLL_INTERVAL_MS = 1000;
export const OUTBOX_LOCK_TIMEOUT_MS = 60_000;
export const OUTBOX_DEFAULT_RETENTION_DAYS = 7;
