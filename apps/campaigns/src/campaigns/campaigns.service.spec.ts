import { CampaignsService } from './campaigns.service';
import {
	CampaignAudience,
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignRequestedChannel,
	CampaignStatus
} from '@prisma/campaigns-client';
import type { CampaignDeliveryOutcomeEvent } from '../messaging/campaigns-event.contract';

const CAMPAIGN_ID = '06a99a6b-c539-4d76-9e9d-48935037b2b6';
const DELIVERY_ID = '4ebbc217-8f61-463a-b7f9-baf05033df03';
const REQUEST_EVENT_ID = '9ab64a22-4b8d-4f96-b9e8-7b52d92e7b37';
const OUTCOME_EVENT_ID = '451b464e-2a16-4bca-a750-9f683b227ed2';

function outcome(
	overrides: Partial<CampaignDeliveryOutcomeEvent> = {}
): CampaignDeliveryOutcomeEvent {
	return {
		schemaVersion: 2,
		eventType: 'notification.delivery.outcome.v2',
		eventId: OUTCOME_EVENT_ID,
		occurredAt: '2026-07-30T12:00:00.000Z',
		correlationId: CAMPAIGN_ID,
		sourceEventId: REQUEST_EVENT_ID,
		sourceKind: 'campaign-email',
		campaignId: CAMPAIGN_ID,
		deliveryId: DELIVERY_ID,
		dispatchGeneration: 2,
		status: 'DELIVERED',
		failure: null,
		...overrides
	};
}

function delivery() {
	return {
		id: DELIVERY_ID,
		campaignId: CAMPAIGN_ID,
		snapshotId: '75a18771-7bf8-4242-b6f9-51e7b50f538b',
		channel: CampaignDeliveryChannel.EMAIL,
		destination: 'user@example.com',
		destinationKey: 'a'.repeat(64),
		status: CampaignDeliveryStatus.PROCESSING,
		dispatchGeneration: 2,
		attempts: 2,
		requestEventId: REQUEST_EVENT_ID,
		lastOutcomeEventId: null,
		lastErrorCode: null,
		lastErrorReason: null,
		sentAt: null,
		cancelledAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		campaign: {
			id: CAMPAIGN_ID,
			actorId: 'admin',
			idempotencyKey: '0cc02b77-5145-4485-b55e-1e6063746fe1',
			subject: 'Campaign subject',
			message: 'Campaign message',
			audience: CampaignAudience.ALL,
			requestedChannel: CampaignRequestedChannel.EMAIL,
			status: CampaignStatus.RUNNING,
			recipientCount: 1,
			sentCount: 0,
			failedCount: 0,
			cancelledCount: 0,
			emailCount: 1,
			telegramCount: 0,
			startedAt: new Date(),
			completedAt: null,
			cancelRequestedAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		}
	};
}

describe('CampaignsService state machine', () => {
	it('creates the campaign, idempotency record and audit Outbox atomically', async () => {
		const idempotencyKey = '0cc02b77-5145-4485-b55e-1e6063746fe1';
		const createdCampaign = {
			...delivery().campaign,
			status: CampaignStatus.SNAPSHOTTING,
			idempotencyKey,
			snapshots: []
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignIdempotencyRecord: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(undefined)
			},
			campaign: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(createdCampaign)
			},
			audienceSnapshot: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaignOutboxEvent: {
				create: jest.fn().mockResolvedValue(undefined),
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			),
			campaign: {
				findUnique: jest.fn().mockResolvedValue(createdCampaign)
			}
		};
		const service = new CampaignsService(prisma as never);

		await service.create('admin', idempotencyKey, {
			subject: ' Campaign subject ',
			message: ' Campaign message ',
			audience: CampaignAudience.ALL,
			channel: CampaignRequestedChannel.EMAIL
		});

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' })
		);
		expect(
			transaction.campaignIdempotencyRecord.create
		).toHaveBeenCalled();
		expect(transaction.campaignOutboxEvent.create).toHaveBeenCalled();
		expect(
			transaction.campaignOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					deduplicationKey: `campaign-audit:create:${CAMPAIGN_ID}`,
					eventType: 'admin.audit.event.v1',
					payload: expect.objectContaining({
						action: 'CAMPAIGN_CREATE',
						target: { campaignId: CAMPAIGN_ID },
						metadata: {
							channel: 'EMAIL',
							audience: 'ALL'
						}
					})
				})
			],
			skipDuplicates: true
		});
	});

	it('acknowledges a stale generation without changing delivery counters', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignDelivery: {
				findUnique: jest.fn().mockResolvedValue(delivery()),
				update: jest.fn(),
				count: jest.fn()
			},
			campaign: {
				update: jest.fn(),
				findUnique: jest.fn()
			},
			campaignConsumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new CampaignsService(prisma as never);

		await service.applyOutcome(outcome({ dispatchGeneration: 1 }), {
			eventId: OUTCOME_EVENT_ID,
			consumer: 'campaigns-outcome-v2',
			lockToken: '317f6d5c-d41c-4c27-a76a-7ac0113ce6c4'
		});

		expect(transaction.campaignDelivery.update).not.toHaveBeenCalled();
		expect(transaction.campaign.update).not.toHaveBeenCalled();
		expect(
			transaction.campaignConsumerReceipt.updateMany
		).toHaveBeenCalled();
	});

	it('moves a fully delivered campaign to COMPLETED', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignDelivery: {
				findUnique: jest.fn().mockResolvedValue(delivery()),
				update: jest.fn().mockResolvedValue(undefined),
				count: jest.fn().mockResolvedValue(0)
			},
			campaign: {
				update: jest.fn().mockResolvedValue(undefined),
				findUnique: jest.fn().mockResolvedValue({
					...delivery().campaign,
					sentCount: 1
				})
			},
			campaignConsumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = new CampaignsService(prisma as never);

		await service.applyOutcome(outcome(), {
			eventId: OUTCOME_EVENT_ID,
			consumer: 'campaigns-outcome-v2',
			lockToken: '317f6d5c-d41c-4c27-a76a-7ac0113ce6c4'
		});

		expect(transaction.campaignDelivery.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignDeliveryStatus.SENT
				})
			})
		);
		expect(transaction.campaign.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignStatus.COMPLETED
				})
			})
		);
	});

	it('keeps cancellation pending while an in-flight delivery remains', async () => {
		const campaign = delivery().campaign;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignDelivery: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				count: jest.fn().mockResolvedValue(1)
			},
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					...campaign,
					status: CampaignStatus.QUEUED,
					recipientCount: 2
				}),
				update: jest.fn().mockResolvedValue(undefined)
			},
			audienceSnapshot: {
				updateMany: jest.fn()
			},
			campaignControlAction: {
				create: jest.fn().mockResolvedValue(undefined)
			},
			campaignOutboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			),
			campaign: {
				findUnique: jest.fn().mockResolvedValue({
					...campaign,
					status: CampaignStatus.CANCEL_REQUESTED,
					recipientCount: 2,
					cancelledCount: 1,
					snapshots: []
				})
			}
		};
		const service = new CampaignsService(prisma as never);

		await service.cancel(CAMPAIGN_ID, 'admin');

		expect(transaction.campaign.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignStatus.CANCEL_REQUESTED,
					completedAt: null,
					cancelledCount: { increment: 1 }
				})
			})
		);
	});
});
