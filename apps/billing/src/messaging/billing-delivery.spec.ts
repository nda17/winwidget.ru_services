import {
	DeliveryFailureStatus,
	DeliveryReceiptStatus,
	OutboxStatus
} from '@prisma/billing-client';
import type { ConsumeMessage } from 'amqplib';
import {
	BILLING_DEAD_LETTER_EXCHANGE,
	BILLING_EVENT_TYPES,
	BILLING_RETRY_EXCHANGE
} from './billing-messaging.constants';
import { BillingOutboxPublisherService } from './billing-outbox-publisher.service';
import { BillingWorkerService } from './billing-worker.service';

describe('BillingOutboxPublisherService', () => {
	const event = () => ({
		id: 'outbox-1',
		eventId: '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b',
		messageId: null,
		eventType: BILLING_EVENT_TYPES.paymentChanged,
		aggregateType: 'billing.payment',
		aggregateId: 'payment-1',
		aggregateVersion: 2n,
		sourceSequence: 9n,
		correlationId: null,
		exchange: 'winwidget.events',
		routingKey: BILLING_EVENT_TYPES.paymentChanged,
		payload: {
			schemaVersion: 1,
			eventType: BILLING_EVENT_TYPES.paymentChanged
		},
		deliveryAttempt: 0,
		status: OutboxStatus.PROCESSING,
		attempt: 1,
		availableAt: new Date(),
		leaseToken: 'lease-1',
		leaseUntil: new Date(Date.now() + 30_000),
		publishedAt: null,
		lastError: null,
		createdAt: new Date(),
		updatedAt: new Date()
	});

	const harness = (publish: jest.Mock) => {
		const value = event();
		const prisma = {
			outboxEvent: {
				findFirst: jest.fn().mockResolvedValue(value),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findUniqueOrThrow: jest.fn().mockResolvedValue(value)
			}
		};
		const runtime = {
			outboxPublisherEnabled: true,
			outboxPollIntervalMs: 1000,
			outboxBatchSize: 50
		};
		const service = new BillingOutboxPublisherService(
			prisma as never,
			runtime as never,
			{ publish } as never
		);
		return { service, prisma, value };
	};

	it('marks Outbox PUBLISHED only after the confirmed publication succeeds', async () => {
		const publish = jest.fn().mockResolvedValue(undefined);
		const { service, prisma, value } = harness(publish);

		await expect(service.publishOne()).resolves.toBe(true);

		expect(publish).toHaveBeenCalledWith(
			value.exchange,
			value.routingKey,
			value.payload,
			expect.objectContaining({
				messageId: value.eventId,
				type: value.eventType,
				headers: expect.objectContaining({
					'x-aggregate-version': '2',
					'x-source-sequence': '9'
				})
			})
		);
		expect(prisma.outboxEvent.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: value.id,
				status: OutboxStatus.PROCESSING,
				leaseToken: value.leaseToken
			},
			data: expect.objectContaining({
				status: OutboxStatus.PUBLISHED,
				publishedAt: expect.any(Date)
			})
		});
	});

	it('returns transport failures to PENDING without an irreversible attempt cap', async () => {
		const publish = jest
			.fn()
			.mockRejectedValue(new Error('mandatory publication returned'));
		const { service, prisma, value } = harness(publish);

		await expect(service.publishOne()).resolves.toBe(true);

		expect(prisma.outboxEvent.updateMany).toHaveBeenLastCalledWith({
			where: { id: value.id, leaseToken: value.leaseToken },
			data: expect.objectContaining({
				status: OutboxStatus.PENDING,
				availableAt: expect.any(Date),
				leaseToken: null,
				leaseUntil: null,
				lastError: 'mandatory publication returned'
			})
		});
	});
});

describe('BillingWorkerService retry and DLQ durability', () => {
	const eventId = '4c230515-2e4e-4e8c-a655-cdcfb8c3dc2b';
	const payload = {
		schemaVersion: 1,
		eventType: BILLING_EVENT_TYPES.trialRequested,
		eventId,
		aggregateId: 'user-1',
		aggregateVersion: '1',
		sourceSequence: '1',
		occurredAt: '2026-08-11T00:00:00.000Z',
		tombstone: false,
		state: {
			userId: 'user-1',
			trialDays: 7,
			registeredAt: '2026-08-11T00:00:00.000Z'
		}
	};

	const message = (attempt: number): ConsumeMessage =>
		({
			content: Buffer.from(JSON.stringify(payload)),
			fields: {
				consumerTag: 'consumer-1',
				deliveryTag: 1,
				redelivered: attempt > 0,
				exchange: 'winwidget.events',
				routingKey: BILLING_EVENT_TYPES.trialRequested
			},
			properties: {
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				headers: { 'x-retry-attempt': attempt },
				deliveryMode: 2,
				priority: undefined,
				correlationId: undefined,
				replyTo: undefined,
				expiration: undefined,
				messageId: eventId,
				timestamp: undefined,
				type: BILLING_EVENT_TYPES.trialRequested,
				userId: undefined,
				appId: undefined,
				clusterId: undefined
			}
		}) as ConsumeMessage;

	const makeHarness = () => {
		const transaction = {
			integrationDeliveryReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({ id: 'outbox-retry-1' })
			},
			integrationDeliveryFailure: {
				upsert: jest.fn().mockResolvedValue({ id: 'failure-1' })
			}
		};
		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' })
			},
			$transaction: jest.fn(
				async (callback: (client: unknown) => unknown) =>
					callback(transaction)
			)
		};
		const rabbit = {
			ack: jest.fn(),
			nack: jest.fn()
		};
		const projections = {
			parse: jest.fn().mockReturnValue({
				eventId,
				aggregateId: 'user-1',
				tombstone: false,
				state: payload.state
			})
		};
		const commands = {
			ensureTrial: jest
				.fn()
				.mockRejectedValue(new Error('temporary failure'))
		};
		const service = new BillingWorkerService(
			prisma as never,
			{ workerEnabled: true } as never,
			rabbit as never,
			projections as never,
			{} as never,
			{} as never,
			commands as never,
			{} as never
		);
		return { service, transaction, prisma, rabbit, commands };
	};

	const handle = (
		service: BillingWorkerService,
		value: ConsumeMessage
	): Promise<void> =>
		(
			service as unknown as {
				handle(
					kind: 'trial-request',
					message: ConsumeMessage
				): Promise<void>;
			}
		).handle('trial-request', value);

	it('creates retry Outbox and state changes atomically before ACK', async () => {
		const { service, transaction, rabbit } = makeHarness();

		await handle(service, message(0));

		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: DeliveryReceiptStatus.RETRY_SCHEDULED,
					retryAvailableAt: expect.any(Date)
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				exchange: BILLING_RETRY_EXCHANGE,
				routingKey: 'trial-request.retry.1',
				deliveryAttempt: 1
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: DeliveryFailureStatus.RETRY_PENDING
				})
			})
		);
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
		expect(rabbit.nack).not.toHaveBeenCalled();
	});

	it('moves the exhausted delivery to the independent DLQ through Outbox', async () => {
		const { service, transaction, rabbit } = makeHarness();

		await handle(service, message(3));

		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: DeliveryReceiptStatus.DEAD_LETTERED,
					retryAvailableAt: null
				})
			})
		);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				exchange: BILLING_DEAD_LETTER_EXCHANGE,
				routingKey: 'trial-request.dead-letter',
				deliveryAttempt: 4
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					status: DeliveryFailureStatus.OPEN
				})
			})
		);
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
	});
});
