import {
	CampaignEmailNotificationRequestedEventPayload,
	CampaignTelegramNotificationRequestedEventPayload,
	DailySummaryTelegramNotificationRequestedEventPayload,
	LeadIntegrationEventPayloadV2,
	LimitReachedEmailEventPayload,
	LimitReachedTelegramEventPayload,
	NotificationDeliveryEventPayload,
	NotificationDeliveryOutcomeEventPayload,
	PaymentTelegramNotificationEventPayload,
	PaymentSucceededEventPayload,
	SubscriptionExpiryEmailNotificationRequestedEventPayload,
	SubscriptionExpiryTelegramNotificationRequestedEventPayload
} from '../messaging/delivery-event.types';
import {
	NotificationDeliveryKind,
	NOTIFICATION_DELIVERY_KINDS
} from '../messaging/messaging.constants';
import { assertMessagingEventContract } from '../messaging/messaging-event-contract';
import type { ConsumeMessage } from 'amqplib';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type {
	CampaignEmailNotificationRequestedEventPayload,
	CampaignTelegramNotificationRequestedEventPayload,
	DailySummaryTelegramNotificationRequestedEventPayload,
	LeadIntegrationEventPayloadV2,
	LimitReachedEmailEventPayload,
	LimitReachedTelegramEventPayload,
	NotificationDeliveryEventPayload,
	NotificationDeliveryOutcomeEventPayload,
	PaymentTelegramNotificationEventPayload,
	PaymentSucceededEventPayload,
	SubscriptionExpiryEmailNotificationRequestedEventPayload,
	SubscriptionExpiryTelegramNotificationRequestedEventPayload
};

export interface ParsedNotificationDeliveryMessage {
	eventId: string;
	eventType: string;
	payload: NotificationDeliveryEventPayload;
	retryAttempt: number;
	firstFailedAt: Date;
	deliveryToken: string | null;
}

export function parseNotificationDeliveryMessage(
	kind: NotificationDeliveryKind,
	message: ConsumeMessage
): ParsedNotificationDeliveryMessage {
	if (!NOTIFICATION_DELIVERY_KINDS.includes(kind)) {
		throw new Error(`Unsupported notification delivery kind: ${kind}`);
	}

	const eventId =
		typeof message.properties.messageId === 'string'
			? message.properties.messageId
			: '';
	if (!isUuid(eventId)) {
		throw new Error('RabbitMQ messageId is missing or invalid');
	}

	const eventType =
		typeof message.properties.type === 'string'
			? message.properties.type
			: '';
	const payload = JSON.parse(
		message.content.toString('utf8')
	) as NotificationDeliveryEventPayload;
	assertMessagingEventContract(payload, {
		eventType,
		routingKey: message.fields.routingKey,
		messageId: eventId,
		kind
	});

	return {
		eventId,
		eventType,
		payload,
		retryAttempt: getRetryAttempt(message),
		firstFailedAt: getFirstFailedAt(message),
		deliveryToken: getUuidHeader(message, 'x-delivery-token')
	};
}

export function getScalarMessageHeaders(
	message: ConsumeMessage
): Record<string, string | number | boolean> {
	const headers = message.properties.headers;
	if (!headers) return {};

	return Object.fromEntries(
		Object.entries(headers)
			.map(([key, value]) => [
				key,
				Buffer.isBuffer(value) ? value.toString('utf8') : value
			])
			.filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
	);
}

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

function getRetryAttempt(message: ConsumeMessage): number {
	const value = Number(message.properties.headers?.['x-retry-attempt']);
	return Number.isInteger(value) && value >= 0 && value <= 1_000_000
		? value
		: 0;
}

function getFirstFailedAt(message: ConsumeMessage): Date {
	const value = getStringHeader(message, 'x-first-failed-at');
	const timestamp = value ? Date.parse(value) : Number.NaN;
	const now = Date.now();
	return Number.isFinite(timestamp) && timestamp <= now + 60_000
		? new Date(timestamp)
		: new Date(now);
}

function getUuidHeader(
	message: ConsumeMessage,
	name: string
): string | null {
	const value = getStringHeader(message, name);
	return isUuid(value) ? value : null;
}

function getStringHeader(
	message: ConsumeMessage,
	name: string
): string | null {
	const value = message.properties.headers?.[name];
	if (typeof value === 'string') return value;
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	return null;
}
