import { Prisma } from '@prisma/client';

export interface LimitReachedEventPayload {
	schemaVersion: 1;
	eventType: 'lead.limit.reached.v1';
	entity: {
		id: string;
		name: string;
		type: string;
	};
	limit: number;
	destinations: {
		emails: string[];
		telegramChatId: string | null;
	};
}

export function enqueueLimitReachedEvent(
	transaction: Prisma.TransactionClient,
	payload: LimitReachedEventPayload
) {
	return transaction.outboxEvent.create({
		data: {
			eventType: 'lead.limit.reached.v1',
			routingKey: 'lead.limit.reached.v1',
			payload: payload as unknown as Prisma.InputJsonValue
		}
	});
}

export function enqueueEntityLimitReachedEvent(
	transaction: Prisma.TransactionClient,
	input: {
		entity: LimitReachedEventPayload['entity'];
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
	return enqueueLimitReachedEvent(transaction, {
		schemaVersion: 1,
		eventType: 'lead.limit.reached.v1',
		entity: input.entity,
		limit: input.limit,
		destinations: {
			emails,
			telegramChatId: input.telegramChatId?.trim() || null
		}
	});
}
