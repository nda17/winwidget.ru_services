import { OutboxExchange } from '@prisma/identity-client';

export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';
export const DESTINATION_EVENT =
	'notification.telegram.destination-unavailable.v1';
export const DESTINATION_KIND = 'telegram-destination-unavailable';
export const DESTINATION_QUEUE =
	'winwidget.notification.telegram-destination-unavailable';
export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;

export function exchangeName(exchange: OutboxExchange): string {
	if (exchange === OutboxExchange.RETRY) return RETRY_EXCHANGE;
	if (exchange === OutboxExchange.MANUAL_RETRY)
		return MANUAL_RETRY_EXCHANGE;
	if (exchange === OutboxExchange.DEAD_LETTER) return DEAD_LETTER_EXCHANGE;
	return EVENTS_EXCHANGE;
}

export function retryRoutingKey(attempt: number): string {
	return `${DESTINATION_KIND}.retry.${attempt}`;
}

export const DEAD_ROUTING_KEY = `${DESTINATION_KIND}.dead-letter`;
