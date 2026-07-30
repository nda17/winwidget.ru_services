import { CampaignsWorkerService } from './campaigns-worker.service';
import {
	CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
	CAMPAIGNS_CONSUMERS,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
} from './campaigns-messaging.constants';
import {
	CampaignConsumerReceiptStatus,
	CampaignOutboxExchange,
	Prisma
} from '@prisma/campaigns-client';
import type { CampaignDeliveryOutcomeEvent } from './campaigns-event.contract';
import type { ConsumeMessage } from 'amqplib';

const EVENT_ID = '05a1256d-d21b-4c11-9193-f23f0e3648d9';
const SOURCE_EVENT_ID = '5ed5f057-bb9c-49e6-9b09-d14d622603dd';
const CAMPAIGN_ID = '1df14a11-3ccc-439d-a89d-cb32a555495d';
const DELIVERY_ID = 'fb406e22-bf71-4ad5-bc82-90be5ed74ef3';
const RECEIPT_ID = '7b8b0bad-7b96-4d09-ad2f-072a95245146';
const LOCK_TOKEN = 'f5e4dbbd-82ee-4ba2-ab25-f532d57c540e';
const PAYLOAD_HASH = 'a'.repeat(64);

function outcome(): CampaignDeliveryOutcomeEvent {
	return {
		schemaVersion: 2,
		eventType: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		eventId: EVENT_ID,
		occurredAt: '2026-07-30T12:00:00.000Z',
		correlationId: CAMPAIGN_ID,
		sourceEventId: SOURCE_EVENT_ID,
		sourceKind: 'campaign-email',
		campaignId: CAMPAIGN_ID,
		deliveryId: DELIVERY_ID,
		dispatchGeneration: 1,
		status: 'DELIVERED',
		failure: null
	};
}

function snapshotEvent() {
	return {
		schemaVersion: 1 as const,
		eventType: CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
		eventId: EVENT_ID,
		occurredAt: '2026-07-30T12:00:00.000Z',
		correlationId: CAMPAIGN_ID,
		campaignId: CAMPAIGN_ID
	};
}

function message(
	payload: ReturnType<typeof snapshotEvent>
): ConsumeMessage {
	return {
		content: Buffer.from(JSON.stringify(payload)),
		fields: {
			consumerTag: 'campaigns-test',
			deliveryTag: 1,
			redelivered: true,
			exchange: 'winwidget.events',
			routingKey: payload.eventType
		},
		properties: {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			headers: { 'x-retry-attempt': 3 },
			deliveryMode: 2,
			priority: undefined,
			correlationId: CAMPAIGN_ID,
			replyTo: undefined,
			expiration: undefined,
			messageId: payload.eventId,
			timestamp: Date.now(),
			type: payload.eventType,
			userId: undefined,
			appId: undefined,
			clusterId: undefined
		}
	};
}

function serviceWith(prisma: unknown) {
	return new CampaignsWorkerService(
		{} as never,
		prisma as never,
		{} as never,
		{} as never,
		{ workerEnabled: true } as never,
		{ get: jest.fn() } as never
	);
}

