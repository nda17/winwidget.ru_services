import { BillingPeriod, Plan, Prisma } from '@prisma/client';

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
	return transaction.outboxEvent.create({
		data: {
			eventType: 'payment.succeeded.v1',
			routingKey: 'payment.succeeded.v1',
			payload: payload as unknown as Prisma.InputJsonValue
		}
	});
}
