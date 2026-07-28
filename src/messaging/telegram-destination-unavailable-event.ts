import { TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE } from '@/messaging/messaging.constants';

export const TELEGRAM_DESTINATION_SOURCE_KINDS = [
	'telegram',
	'limit-telegram',
	'campaign-telegram',
	'subscription-expiry-telegram'
] as const;

export type TelegramDestinationSourceKind =
	(typeof TELEGRAM_DESTINATION_SOURCE_KINDS)[number];

export interface TelegramDestinationUnavailableEventPayload {
	schemaVersion: 1;
	eventType: typeof TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE;
	sourceEventId: string;
	sourceKind: TelegramDestinationSourceKind;
	destination: {
		telegramChatId: string;
	};
	normalizedCode: string;
	occurredAt: string;
}
