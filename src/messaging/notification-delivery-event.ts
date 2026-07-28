import {
	CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NotificationDeliveryKind,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';

export const OUTCOME_NOTIFICATION_DELIVERY_KINDS = [
	'campaign-email',
	'campaign-telegram',
	'daily-summary-delivery-telegram',
	'subscription-expiry-email',
	'subscription-expiry-telegram'
] as const satisfies readonly NotificationDeliveryKind[];

export type OutcomeNotificationDeliveryKind =
	(typeof OUTCOME_NOTIFICATION_DELIVERY_KINDS)[number];

export type NotificationDeliveryReference =
	| {
			type: 'mailing-delivery';
			id: string;
			aggregateId: string;
	  }
	| {
			type: 'daily-summary-job';
			id: string;
	  }
	| {
			type: 'subscription-expiry-reminder';
			id: string;
	  };

interface CampaignNotificationContent {
	subject: string;
	message: string;
}

interface SubscriptionExpiryNotificationContent {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
}

export interface CampaignEmailNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'mailing-delivery' }
	>;
	destination: {
		email: string;
	};
	content: CampaignNotificationContent;
}

export interface CampaignTelegramNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'mailing-delivery' }
	>;
	destination: {
		telegramChatId: string;
	};
	content: CampaignNotificationContent;
}

export interface DailySummaryTelegramNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'daily-summary-job' }
	>;
	destination: {
		telegramChatId: string;
		messageThreadId: number;
	};
	content: {
		text: string;
	};
}

export interface SubscriptionExpiryEmailNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'subscription-expiry-reminder' }
	>;
	destination: {
		email: string;
	};
	content: SubscriptionExpiryNotificationContent;
}

export interface SubscriptionExpiryTelegramNotificationRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'subscription-expiry-reminder' }
	>;
	destination: {
		telegramChatId: string;
	};
	content: SubscriptionExpiryNotificationContent;
}

export type PreparedNotificationDeliveryEventPayload =
	| CampaignEmailNotificationRequestedEventPayload
	| CampaignTelegramNotificationRequestedEventPayload
	| DailySummaryTelegramNotificationRequestedEventPayload
	| SubscriptionExpiryEmailNotificationRequestedEventPayload
	| SubscriptionExpiryTelegramNotificationRequestedEventPayload;

export interface NotificationDeliveryOutcomeEventPayload {
	schemaVersion: 1;
	eventType: typeof NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	sourceEventId: string;
	sourceKind: OutcomeNotificationDeliveryKind;
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
