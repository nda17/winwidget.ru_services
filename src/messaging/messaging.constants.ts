export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');

export const OUTBOX_EVENT_TYPE = 'lead.integration.requested.v1';
export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';

export const INTEGRATION_KINDS = [
	'email',
	'webhook',
	'telegram',
	'bitrix24',
	'amo-crm'
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const INTEGRATION_ROUTING_KEYS: Record<IntegrationKind, string> = {
	email: 'lead.integration.email.v1',
	webhook: 'lead.integration.webhook.v1',
	telegram: 'lead.integration.telegram.v1',
	bitrix24: 'lead.integration.bitrix24.v1',
	'amo-crm': 'lead.integration.amo-crm.v1'
};

export const INTEGRATION_QUEUE_NAMES: Record<IntegrationKind, string> = {
	email: 'winwidget.lead-integration.email',
	webhook: 'winwidget.lead-integration.webhook',
	telegram: 'winwidget.lead-integration.telegram',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm'
};

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
export const OUTBOX_MAX_PUBLISH_ATTEMPTS = 20;
export const OUTBOX_DEFAULT_BATCH_SIZE = 50;
export const OUTBOX_DEFAULT_POLL_INTERVAL_MS = 1000;
export const OUTBOX_LOCK_TIMEOUT_MS = 60_000;
export const OUTBOX_DEFAULT_RETENTION_DAYS = 7;
