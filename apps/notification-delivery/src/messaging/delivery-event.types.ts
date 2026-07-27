import {
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	OUTBOX_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE
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
	'online-consultant',
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

export type NotificationDeliveryEventPayload =
	| LeadIntegrationEventPayloadV2
	| PaymentSucceededEventPayload
	| LimitReachedEmailEventPayload;
