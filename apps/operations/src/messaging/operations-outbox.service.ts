import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/operations-client';
import { OPERATIONS_EVENTS_EXCHANGE } from './operations-messaging.constants';

export interface EnqueueOperationsOutboxInput {
	eventId: string;
	messageId?: string;
	deduplicationKey?: string;
	eventType: string;
	aggregateType: string;
	aggregateId: string;
	correlationId?: string;
	exchange?: string;
	routingKey: string;
	payload: Prisma.InputJsonObject;
	headers?: Prisma.InputJsonObject;
}

@Injectable()
export class OperationsOutboxService {
	enqueue(
		transaction: Prisma.TransactionClient,
		input: EnqueueOperationsOutboxInput
	) {
		return transaction.outboxEvent.create({
			data: {
				eventId: input.eventId,
				messageId: input.messageId || input.eventId,
				deduplicationKey: input.deduplicationKey,
				eventType: input.eventType,
				aggregateType: input.aggregateType,
				aggregateId: input.aggregateId,
				correlationId: input.correlationId,
				exchange: input.exchange || OPERATIONS_EVENTS_EXCHANGE,
				routingKey: input.routingKey,
				payload: input.payload,
				headers: input.headers || {}
			}
		});
	}
}
