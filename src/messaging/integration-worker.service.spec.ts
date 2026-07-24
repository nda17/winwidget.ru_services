import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { INTEGRATION_KINDS } from '@/messaging/messaging.constants';
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
			publishDeadLetter: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const delivery = {
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as IntegrationDeliveryService;
		const configService = {
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService;
		const failureUpsert = jest.fn().mockResolvedValue({});
		const transaction = {
			$queryRaw: jest.fn().mockImplementation(statement => {
				const sql = statement.strings.join('?');
				return sql.includes('integration_delivery_failures')
					? []
					: [{ jobType: 'DAILY_TELEGRAM_SUMMARY', status: 'FAILED' }];
			}),
			integrationDeliveryFailure: {
				upsert: failureUpsert
			}
		};

		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				upsert: failureUpsert
			},
			scheduledJobRun: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			mailingDelivery: {
				findUnique: jest.fn()
			},
			$executeRaw: jest.fn().mockResolvedValue(0),
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;

		return {
			service: new IntegrationWorkerService(
				rabbitMq,
				delivery,
				configService,
				prisma
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
			),
			properties: { messageId: '11111111-1111-4111-8111-111111111111' }
		}) as ConsumeMessage;

	const createDailySummaryMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					eventType: 'report.daily-summary.requested.v1',
					jobId: '11111111-1111-4111-8111-111111111111',
					periodStart: '2026-07-22T21:00:00.000Z',
					periodEnd: '2026-07-23T21:00:00.000Z'
				})
			),
			properties: {
				messageId: '11111111-1111-4111-8111-111111111111'
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
		const { service } = createService();
		let resolveHandler!: () => void;
		const handler = (service as any).trackHandler(
			() =>
				new Promise<void>(resolve => {
					resolveHandler = resolve;
				})
		);
		let shutdownFinished = false;
		const shutdown = service.onApplicationShutdown().then(() => {
			shutdownFinished = true;
		});

		await Promise.resolve();
		expect(shutdownFinished).toBe(false);

		resolveHandler();
		await handler;
		await shutdown;

		expect(shutdownFinished).toBe(true);
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
				deliveredAt: null
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
				deliveredAt: expect.any(Date)
			}
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not release a fresh claim owned by another handler', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
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
		expect(rabbitMq.publishRetry).toHaveBeenCalledTimes(1);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not exhaust delivery retries while another handler owns the claim', async () => {
		const { service, rabbitMq, prisma } = createService();
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

		expect(rabbitMq.publishRetry).toHaveBeenCalledWith(
			'webhook',
			expect.any(Object),
			3,
			'11111111-1111-4111-8111-111111111111',
			'lead.integration.requested.v1'
		);
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
	});

	it('releases only its own claim when delivery fails', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new Error('Remote service unavailable')
		);

		await (service as any).handle('webhook', createMessage());

		const lockedAt = (
			prisma.integrationDeliveryReceipt.create as jest.Mock
		).mock.calls[0][0].data.lockedAt;
		expect(
			prisma.integrationDeliveryReceipt.deleteMany
		).toHaveBeenCalledWith({
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook',
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt
			}
		});
		expect(rabbitMq.publishRetry).toHaveBeenCalledTimes(1);
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

	it('keeps transient daily-summary infrastructure errors in delayed RabbitMQ retry', async () => {
		const { service, rabbitMq, delivery } = createService();
		const message = createDailySummaryMessage();
		message.properties.headers = { 'x-retry-attempt': 3 };
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new Error('PostgreSQL temporarily unavailable')
		);

		await (service as any).handle('daily-summary-telegram', message);

		expect(rabbitMq.publishRetry).toHaveBeenCalledWith(
			'daily-summary-telegram',
			expect.any(Object),
			4,
			'11111111-1111-4111-8111-111111111111',
			'report.daily-summary.requested.v1'
		);
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
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
			'report.daily-summary.requested.v1'
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
				jobId: '11111111-1111-4111-8111-111111111111'
			}),
			0,
			'22222222-2222-4222-8222-222222222222',
			'Invalid daily summary event payload',
			'unknown'
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('replaces an invalid messageId before publishing malformed data to the DLQ', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		const message = createMessage();
		message.properties.messageId = 'not-a-uuid';

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
			'unknown'
		);
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalledWith(
			'webhook',
			expect.anything(),
			expect.anything(),
			'not-a-uuid',
			expect.anything(),
			expect.anything()
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('normalizes an invalid DLQ messageId before persisting the failure', async () => {
		const { service, rabbitMq, prisma } = createService();
		const message = createMessage();
		message.properties.messageId = 'not-a-uuid';
		message.properties.headers = {
			'x-last-error': 'Malformed source event'
		};

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
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
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
			data: { lockedAt: expect.any(Date) }
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
});