describe('CampaignsWorkerService receipts and durable failure paths', () => {
	it('acknowledges a duplicate receipt that was already delivered', async () => {
		const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
			'duplicate',
			{
				code: 'P2002',
				clientVersion: '5.22.0'
			}
		);
		const prisma = {
			campaignConsumerReceipt: {
				create: jest.fn().mockRejectedValue(uniqueViolation),
				findUnique: jest.fn().mockResolvedValue({
					id: RECEIPT_ID,
					payloadHash: PAYLOAD_HASH,
					status: CampaignConsumerReceiptStatus.DELIVERED,
					leaseExpiresAt: null,
					retryAttempt: null
				}),
				updateMany: jest.fn()
			}
		};
		const service = serviceWith(prisma);

		const claim = await (
			service as unknown as {
				claim: (
					eventId: string,
					consumer: string,
					payloadHash: string,
					retryAttempt: number
				) => Promise<{ state: string }>;
			}
		).claim(EVENT_ID, CAMPAIGNS_CONSUMERS.outcome, PAYLOAD_HASH, 0);

		expect(claim).toEqual({ state: 'done' });
		expect(
			prisma.campaignConsumerReceipt.updateMany
		).not.toHaveBeenCalled();
	});

	it('reclaims a stale PROCESSING receipt only after its lease expires', async () => {
		const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
			'duplicate',
			{
				code: 'P2002',
				clientVersion: '5.22.0'
			}
		);
		const prisma = {
			campaignConsumerReceipt: {
				create: jest.fn().mockRejectedValue(uniqueViolation),
				findUnique: jest.fn().mockResolvedValue({
					id: RECEIPT_ID,
					payloadHash: PAYLOAD_HASH,
					status: CampaignConsumerReceiptStatus.PROCESSING,
					leaseExpiresAt: new Date(Date.now() - 1000),
					retryAttempt: null
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const service = serviceWith(prisma);

		const claim = await (
			service as unknown as {
				claim: (
					eventId: string,
					consumer: string,
					payloadHash: string,
					retryAttempt: number
				) => Promise<{ state: string; lockToken?: string }>;
			}
		).claim(EVENT_ID, CAMPAIGNS_CONSUMERS.outcome, PAYLOAD_HASH, 0);

		expect(claim.state).toBe('claimed');
		expect(claim.lockToken).toEqual(expect.any(String));
		expect(prisma.campaignConsumerReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: RECEIPT_ID,
					payloadHash: PAYLOAD_HASH
				}),
				data: expect.objectContaining({
					status: CampaignConsumerReceiptStatus.PROCESSING,
					retryAttempt: null
				})
			})
		);
	});

	it('schedules a retry Outbox in the same transaction as the receipt transition', async () => {
		const transaction = {
			campaignConsumerReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			campaignOutboxEvent: {
				create: jest.fn().mockResolvedValue(undefined)
			}
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const service = serviceWith(prisma);

		await (
			service as unknown as {
				scheduleRetry: (
					input: {
						kind: 'outcome';
						eventId: string;
						eventType: string;
						payload: CampaignDeliveryOutcomeEvent;
						lockToken: string;
					},
					attempt: number
				) => Promise<void>;
			}
		).scheduleRetry(
			{
				kind: 'outcome',
				eventId: EVENT_ID,
				eventType: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
				payload: outcome(),
				lockToken: LOCK_TOKEN
			},
			2
		);

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(
			transaction.campaignConsumerReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignConsumerReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: 2
				})
			})
		);
		expect(transaction.campaignOutboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: CampaignOutboxExchange.RETRY,
					deduplicationKey: `campaign-consumer:outcome:${EVENT_ID}:retry:2`
				})
			})
		);
	});

	it('commits snapshot failure, receipt and DLQ before acknowledging the message', async () => {
		const order: string[] = [];
		const transaction = {
			campaignConsumerReceipt: {
				updateMany: jest.fn().mockImplementation(() => {
					order.push('receipt');
					return Promise.resolve({ count: 1 });
				})
			},
			campaignOutboxEvent: {
				create: jest.fn().mockImplementation(() => {
					order.push('dlq');
					return Promise.resolve(undefined);
				})
			}
		};
		const prisma = {
			campaignConsumerReceipt: {
				create: jest.fn().mockResolvedValue(undefined),
				updateMany: jest.fn()
			},
			$transaction: jest.fn(
				async (callback: (tx: typeof transaction) => unknown) => {
					const result = await callback(transaction);
					order.push('commit');
					return result;
				}
			)
		};
		const rabbitMq = {
			ack: jest.fn(() => order.push('ack')),
			nack: jest.fn()
		};
		const campaigns = {
			markReceiptDelivered: jest.fn(),
			applyOutcome: jest.fn()
		};
		const audience = {
			captureCampaign: jest
				.fn()
				.mockRejectedValue(new Error('audience export failed')),
			failCampaignInTransaction: jest.fn().mockImplementation(() => {
				order.push('campaign-failed');
				return Promise.resolve();
			})
		};
		const service = new CampaignsWorkerService(
			rabbitMq as never,
			prisma as never,
			campaigns as never,
			audience as never,
			{ workerEnabled: true } as never,
			{ get: jest.fn() } as never
		);
		const input = message(snapshotEvent());

		await (
			service as unknown as {
				handle: (kind: 'snapshot', event: ConsumeMessage) => Promise<void>;
			}
		).handle('snapshot', input);

		expect(audience.failCampaignInTransaction).toHaveBeenCalledWith(
			transaction,
			CAMPAIGN_ID,
			'Audience snapshot could not be completed'
		);
		expect(
			transaction.campaignConsumerReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: CampaignConsumerReceiptStatus.DEAD_LETTERED
				})
			})
		);
		expect(transaction.campaignOutboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					exchange: CampaignOutboxExchange.DEAD_LETTER
				})
			})
		);
		expect(order).toEqual([
			'campaign-failed',
			'receipt',
			'dlq',
			'commit',
			'ack'
		]);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});
});
