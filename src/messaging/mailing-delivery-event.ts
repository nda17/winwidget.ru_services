import { MailingDeliveryChannel, Prisma } from '@prisma/client';

export interface MailingDeliveryEventPayload {
	schemaVersion: 1;
	eventType: 'mailing.delivery.requested.v1';
	campaignId: string;
	deliveryId: string;
	channel: MailingDeliveryChannel;
}

export function getMailingDeliveryRoutingKey(
	channel: MailingDeliveryChannel
): string {
	return channel === MailingDeliveryChannel.EMAIL
		? 'mailing.delivery.email.v1'
		: 'mailing.delivery.telegram.v1';
}

export function serializeMailingDeliveryEvent(
	payload: MailingDeliveryEventPayload
): Prisma.InputJsonValue {
	return payload as unknown as Prisma.InputJsonValue;
}
