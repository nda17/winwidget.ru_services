import { createMessagingHeaders } from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import {
	AUTO_RENEWAL_CHARGE_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS
} from '@/messaging/messaging.constants';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export interface AutoRenewalChargeRequestedEventPayload {
	schemaVersion: 1;
	eventType: typeof AUTO_RENEWAL_CHARGE_EVENT_TYPE;
	paymentId: string;
	autoRenewalId: string;
	cycleKey: string;
	scheduledFor: string;
}

export function enqueueAutoRenewalChargeRequestedEvent(
	transaction: Prisma.TransactionClient,
	payload: AutoRenewalChargeRequestedEventPayload
) {
	const eventId = randomUUID();
	assertMessagingEventContract(payload, {
		eventType: AUTO_RENEWAL_CHARGE_EVENT_TYPE,
		routingKey: MESSAGING_ROUTING_KEYS['auto-renewal'],
		messageId: eventId,
		kind: 'auto-renewal'
	});
	return transaction.outboxEvent.create({
		data: {
			id: eventId,
			messageId: eventId,
			eventType: AUTO_RENEWAL_CHARGE_EVENT_TYPE,
			routingKey: MESSAGING_ROUTING_KEYS['auto-renewal'],
			payload: payload as unknown as Prisma.InputJsonValue,
			headers: createMessagingHeaders({ messageId: eventId })
		}
	});
}
