import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { INTEGRATION_KINDS } from '@/messaging/messaging.constants';
import type { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import type { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { PrismaService } from '@/prisma.service';
import {
	ScheduledJobDispatchHandledError,
	ScheduledJobDispatchRejectedError
} from '@/reports/daily-summary-delivery.service';
import type { ScheduledJobRunView } from '@/scheduled-jobs/scheduled-jobs.types';
import type { ConfigService } from '@nestjs/config';
import { IntegrationDeliveryReceiptStatus, Prisma } from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';

describe('IntegrationWorkerService', () => {
	const uniqueConstraintError = () =>
		new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
			code: 'P2002',
			clientVersion: '5.22.0'
		});

	const createService = (
		values: Record<string, string | undefined> = {}
	) => {
		const rabbitMq = {
			consume: jest.fn().mockResolvedValue(undefined),
			consumeDeadLetter: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			nack: jest.fn(),
			publishRetry: jest.fn().mockResolvedValue(undefined),
			publishDeadLetter: jest.fn().mockResolvedValue(undefined),
			cancelConsumers: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const delivery = {
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as IntegrationDeliveryService;
		const configService = {
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService;
		const heartbeat = {
			markSuccessfulConsume: jest.fn()
		} as unknown as MessagingHeartbeatService;
		const failureUpsert = jest.fn().mockResolvedValue({});
		const receiptUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
		const receiptDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
		const failureUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
		const snapshotDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
		const outboxCreate = jest.fn().mockResolvedValue({ id: 'outbox-1' });
		const outboxCreateMany = jest.fn().mockResolvedValue({ count: 1 });
		const transaction = {
			$queryRaw: jest.fn().mockImplementation(statement => {
				const sql = statement.strings.join('?');
				return sql.includes('integration_delivery_failures')
					? []
					: [
							{
								jobType: 'DAILY_TELEGRAM_SUMMARY',
								status: 'FAILED',
								attempts: 4
							}
						];
			}),
			integrationDeliveryFailure: {
				upsert: failureUpsert,
				updateMany: failureUpdateMany
			},
			integrationDeliveryReceipt: {
				updateMany: receiptUpdateMany,
				deleteMany: receiptDeleteMany
			},
			integrationCredentialSnapshot: {
				deleteMany: snapshotDeleteMany
			},
			outboxEvent: {
				create: outboxCreate,
				createMany: outboxCreateMany
			}
		};

		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
				updateMany: receiptUpdateMany,
				deleteMany: receiptDeleteMany
			},
			integrationDeliveryFailure: {
				updateMany: failureUpdateMany,
				upsert: failureUpsert
			},
			integrationCredentialSnapshot: {
				deleteMany: snapshotDeleteMany
			},
			outboxEvent: {
				create: outboxCreate
			},
			scheduledJobRun: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			mailingDelivery: {
				findUnique: jest.fn()
			},
			$queryRaw: jest.fn().mockResolvedValue([{ waitMs: 0 }]),
			$executeRaw: jest.fn().mockResolvedValue(0),
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;

		return {
			service: new IntegrationWorkerService(
				rabbitMq,
				delivery,
				configService,
				prisma,
				heartbeat
			),
			rabbitMq,
			delivery,
			prisma,
			transaction
		};
	};

	const createMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-23T12:00:00.000Z'
					},
					destination: {
						credentialRef: '22222222-2222-4222-8222-222222222222'
					}
				})
			),
			fields: {
				routingKey: 'lead.integration.webhook.v2'
			},
			properties: {
				messageId: '11111111-1111-4111-8111-111111111111',
				type: 'lead.integration.requested.v2',
				headers: {}
			}
		}) as ConsumeMessage;

	const createDailySummaryMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					eventType: 'report.daily-summary.requested.v1',
					jobId: '11111111-1111-4111-8111-111111111111',
					jobType: 'DAILY_TELEGRAM_SUMMARY',
					scheduleKey: 'daily:2026-07-23',
					periodStart: '2026-07-22T21:00:00.000Z',
					periodEnd: '2026-07-23T21:00:00.000Z'
				})
			),
			fields: {
				routingKey: 'report.daily-summary.requested.v1'
			},
			properties: {
				messageId: '11111111-1111-4111-8111-111111111111',
				type: 'report.daily-summary.requested.v1',
				headers: {}
			}
		}) as ConsumeMessage;

	it('starts consumers for every integration by default', async () => {
		const { service, rabbitMq } = createService();

		await service.onModuleInit();

		expect(rabbitMq.consume).toHaveBeenCalledTimes(
			INTEGRATION_KINDS.length
		);
		expect(rabbitMq.consumeDeadLetter).toHaveBeenCalledTimes(
			INTEGRATION_KINDS.length
		);
		expect(
			(rabbitMq.consume as jest.Mock).mock.calls.map(call => call[0])
		).toEqual(INTEGRATION_KINDS);
	});

	it('can restrict consumers without changing the worker image', async () => {
		const { service, rabbitMq } = createService({
			INTEGRATION_WORKER_KINDS: 'email, telegram',
			RABBITMQ_WORKER_PREFETCH: '4'
		});

		await service.onModuleInit();

		expect(rabbitMq.consume).toHaveBeenCalledTimes(2);
		expect(rabbitMq.consume).toHaveBeenNthCalledWith(
			1,
			'email',
			expect.any(Function),
			4
		);
		expect(rabbitMq.consume).toHaveBeenNthCalledWith(
			2,
			'telegram',
			expect.any(Function),
			4
		);
	});

	it('rejects unknown integration names', async () => {
		const { service } = createService({
			INTEGRATION_WORKER_KINDS: 'email,unknown'
		});

		await expect(service.onModuleInit()).rejects.toThrow(
			'Invalid INTEGRATION_WORKER_KINDS values: unknown'
		);
	});

	it('waits for active handlers before shutdown', async () => {
		const { service, rabbitMq } = createService();
		let resolveHandler!: () => void;
		const handler = (service as any).trackHandler(
			() =>
				new Promise<void>(resolve => {
					resolveHandler = resolve;
				})
		);
		let shutdownFinished = false;
		const shutdown = service.beforeApplicationShutdown().then(() => {
			shutdownFinished = true;
		});

		await Promise.resolve();
		expect(shutdownFinished).toBe(false);

		resolveHandler();
		await handler;
		await shutdown;

		expect(shutdownFinished).toBe(true);
		expect(rabbitMq.cancelConsumers).toHaveBeenCalledTimes(1);
	});

	it('rejects retired v1 lead events before delivery', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const message = createMessage();
		message.content = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо' },
				lead: {
					id: 'lead-1',
					createdAt: '2026-07-23T12:00:00.000Z'
				},
				destination: { webhookUrl: 'https://example.com' }
			})
		);
		message.properties.type = 'lead.integration.requested.v1';

		await (service as any).handle('webhook', message);

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(
			prisma.integrationDeliveryReceipt.create
		).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'webhook',
			expect.objectContaining({ malformed: true }),
			0,
			'11111111-1111-4111-8111-111111111111',
			'payload.destination.webhookUrl is forbidden in RabbitMQ payload',
			'lead.integration.requested.v1',
			expect.objectContaining({
				category: 'PERMANENT',
				normalizedCode: 'INVALID_EVENT_PAYLOAD'
			})
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('skips an event that already has a delivery receipt', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.DELIVERED,
			lockedAt: new Date()
		});

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not deliver an event closed without retry', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY,
			lockedAt: new Date(),
			retryAttempt: null,
			retryAvailableAt: null,
			retryToken: null
		});

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('activates only the retry message with the expected delivery token', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const retryToken = '22222222-2222-4222-8222-222222222222';
		const retryAvailableAt = new Date(Date.now() - 1000);
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
			lockedAt: retryAvailableAt,
			retryAttempt: 1,
			retryAvailableAt,
			retryToken
		});
		const message = createMessage();
		message.properties.headers = {
			'x-retry-attempt': 1,
			'x-delivery-token': retryToken
		};

		await (service as any).handle('webhook', message);

		expect(
			prisma.integrationDeliveryReceipt.updateMany
		).toHaveBeenNthCalledWith(1, {
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
				retryAttempt: 1,
				retryAvailableAt,
				retryToken
			},
			data: {
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt: expect.any(Date),
				deliveredAt: null,
				retryAttempt: null,
				retryAvailableAt: null,
				retryToken: null
			}
		});
		expect(delivery.deliver).toHaveBeenCalledTimes(1);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('skips a stale retry token without calling the destination', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
			lockedAt: new Date(),
			retryAttempt: 1,
			retryAvailableAt: new Date(Date.now() - 1000),
			retryToken: '22222222-2222-4222-8222-222222222222'
		});
		const message = createMessage();
		message.properties.headers = {
			'x-retry-attempt': 1,
			'x-delivery-token': '33333333-3333-4333-8333-333333333333'
		};

		await (service as any).handle('webhook', message);

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('claims and marks a receipt before acknowledging successful delivery', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).toHaveBeenCalledTimes(1);
		expect(prisma.integrationDeliveryReceipt.create).toHaveBeenCalledWith({
			data: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt: expect.any(Date),
				deliveredAt: null,
				retryAttempt: null,
				retryAvailableAt: null,
				retryToken: null
			}
		});
		expect(
			prisma.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt: expect.any(Date)
			},
			data: {
				status: IntegrationDeliveryReceiptStatus.DELIVERED,
				deliveredAt: expect.any(Date),
				retryAttempt: null,
				retryAvailableAt: null,
				retryToken: null
			}
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not release a fresh claim owned by another handler', async () => {
		const { service, rabbitMq, delivery, prisma, transaction } =
			createService();
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.PROCESSING,
			lockedAt: new Date()
		});

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(
			prisma.integrationDeliveryReceipt.deleteMany
		).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.createMany).toHaveBeenCalledTimes(1);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not exhaust delivery retries while another handler owns the claim', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.PROCESSING,
			lockedAt: new Date()
		});
		const message = createMessage();
		message.properties.headers = { 'x-retry-attempt': 3 };

		await (service as any).handle('webhook', message);

		expect(transaction.outboxEvent.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					messageId: '11111111-1111-4111-8111-111111111111',
					eventType: 'lead.integration.requested.v2',
					routingKey: 'lead.integration.webhook.v2',
					headers: expect.objectContaining({
						'x-retry-attempt': 3
					}),
					availableAt: expect.any(Date)
				})
			],
			skipDuplicates: true
		});
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
	});

	it('releases only its own claim when delivery fails', async () => {
		const { service, rabbitMq, delivery, prisma, transaction } =
			createService();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new Error('Remote service unavailable')
		);

		await (service as any).handle('webhook', createMessage());

		const lockedAt = (
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mock.calls[0][0].data.lockedAt;
		expect(
			prisma.integrationDeliveryReceipt.deleteMany
		).not.toHaveBeenCalled();
		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt
			},
			data: expect.objectContaining({
				status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
				retryAttempt: 1,
				retryAvailableAt: expect.any(Date),
				retryToken: expect.any(String)
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		const retryOutbox =
			transaction.outboxEvent.create.mock.calls[0][0].data;
		expect(retryOutbox.deduplicationKey).toBe(
			`integration:11111111-1111-4111-8111-111111111111:webhook:retry:1:${retryOutbox.headers['x-delivery-token']}`
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not schedule a second retry after a scheduled job persisted it', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new ScheduledJobDispatchHandledError(
				'retry_scheduled',
				{
					id: '11111111-1111-4111-8111-111111111111',
					attempts: 1
				} as ScheduledJobRunView,
				'Telegram unavailable'
			)
		);

		await (service as any).handle(
			'daily-summary-telegram',
			createDailySummaryMessage()
		);

		expect(
			prisma.integrationDeliveryReceipt.deleteMany
		).toHaveBeenCalledTimes(1);
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not directly publish a DLQ event after a scheduled job persisted its terminal intent', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new ScheduledJobDispatchHandledError(
				'failed',
				{
					id: '11111111-1111-4111-8111-111111111111',
					attempts: 4
				} as ScheduledJobRunView,
				'Telegram destination is no longer available'
			)
		);

		await (service as any).handle(
			'daily-summary-telegram',
			createDailySummaryMessage()
		);

		expect(
			prisma.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: expect.objectContaining({
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'daily-summary-telegram',
				status: IntegrationDeliveryReceiptStatus.PROCESSING
			}),
			data: expect.objectContaining({
				status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED
			})
		});
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('dead-letters an unclassified daily-summary error after its short retry budget', async () => {
		const { service, rabbitMq, delivery } = createService();
		const message = createDailySummaryMessage();
		message.properties.headers = { 'x-retry-attempt': 3 };
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new Error('PostgreSQL temporarily unavailable')
		);

		await (service as any).handle('daily-summary-telegram', message);

		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'daily-summary-telegram',
			expect.any(Object),
			4,
			'11111111-1111-4111-8111-111111111111',
			'Unclassified integration error; automatic retry budget exhausted',
			'report.daily-summary.requested.v1',
			expect.objectContaining({
				category: 'TRANSIENT',
				normalizedCode: 'UNCLASSIFIED',
				retryable: false
			})
		);
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('stops automatic retries after the delivery window expires', async () => {
		const { service, rabbitMq, delivery, transaction } = createService();
		const message = createMessage();
		message.properties.headers = {
			'x-first-failed-at': new Date(
				Date.now() - 25 * 60 * 60 * 1000
			).toISOString()
		};
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new Error('Remote service unavailable')
		);

		await (service as any).handle('webhook', message);

		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'webhook',
			expect.any(Object),
			1,
			'11111111-1111-4111-8111-111111111111',
			'Automatic retry window expired',
			'lead.integration.requested.v2',
			expect.objectContaining({
				category: 'PERMANENT',
				normalizedCode: 'AUTOMATIC_RETRY_WINDOW_EXPIRED',
				retryable: false
			})
		);
	});

	it('dead-letters a permanently rejected scheduled-job reference', async () => {
		const { service, rabbitMq, delivery } = createService();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new ScheduledJobDispatchRejectedError('Daily summary job not found')
		);

		await (service as any).handle(
			'daily-summary-telegram',
			createDailySummaryMessage()
		);

		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'daily-summary-telegram',
			expect.any(Object),
			1,
			'11111111-1111-4111-8111-111111111111',
			'Daily summary job not found',
			'report.daily-summary.requested.v1',
			expect.objectContaining({
				category: 'PERMANENT',
				normalizedCode: 'SCHEDULED_JOB_REFERENCE_INVALID'
			})
		);
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('dead-letters a daily summary whose messageId does not match its job', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const message = createDailySummaryMessage();
		message.properties.messageId = '22222222-2222-4222-8222-222222222222';

		await (service as any).handle('daily-summary-telegram', message);

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(
			prisma.integrationDeliveryReceipt.create
		).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'daily-summary-telegram',
			expect.objectContaining({
				malformed: true
			}),
			0,
			'22222222-2222-4222-8222-222222222222',
			'Scheduled event jobId must match the AMQP messageId',
			'report.daily-summary.requested.v1',
			expect.objectContaining({
				category: 'PERMANENT',
				normalizedCode: 'INVALID_EVENT_PAYLOAD'
			})
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('uses the same deterministic ID for malformed redeliveries', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const message = createMessage();
		message.properties.messageId = 'not-a-uuid';

		await (service as any).handle('webhook', message);
		await (service as any).handle('webhook', message);

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(
			prisma.integrationDeliveryReceipt.create
		).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'webhook',
			expect.any(Object),
			0,
			expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			),
			'RabbitMQ messageId is missing or invalid',
			'lead.integration.requested.v2',
			expect.objectContaining({
				category: 'PERMANENT',
				normalizedCode: 'INVALID_EVENT_PAYLOAD'
			})
		);
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalledWith(
			'webhook',
			expect.anything(),
			expect.anything(),
			'not-a-uuid',
			expect.anything(),
			expect.anything(),
			expect.anything()
		);
		expect(
			(rabbitMq.publishDeadLetter as jest.Mock).mock.calls[1][3]
		).toBe((rabbitMq.publishDeadLetter as jest.Mock).mock.calls[0][3]);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(2);
	});

	it('uses the same deterministic ID when an invalid DLQ message is redelivered', async () => {
		const { service, rabbitMq, prisma } = createService();
		const message = createMessage();
		message.properties.messageId = 'not-a-uuid';
		message.properties.headers = {
			'x-last-error': 'Malformed source event'
		};

		await (service as any).collectDeadLetter('webhook', message);
		await (service as any).collectDeadLetter('webhook', message);

		expect(prisma.integrationDeliveryFailure.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					eventId_integration: {
						eventId: expect.stringMatching(
							/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
						),
						integration: 'webhook'
					}
				}
			})
		);
		const firstEventId = (
			prisma.integrationDeliveryFailure.upsert as jest.Mock
		).mock.calls[0][0].where.eventId_integration.eventId;
		const secondEventId = (
			prisma.integrationDeliveryFailure.upsert as jest.Mock
		).mock.calls[1][0].where.eventId_integration.eventId;
		expect(secondEventId).toBe(firstEventId);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(2);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('does not let a stale daily-summary DLQ message fail a retried job', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [{ id: 'failure-1' }]
				: [
						{
							jobType: 'DAILY_TELEGRAM_SUMMARY',
							status: 'QUEUED'
						}
					];
		});
		const message = createDailySummaryMessage();
		message.properties.headers = {
			'x-last-error': 'Old delivery failure',
			'x-retry-attempt': 4
		};

		await (service as any).collectDeadLetter(
			'daily-summary-telegram',
			message
		);

		expect(
			prisma.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(prisma.scheduledJobRun.updateMany).not.toHaveBeenCalled();
		expect(
			(
				transaction.$queryRaw.mock.calls[0][0] as {
					strings: string[];
				}
			).strings.join('?')
		).toContain('FOR UPDATE');
		expect(
			(
				transaction.$queryRaw.mock.calls[1][0] as {
					strings: string[];
				}
			).strings.join('?')
		).toContain('FOR SHARE');
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not let an older daily-summary DLQ attempt overwrite a newer terminal failure', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? []
				: [
						{
							jobType: 'DAILY_TELEGRAM_SUMMARY',
							status: 'FAILED',
							attempts: 8
						}
					];
		});
		const message = createDailySummaryMessage();
		message.properties.headers = {
			'x-last-error': 'Old daily summary failure',
			'x-retry-attempt': 4
		};

		await (service as any).collectDeadLetter(
			'daily-summary-telegram',
			message
		);

		expect(
			prisma.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('persists a daily-summary DLQ message while its job is still failed', async () => {
		const { service, rabbitMq, prisma } = createService();
		const message = createDailySummaryMessage();
		message.properties.headers = {
			'x-last-error': 'Telegram unavailable',
			'x-retry-attempt': 4
		};

		await (service as any).collectDeadLetter(
			'daily-summary-telegram',
			message
		);

		expect(prisma.integrationDeliveryFailure.upsert).toHaveBeenCalledTimes(
			1
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('persists a rejected daily event that points to a different job type', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? []
				: [{ jobType: 'DATABASE_BACKUP', status: 'QUEUED' }];
		});
		const message = createDailySummaryMessage();
		message.properties.headers = {
			'x-last-error': 'Unexpected daily summary job type',
			'x-retry-attempt': 1
		};

		await (service as any).collectDeadLetter(
			'daily-summary-telegram',
			message
		);

		expect(prisma.integrationDeliveryFailure.upsert).toHaveBeenCalledTimes(
			1
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not overwrite an already resolved failure from a late DLQ message', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [
						{
							resolvedAt: new Date(),
							retryingAt: null,
							activeRetryToken: null
						}
					]
				: [{ id: 'receipt-1' }];
		});
		const message = createMessage();
		message.properties.headers = {
			'x-last-error': 'Late duplicate'
		};

		await (service as any).collectDeadLetter('webhook', message);

		expect(
			prisma.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('ignores a stale DLQ token after a newer manual retry started', async () => {
		const { service, rabbitMq, prisma, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [
						{
							resolvedAt: null,
							retryingAt: new Date(),
							activeRetryToken: '22222222-2222-4222-8222-222222222222'
						}
					]
				: [{ id: 'receipt-1' }];
		});
		const message = createMessage();
		message.properties.headers = {
			'x-last-error': 'Old delivery failure',
			'x-delivery-token': '33333333-3333-4333-8333-333333333333'
		};

		await (service as any).collectDeadLetter('webhook', message);

		expect(
			prisma.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('atomically reclaims a stale processing receipt', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const staleLockedAt = new Date(Date.now() - 11 * 60 * 1000);
		(
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mockRejectedValue(uniqueConstraintError());
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: IntegrationDeliveryReceiptStatus.PROCESSING,
			lockedAt: staleLockedAt
		});

		await (service as any).handle('webhook', createMessage());

		expect(
			prisma.integrationDeliveryReceipt.updateMany
		).toHaveBeenNthCalledWith(1, {
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt: staleLockedAt
			},
			data: {
				lockedAt: expect.any(Date),
				retryAttempt: null,
				retryAvailableAt: null,
				retryToken: null
			}
		});
		expect(delivery.deliver).toHaveBeenCalledTimes(1);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not spend mailing rate limit on cancelled deliveries', async () => {
		const { service, prisma } = createService();
		(prisma.mailingDelivery.findUnique as jest.Mock).mockResolvedValue({
			status: 'CANCELLED',
			updatedAt: new Date(),
			campaign: {
				status: 'CANCELLED',
				cancelRequestedAt: new Date()
			}
		});

		const bypass = await (service as any).shouldBypassMailingRateLimit(
			'mailing-email',
			{
				schemaVersion: 1,
				eventType: 'mailing.delivery.requested.v1',
				campaignId: '22222222-2222-4222-8222-222222222222',
				deliveryId: '33333333-3333-4333-8333-333333333333',
				channel: 'EMAIL'
			}
		);

		expect(bypass).toBe(true);
	});

	it('reserves a shared PostgreSQL slot before a mailing delivery', async () => {
		const { service, prisma, delivery } = createService({
			MAILING_EMAIL_RATE_PER_SECOND: '5'
		});
		(prisma.mailingDelivery.findUnique as jest.Mock).mockResolvedValue({
			status: 'PENDING',
			updatedAt: new Date(),
			campaign: {
				status: 'RUNNING',
				cancelRequestedAt: null
			}
		});
		const payload = {
			schemaVersion: 1,
			eventType: 'mailing.delivery.requested.v1',
			campaignId: '22222222-2222-4222-8222-222222222222',
			deliveryId: '33333333-3333-4333-8333-333333333333',
			channel: 'EMAIL'
		};

		await (service as any).deliverWithRateLimit(
			'mailing-email',
			payload,
			'11111111-1111-4111-8111-111111111111'
		);

		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
		const statement = (prisma.$queryRaw as jest.Mock).mock.calls[0][0];
		const sql = statement.strings.join('?');
		expect(sql).toContain('INSERT INTO "messaging_rate_limits"');
		expect(sql).toContain('ON CONFLICT ("key") DO UPDATE');
		expect(sql).toContain('GREATEST');
		expect(statement.values).toContain('mailing-email');
		expect(statement.values).toContain(200);
		expect(delivery.deliver).toHaveBeenCalledWith(
			'mailing-email',
			payload,
			'11111111-1111-4111-8111-111111111111'
		);
	});

	it('accepts a current single-recipient limit event and rejects v1', () => {
		const { service } = createService();
		const message = createMessage();
		message.content = Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				eventType: 'lead.limit.reached.email.v2',
				entity: {
					id: 'widget-1',
					name: 'Колесо',
					type: 'widget'
				},
				limit: 100,
				destination: { email: 'owner@example.com' }
			})
		);
		message.fields.routingKey = 'lead.limit.reached.email.v2';
		message.properties.type = 'lead.limit.reached.email.v2';

		expect((service as any).parsePayload('limit-email', message)).toEqual(
			expect.objectContaining({
				schemaVersion: 2,
				destination: { email: 'owner@example.com' }
			})
		);

		message.content = Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				eventType: 'lead.limit.reached.v1',
				entity: {
					id: 'widget-1',
					name: 'Колесо',
					type: 'widget'
				},
				limit: 100,
				destinations: {
					emails: ['owner@example.com'],
					telegramChatId: null
				}
			})
		);
		message.fields.routingKey = 'lead.limit.reached.email.v1';
		message.properties.type = 'lead.limit.reached.v1';
		expect(() =>
			(service as any).parsePayload('limit-email', message)
		).toThrow('Unsupported messaging event type');
	});

	it('redacts only resolved failure details after configured retention', async () => {
		const { service, prisma } = createService({
			INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS: '14'
		});
		(prisma.$executeRaw as jest.Mock)
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(1);

		await (service as any).cleanupReceiptsIfDue();

		expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
		const statement = (prisma.$executeRaw as jest.Mock).mock.calls[1][0];
		const sql = statement.strings.join('?');
		expect(sql).toContain('"resolved_at" IS NOT NULL');
		expect(sql).toContain('"payload" = \'{}\'::jsonb');
		expect(sql).toContain('"last_error" = ?');
		expect(sql).toContain('"safe_reason" = CASE');
		expect(statement.values).toEqual(
			expect.arrayContaining([
				expect.any(Date),
				'[redacted after retention]'
			])
		);
		const cutoff = statement.values.find(
			(value: unknown): value is Date => value instanceof Date
		);
		expect(cutoff?.getTime()).toBeLessThanOrEqual(
			Date.now() - 14 * 24 * 60 * 60 * 1000
		);
	});
});
