import { CampaignsOutboxPublisherService } from './campaigns-outbox-publisher.service';
import {
	CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
	CAMPAIGNS_RETRY_EXCHANGE
} from './campaigns-messaging.constants';
import {
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignOutboxExchange,
	CampaignOutboxStatus,
	CampaignStatus
} from '@prisma/campaigns-client';

const CAMPAIGN_ID = '1df14a11-3ccc-439d-a89d-cb32a555495d';
const DELIVERY_ID = 'fb406e22-bf71-4ad5-bc82-90be5ed74ef3';
const EVENT_ID = '05a1256d-d21b-4c11-9193-f23f0e3648d9';
const OUTBOX_ID = '7b8b0bad-7b96-4d09-ad2f-072a95245146';
const LOCK_TOKEN = 'f5e4dbbd-82ee-4ba2-ab25-f532d57c540e';

function outboxEvent(overrides: Record<string, unknown> = {}) {
	const now = new Date();
	return {
		id: OUTBOX_ID,
		messageId: EVENT_ID,
		deduplicationKey: `campaign-delivery:${DELIVERY_ID}:generation:1`,
		exchange: CampaignOutboxExchange.EVENTS,
		eventType: CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
		routingKey: CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
		payload: {},
		headers: {},
		aggregateType: 'campaign-delivery',
		aggregateId: DELIVERY_ID,
		generation: 1,
		status: CampaignOutboxStatus.PUBLISHING,
		attempts: 0,
		availableAt: now,
		lockedAt: now,
		lockedBy: 'publisher',
		lockToken: LOCK_TOKEN,
		leaseExpiresAt: new Date(now.getTime() + 60_000),
		publishedAt: null,
		lastError: null,
		createdAt: now,
		updatedAt: now,
		...overrides
	};
}

function delivery(
	status: CampaignDeliveryStatus,
	campaignStatus: CampaignStatus
) {
	return {
		id: DELIVERY_ID,
		campaignId: CAMPAIGN_ID,
		channel: CampaignDeliveryChannel.EMAIL,
		status,
		dispatchGeneration: 1,
		requestEventId: EVENT_ID,
		campaign: {
			id: CAMPAIGN_ID,
			status: campaignStatus,
			startedAt: null,
			sentCount: 0
		}
	};
}

describe('CampaignsOutboxPublisherService dispatch races', () => {
	it('defers a delivery Outbox while its campaign is still SNAPSHOTTING', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignDelivery: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce({ campaignId: CAMPAIGN_ID })
					.mockResolvedValueOnce(
						delivery(
							CampaignDeliveryStatus.PENDING,
							CampaignStatus.SNAPSHOTTING
						)
					),
				update: jest.fn()
			},
			campaignOutboxEvent: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaign: {
				update: jest.fn(),
				updateMany: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const rabbitMq = { publish: jest.fn() };
		const service = new CampaignsOutboxPublisherService(
			prisma as never,
			rabbitMq as never,
			{ publisherEnabled: true } as never,
			{ get: jest.fn() } as never
		);

		const prepared = await (
			service as unknown as {
				prepareDispatch: (
					event: ReturnType<typeof outboxEvent>
				) => Promise<boolean>;
			}
		).prepareDispatch(outboxEvent());

		expect(prepared).toBe(false);
		expect(transaction.campaignDelivery.update).not.toHaveBeenCalled();
		expect(
			transaction.campaignOutboxEvent.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignOutboxStatus.PENDING,
					lockToken: null
				})
			})
		);
		expect(rabbitMq.publish).not.toHaveBeenCalled();
	});

	it('cancels a pending delivery atomically when cancellation wins the dispatch race', async () => {
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			campaignDelivery: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce({ campaignId: CAMPAIGN_ID })
					.mockResolvedValueOnce(
						delivery(
							CampaignDeliveryStatus.PENDING,
							CampaignStatus.CANCEL_REQUESTED
						)
					),
				update: jest.fn().mockResolvedValue(undefined),
				count: jest.fn().mockResolvedValue(0)
			},
			campaignOutboxEvent: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaign: {
				update: jest.fn().mockResolvedValue(undefined),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const rabbitMq = { publish: jest.fn() };
		const service = new CampaignsOutboxPublisherService(
			prisma as never,
			rabbitMq as never,
			{ publisherEnabled: true } as never,
			{ get: jest.fn() } as never
		);

		const prepared = await (
			service as unknown as {
				prepareDispatch: (
					event: ReturnType<typeof outboxEvent>
				) => Promise<boolean>;
			}
		).prepareDispatch(outboxEvent());

		expect(prepared).toBe(false);
		expect(transaction.campaignDelivery.update).toHaveBeenCalledWith({
			where: { id: DELIVERY_ID },
			data: expect.objectContaining({
				status: CampaignDeliveryStatus.CANCELLED
			})
		});
		expect(transaction.campaign.update).toHaveBeenCalledWith({
			where: { id: CAMPAIGN_ID },
			data: { cancelledCount: { increment: 1 } }
		});
		expect(
			transaction.campaignOutboxEvent.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignOutboxStatus.CANCELLED,
					lastError: 'CAMPAIGN_CANCEL_REQUESTED'
				})
			})
		);
		expect(transaction.campaign.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignStatus.CANCELLED
				})
			})
		);
		expect(rabbitMq.publish).not.toHaveBeenCalled();
	});

	it('keeps a publish failure retryable without a terminal attempt cutoff', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			campaignOutboxEvent: { updateMany }
		};
		const rabbitMq = {
			publish: jest
				.fn()
				.mockRejectedValue(
					new Error('RabbitMQ returned mandatory publication')
				)
		};
		const service = new CampaignsOutboxPublisherService(
			prisma as never,
			rabbitMq as never,
			{ publisherEnabled: true } as never,
			{ get: jest.fn() } as never
		);
		const event = outboxEvent({
			exchange: CampaignOutboxExchange.RETRY,
			eventType: 'campaigns.retry-test.v1',
			routingKey: 'snapshot.retry.1',
			aggregateType: null,
			aggregateId: null,
			generation: null,
			attempts: 999
		});

		await (
			service as unknown as {
				publish: (input: ReturnType<typeof outboxEvent>) => Promise<void>;
			}
		).publish(event);

		expect(rabbitMq.publish).toHaveBeenCalledWith(
			CAMPAIGNS_RETRY_EXCHANGE,
			'snapshot.retry.1',
			event.payload,
			expect.any(Object)
		);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignOutboxStatus.PENDING,
					attempts: 1000,
					lastError: 'RabbitMQ returned mandatory publication'
				})
			})
		);
		expect(updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignOutboxStatus.PUBLISHED
				})
			})
		);
	});
});
