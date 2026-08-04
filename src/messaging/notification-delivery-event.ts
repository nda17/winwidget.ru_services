import {
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NotificationDeliveryKind,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';

export const OUTCOME_NOTIFICATION_DELIVERY_KINDS = [
	'subscription-expiry-email',
	'subscription-expiry-telegram'
] as const satisfies readonly NotificationDeliveryKind[];

export type OutcomeNotificationDeliveryKind =
	(typeof OUTCOME_NOTIFICATION_DELIVERY_KINDS)[number];

export interface SubscriptionExpiryNotificationReference {
	type: 'subscription-expiry-reminder';
	id: string;
}

export interface NotificationDeliveryReference {
	type: string;
	id: string;
}

interface SubscriptionExpiryNotificationContent {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
}

export interface SubscriptionExpiryEmailNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE;
	reference: SubscriptionExpiryNotificationReference;
	destination: {
		email: string;
	};
	content: SubscriptionExpiryNotificationContent;
}

export interface SubscriptionExpiryTelegramNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	reference: SubscriptionExpiryNotificationReference;
	destination: {
		telegramChatId: string;
	};
	content: SubscriptionExpiryNotificationContent;
}

export type PreparedNotificationDeliveryEventPayload =
	| SubscriptionExpiryEmailNotificationRequestedEventPayload
	| SubscriptionExpiryTelegramNotificationRequestedEventPayload;

export interface NotificationDeliveryOutcomeEventPayload {
	schemaVersion: 1;
	eventType: typeof NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	sourceEventId: string;
	sourceKind: string;
	reference: NotificationDeliveryReference;
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
	occurredAt: string;
}

export function serializeNotificationDeliveryEvent(
	payload:
		| PreparedNotificationDeliveryEventPayload
		| NotificationDeliveryOutcomeEventPayload
): Prisma.InputJsonValue {
	return payload as unknown as Prisma.InputJsonValue;
}
