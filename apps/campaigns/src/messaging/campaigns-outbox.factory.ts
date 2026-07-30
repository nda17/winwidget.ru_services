import {
	AdminAuditEvent,
	CampaignNotificationRequestedEvent,
	CampaignSnapshotRequestedEvent
} from './campaigns-event.contract';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
	CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE
} from './campaigns-messaging.constants';
import {
	Campaign,
	CampaignDelivery,
	CampaignOutboxExchange,
	Prisma
} from '@prisma/campaigns-client';
import { randomUUID } from 'node:crypto';

export type CampaignsTransaction = Prisma.TransactionClient;

export function createSnapshotOutbox(
	transaction: CampaignsTransaction,
	campaignId: string
) {
	const eventId = randomUUID();
	const payload: CampaignSnapshotRequestedEvent = {
		schemaVersion: 1,
		eventType: CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
		eventId,
		occurredAt: new Date().toISOString(),
		correlationId: campaignId,
		campaignId
	};
	return transaction.campaignOutboxEvent.create({
		data: {
			messageId: eventId,
			deduplicationKey: `campaign-snapshot:${campaignId}`,
			exchange: CampaignOutboxExchange.EVENTS,
			eventType: payload.eventType,
			routingKey: payload.eventType,
			payload: payload as unknown as Prisma.InputJsonObject,
			headers: {
				'x-correlation-id': campaignId,
				'x-causation-id': campaignId
			},
			aggregateType: 'campaign',
			aggregateId: campaignId
		}
	});
}

export function createDeliveryOutbox(
	transaction: CampaignsTransaction,
	campaign: Pick<Campaign, 'id' | 'subject' | 'message'>,
	delivery: Pick<
		CampaignDelivery,
		'id' | 'channel' | 'destination' | 'dispatchGeneration'
	>
) {
	const eventId = randomUUID();
	const data = buildDeliveryOutboxData(campaign, delivery, eventId);
	return Promise.all([
		transaction.campaignDelivery.update({
			where: { id: delivery.id },
			data: { requestEventId: eventId }
		}),
		transaction.campaignOutboxEvent.create({ data })
	]);
}

export function buildDeliveryOutboxData(
	campaign: Pick<Campaign, 'id' | 'subject' | 'message'>,
	delivery: Pick<
		CampaignDelivery,
		'id' | 'channel' | 'destination' | 'dispatchGeneration'
	>,
	eventId: string
): Prisma.CampaignOutboxEventCreateManyInput {
	const eventType =
		delivery.channel === 'EMAIL'
			? CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE
			: CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE;
	const payload: CampaignNotificationRequestedEvent = {
		schemaVersion: 2,
		eventType,
		eventId,
		occurredAt: new Date().toISOString(),
		correlationId: campaign.id,
		campaignId: campaign.id,
		deliveryId: delivery.id,
		dispatchGeneration: delivery.dispatchGeneration,
		reference: {
			type: 'campaign-delivery',
			id: delivery.id,
			aggregateId: campaign.id,
			dispatchGeneration: delivery.dispatchGeneration
		},
		destination:
			delivery.channel === 'EMAIL'
				? { email: delivery.destination }
				: { telegramChatId: delivery.destination },
		content: {
			subject: campaign.subject,
			message: campaign.message
		}
	};
	return {
		messageId: eventId,
		deduplicationKey: `campaign-delivery:${delivery.id}:generation:${delivery.dispatchGeneration}`,
		exchange: CampaignOutboxExchange.EVENTS,
		eventType,
		routingKey: eventType,
		payload: payload as unknown as Prisma.InputJsonObject,
		headers: {
			'x-correlation-id': campaign.id,
			'x-causation-id': campaign.id
		},
		aggregateType: 'campaign-delivery',
		aggregateId: delivery.id,
		generation: delivery.dispatchGeneration
	};
}

export function createAdminAuditOutbox(
	transaction: CampaignsTransaction,
	input: Omit<
		AdminAuditEvent,
		'schemaVersion' | 'eventType' | 'eventId' | 'occurredAt'
	> & { deduplicationKey: string }
) {
	const eventId = randomUUID();
	const payload: AdminAuditEvent = {
		schemaVersion: 1,
		eventType: ADMIN_AUDIT_EVENT_TYPE,
		eventId,
		occurredAt: new Date().toISOString(),
		correlationId: input.correlationId,
		actorId: input.actorId,
		action: input.action,
		target: input.target,
		metadata: input.metadata
	};
	return transaction.campaignOutboxEvent.createMany({
		data: [
			{
				messageId: eventId,
				deduplicationKey: input.deduplicationKey,
				exchange: CampaignOutboxExchange.EVENTS,
				eventType: ADMIN_AUDIT_EVENT_TYPE,
				routingKey: ADMIN_AUDIT_EVENT_TYPE,
				payload: payload as unknown as Prisma.InputJsonObject,
				headers: {
					'x-correlation-id': input.correlationId,
					'x-causation-id': input.correlationId
				},
				aggregateType: 'campaign',
				aggregateId: input.target.campaignId
			}
		],
		skipDuplicates: true
	});
}
