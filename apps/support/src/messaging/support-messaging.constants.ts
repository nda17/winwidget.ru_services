import { OutboxExchange } from '@prisma/support-client';

export const SUPPORT_EVENTS_EXCHANGE = OutboxExchange.EVENTS;
export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';
export const SUPPORT_WEBHOOK_EVENT =
	'support.telegram.webhook-admitted.v1';
export const SUPPORT_WEBHOOK_ROUTING_KEY = SUPPORT_WEBHOOK_EVENT;
export const SUPPORT_WEBHOOK_CONSUMER = 'support-telegram-webhook';
export const SUPPORT_WEBHOOK_QUEUE =
	'winwidget.support.telegram-webhook.v1';
export const SUPPORT_ADMIN_AUDIT_EVENT = 'admin.audit.event.v1';
export const SUPPORT_ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.support.v1';
export const SUPPORT_RETRY_DELAYS_MS = [
	30_000, 300_000, 1_800_000
] as const;
export const SUPPORT_DEAD_ROUTING_KEY = `${SUPPORT_WEBHOOK_CONSUMER}.dead-letter`;

export function exchangeName(exchange: OutboxExchange): string {
	if (exchange === OutboxExchange.RETRY) return RETRY_EXCHANGE;
	if (exchange === OutboxExchange.MANUAL_RETRY)
		return MANUAL_RETRY_EXCHANGE;
	if (exchange === OutboxExchange.DEAD_LETTER) return DEAD_LETTER_EXCHANGE;
	return EVENTS_EXCHANGE;
}

export function supportRetryRoutingKey(attempt: number): string {
	return `${SUPPORT_WEBHOOK_CONSUMER}.retry.${attempt}`;
}
