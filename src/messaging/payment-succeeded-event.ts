import { createMessagingHeaders } from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { BillingPeriod, Plan, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export interface PaymentSucceededEventPayload {
	schemaVersion: 1;
	eventType: 'payment.succeeded.v1';
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

export function enqueuePaymentSucceededEvent(
	transaction: Prisma.TransactionClient,
	payload: PaymentSucceededEventPayload
) {
	const eventId = randomUUID();
	assertMessagingEventContract(payload, {
		eventType: 'payment.succeeded.v1',
		routingKey: 'payment.succeeded.v1',
		messageId: eventId
	});
	return transaction.outboxEvent.create({
		data: {
			id: eventId,
			messageId: eventId,
			eventType: 'payment.succeeded.v1',
			routingKey: 'payment.succeeded.v1',
			payload: payload as unknown as Prisma.InputJsonValue,
			headers: createMessagingHeaders({ messageId: eventId })
		}
	});
}
