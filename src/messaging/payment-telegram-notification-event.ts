import { createMessagingHeaders } from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import {
	MESSAGING_ROUTING_KEYS,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { BillingPeriod, Plan, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

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

export function enqueuePaymentTelegramNotificationEvent(
	transaction: Prisma.TransactionClient,
	payload: PaymentTelegramNotificationEventPayload
) {
	const eventId = randomUUID();
	assertMessagingEventContract(payload, {
		eventType: PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
		routingKey: MESSAGING_ROUTING_KEYS['payment-telegram'],
		messageId: eventId,
		kind: 'payment-telegram'
	});
	return transaction.outboxEvent.create({
		data: {
			id: eventId,
			messageId: eventId,
			eventType: PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
			routingKey: MESSAGING_ROUTING_KEYS['payment-telegram'],
			payload: payload as unknown as Prisma.InputJsonValue,
			headers: createMessagingHeaders({ messageId: eventId })
		}
	});
}
