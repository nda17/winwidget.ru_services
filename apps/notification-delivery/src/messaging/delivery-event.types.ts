import {
	CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	OUTBOX_EVENT_TYPE,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE,
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
} from './messaging.constants';

export const PLAN_VALUES = ['TRIAL', 'EASY', 'HARD'] as const;
export type Plan = (typeof PLAN_VALUES)[number];

export const BILLING_PERIOD_VALUES = ['MONTHLY', 'YEARLY'] as const;
export type BillingPeriod = (typeof BILLING_PERIOD_VALUES)[number];

export const LEAD_SOURCES = [
	'widget',
	'quiz',
	'callback',
	'countdown-timer',
	'stop-offer',
	'calculator'
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export interface LeadIntegrationEventPayloadV2 {
	schemaVersion: 2;
	eventType: typeof OUTBOX_EVENT_TYPE;
	integration: 'email' | 'telegram';
	source: LeadSource;
	entity: {
		id: string;
		name: string;
	};
	lead: {
		id: string;
		contact?: string | null;
		name?: string | null;
		phone?: string | null;
		email?: string | null;
		bonus?: string | null;
		result?: string | null;
		timeSlot?: string | null;
		timezone?: string | null;
		actionLabel?: string | null;
		actionValue?: string | null;
		calculatedPrice?: string | null;
		currency?: string | null;
		answers?: unknown;
		url?: string | null;
		createdAt: string;
	};
	destination: { email: string } | { telegramChatId: string };
}

export type ResolvedLeadIntegrationEventPayload =
	LeadIntegrationEventPayloadV2;

export interface PaymentSucceededEventPayload {
	schemaVersion: 1;
	eventType: typeof PAYMENT_SUCCEEDED_EVENT_TYPE;
	payment: {
		id: string;
		yookassaId: string;
		amount: string;
		plan: Plan;
		billingPeriod: BillingPeriod;
		succeededAt: string;
	};
	user: {
		id: string;
		name: string | null;
		email: string | null;
		phone: string | null;
	};
	subscription: {
		expiresAt: string | null;
	};
}

export interface PaymentTelegramNotificationEventPayload {
	schemaVersion: 1;
	eventType: typeof PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	payment: {
		id: string;
		yookassaId: string;
		amount: string;
		plan: Plan;
		billingPeriod: BillingPeriod;
		succeededAt: string;
	};
	user: {
		id: string;
		name: string | null;
		email: string | null;
		phone: string | null;
	};
	destination: {
		telegramChatId: string | null;
		messageThreadId: number | null;
	};
}

export interface LimitReachedEmailEventPayload {
	schemaVersion: 2;
	eventType: typeof LIMIT_REACHED_EMAIL_EVENT_TYPE;
	entity: {
		id: string;
		name: string;
		type: string;
	};
	limit: number;
	destination: {
		email: string;
	};
}

export interface LimitReachedTelegramEventPayload {
	schemaVersion: 2;
	eventType: typeof LIMIT_REACHED_TELEGRAM_EVENT_TYPE;
	entity: {
		id: string;
		name: string;
		type: string;
	};
	limit: number;
	destination: {
		telegramChatId: string;
	};
}

export interface TelegramDestinationUnavailableEventPayload {
	schemaVersion: 1;
	eventType: typeof TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE;
	sourceEventId: string;
	sourceKind:
		| 'telegram'
		| 'limit-telegram'
		| 'campaign-telegram'
		| 'subscription-expiry-telegram';
	destination: {
		telegramChatId: string;
	};
	normalizedCode: string;
	occurredAt: string;
}

export type NotificationDeliveryReference =
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

export interface CampaignDeliveryReference {
	type: 'campaign-delivery';
	id: string;
	aggregateId: string;
	dispatchGeneration: number;
}

interface SubscriptionExpiryNotificationContent {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
}

export interface CampaignEmailNotificationRequestedEventPayload {
	schemaVersion: 2;
	eventType: typeof CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	campaignId: string;
	deliveryId: string;
	dispatchGeneration: number;
	reference: CampaignDeliveryReference;
	destination: {
		email: string;
	};
	content: CampaignNotificationContent;
}

export interface CampaignTelegramNotificationRequestedEventPayload {
	schemaVersion: 2;
	eventType: typeof CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	campaignId: string;
	deliveryId: string;
	dispatchGeneration: number;
	reference: CampaignDeliveryReference;
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

export type OutcomeNotificationDeliveryKind =
	| 'subscription-expiry-email'
	| 'subscription-expiry-telegram';

export interface NotificationDeliveryOutcomeEventPayload {
	schemaVersion: 1;
	eventType: typeof NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	sourceEventId: string;
	sourceKind: OutcomeNotificationDeliveryKind;
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'subscription-expiry-reminder' }
	>;
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
	occurredAt: string;
}

export interface ReportingNotificationDeliveryOutcomeEventPayload {
	schemaVersion: 1;
	eventType: typeof REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	sourceEventId: string;
	sourceKind: 'daily-summary-delivery-telegram';
	reference: Extract<
		NotificationDeliveryReference,
		{ type: 'daily-summary-job' }
	>;
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
	occurredAt: string;
}

export interface CampaignNotificationDeliveryOutcomeEventPayload {
	schemaVersion: 2;
	eventType: typeof CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	sourceEventId: string;
	sourceKind: 'campaign-email' | 'campaign-telegram';
	campaignId: string;
	deliveryId: string;
	dispatchGeneration: number;
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
}

export type NotificationDeliveryEventPayload =
	| LeadIntegrationEventPayloadV2
	| PaymentSucceededEventPayload
	| PaymentTelegramNotificationEventPayload
	| LimitReachedEmailEventPayload
	| LimitReachedTelegramEventPayload
	| CampaignEmailNotificationRequestedEventPayload
	| CampaignTelegramNotificationRequestedEventPayload
	| DailySummaryTelegramNotificationRequestedEventPayload
	| SubscriptionExpiryEmailNotificationRequestedEventPayload
	| SubscriptionExpiryTelegramNotificationRequestedEventPayload
	| TelegramDestinationUnavailableEventPayload;
