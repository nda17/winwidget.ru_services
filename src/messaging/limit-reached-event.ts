import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

interface LimitReachedEventBase {
	schemaVersion: 2;
	entity: {
		id: string;
		name: string;
		type: string;
	};
	limit: number;
}

export interface LimitReachedEmailEventPayload extends LimitReachedEventBase {
	eventType: typeof LIMIT_REACHED_EMAIL_EVENT_TYPE;
	destination: {
		email: string;
	};
}

export interface LimitReachedTelegramEventPayload extends LimitReachedEventBase {
	eventType: typeof LIMIT_REACHED_TELEGRAM_EVENT_TYPE;
	destination: {
		telegramChatId: string;
	};
}

export type LimitReachedEventPayload =
	| LimitReachedEmailEventPayload
	| LimitReachedTelegramEventPayload;

export function enqueueEntityLimitReachedEvent(
	transaction: Prisma.TransactionClient,
	input: {
		entity: LimitReachedEventBase['entity'];
		limit: number;
		accountEmail?: string | null;
		integrationEmail?: string | null;
		telegramChatId?: string | null;
	}
) {
	const emails = Array.from(
		new Set(
			[input.accountEmail, input.integrationEmail]
				.map(value => value?.trim().toLowerCase())
				.filter((value): value is string => Boolean(value))
		)
	);
	const telegramChatId = input.telegramChatId?.trim() || null;
	const events: Prisma.OutboxEventCreateManyInput[] = emails.map(email => {
		const eventId = randomUUID();
		const payload: LimitReachedEmailEventPayload = {
			schemaVersion: 2,
			eventType: LIMIT_REACHED_EMAIL_EVENT_TYPE,
			entity: input.entity,
			limit: input.limit,
			destination: { email }
		};
		return {
			id: eventId,
			messageId: eventId,
			eventType: payload.eventType,
			routingKey: MESSAGING_ROUTING_KEYS['limit-email'],
			payload: payload as unknown as Prisma.InputJsonValue,
			headers: createMessagingHeaders({ messageId: eventId })
		};
	});

	if (telegramChatId) {
		const eventId = randomUUID();
		const payload: LimitReachedTelegramEventPayload = {
			schemaVersion: 2,
			eventType: LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
			entity: input.entity,
			limit: input.limit,
			destination: { telegramChatId }
		};
		events.push({
			id: eventId,
			messageId: eventId,
			eventType: payload.eventType,
			routingKey: MESSAGING_ROUTING_KEYS['limit-telegram'],
			payload: payload as unknown as Prisma.InputJsonValue,
			headers: createMessagingHeaders({ messageId: eventId })
		});
	}

	if (!events.length) {
		return Promise.resolve({ count: 0 });
	}
	return transaction.outboxEvent.createMany({ data: events });
}
