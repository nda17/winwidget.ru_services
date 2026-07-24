export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');

export const OUTBOX_EVENT_TYPE = 'lead.integration.requested.v1';
export const PAYMENT_SUCCEEDED_EVENT_TYPE = 'payment.succeeded.v1';
export const MAILING_DELIVERY_EVENT_TYPE = 'mailing.delivery.requested.v1';
export const LIMIT_REACHED_EVENT_TYPE = 'lead.limit.reached.v1';
export const DAILY_SUMMARY_EVENT_TYPE =
	'report.daily-summary.requested.v1';
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
	'daily-summary-telegram'
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const MAINTENANCE_KINDS = ['database-backup'] as const;

export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MESSAGING_KINDS = [
	...INTEGRATION_KINDS,
	...MAINTENANCE_KINDS
] as const;

export type MessagingKind = (typeof MESSAGING_KINDS)[number];

export const MESSAGING_ROUTING_KEYS: Record<MessagingKind, string> = {
	email: 'lead.integration.email.v1',
	webhook: 'lead.integration.webhook.v1',
	telegram: 'lead.integration.telegram.v1',
	bitrix24: 'lead.integration.bitrix24.v1',
	'amo-crm': 'lead.integration.amo-crm.v1',
	'payment-email': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'payment-telegram': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'mailing-email': 'mailing.delivery.email.v1',
	'mailing-telegram': 'mailing.delivery.telegram.v1',
	'limit-email': LIMIT_REACHED_EVENT_TYPE,
	'limit-telegram': LIMIT_REACHED_EVENT_TYPE,
	'daily-summary-telegram': DAILY_SUMMARY_EVENT_TYPE,
	'database-backup': DATABASE_BACKUP_EVENT_TYPE
};

export const MESSAGING_QUEUE_NAMES: Record<MessagingKind, string> = {
	email: 'winwidget.lead-integration.email',
	webhook: 'winwidget.lead-integration.webhook',
	telegram: 'winwidget.lead-integration.telegram',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm',
	'payment-email': 'winwidget.payment-notification.email',
	'payment-telegram': 'winwidget.payment-notification.telegram',
	'mailing-email': 'winwidget.mailing.email',
	'mailing-telegram': 'winwidget.mailing.telegram',
	'limit-email': 'winwidget.limit-notification.email',
	'limit-telegram': 'winwidget.limit-notification.telegram',
	'daily-summary-telegram': 'winwidget.report.daily-summary.telegram',
	'database-backup': 'winwidget.maintenance.database-backup'
};

export const INTEGRATION_ROUTING_KEYS = MESSAGING_ROUTING_KEYS;
export const INTEGRATION_QUEUE_NAMES = MESSAGING_QUEUE_NAMES;

export const getManualRetryRoutingKey = (kind: MessagingKind): string =>
	`manual.${kind}`;

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
export const OUTBOX_DEFAULT_BATCH_SIZE = 50;
export const OUTBOX_DEFAULT_POLL_INTERVAL_MS = 1000;
export const OUTBOX_LOCK_TIMEOUT_MS = 60_000;
export const OUTBOX_DEFAULT_RETENTION_DAYS = 7;
