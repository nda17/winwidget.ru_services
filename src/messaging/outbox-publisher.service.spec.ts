import { OutboxPublisherService } from '@/messaging/outbox-publisher.service';
import type { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { PrismaService } from '@/prisma.service';
import type { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';

describe('OutboxPublisherService', () => {
	const createEvent = (
		overrides: Partial<OutboxEvent> = {}
	): OutboxEvent => {
		const now = new Date('2026-07-24T00:00:00.000Z');

		return {
			id: '11111111-1111-4111-8111-111111111111',
			messageId: null,
			deduplicationKey: null,
			eventType: 'payment.succeeded.v1',
			routingKey: 'payment.succeeded.v1',
			payload: { schemaVersion: 1 } as Prisma.JsonObject,
			headers: {},
			status: OutboxEventStatus.PUBLISHING,
			attempts: 0,
			availableAt: now,
			lockedAt: now,
			lockedBy: 'publisher',
			publishedAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
			...overrides
		};
	};

	const createService = () => {
		const prisma = {
			outboxEvent: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findMany: jest.fn().mockResolvedValue([]),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$transaction: jest.fn(),
			$executeRaw: jest.fn().mockResolvedValue(0)
		} as unknown as PrismaService;
		const rabbitMq = {
			publishEvent: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const configService = {
			get: jest.fn()
		} as unknown as ConfigService;

		return {
			service: new OutboxPublisherService(prisma, rabbitMq, configService),
			prisma,
			rabbitMq
		};
	};

	it('uses the stable messageId while keeping the outbox row id in headers', async () => {
		const { service, rabbitMq } = createService();
		const event = createEvent({
			messageId: '22222222-2222-4222-8222-222222222222',
			headers: {
				'x-retry-attempt': 2,
				'x-error-category': 'RATE_LIMIT'
			}
		});

		await (service as any).publish(event);

		expect(rabbitMq.publishEvent).toHaveBeenCalledWith(
			'payment.succeeded.v1',
			event.payload,
			expect.objectContaining({
				messageId: '22222222-2222-4222-8222-222222222222',
				headers: expect.objectContaining({
					'x-outbox-event-id': '11111111-1111-4111-8111-111111111111',
					'x-retry-attempt': 2,
					'x-error-category': 'RATE_LIMIT'
				})
			})
		);
	});

	it('falls back to the outbox row id when messageId is absent', async () => {
		const { service, rabbitMq } = createService();
		const event = createEvent();

		await (service as any).publish(event);

		expect(rabbitMq.publishEvent).toHaveBeenCalledWith(
			event.routingKey,
			event.payload,
			expect.objectContaining({ messageId: event.id })
		);
	});

	it('reschedules a failed publication indefinitely with capped backoff', async () => {
		const { service, prisma, rabbitMq } = createService();
		const event = createEvent({ attempts: 25 });
		(rabbitMq.publishEvent as jest.Mock).mockRejectedValue(
			new Error('RabbitMQ unavailable')
		);
		const before = Date.now();

		await (service as any).publish(event);

		const update = (prisma.outboxEvent.updateMany as jest.Mock).mock
			.calls[0][0];
		expect(update.data).toEqual(
			expect.objectContaining({
				status: OutboxEventStatus.PENDING,
				attempts: 26,
				lastError: 'RabbitMQ unavailable'
			})
		);
		expect(update.data.availableAt.getTime()).toBeGreaterThanOrEqual(
			before + 60_000
		);
		expect(update.data.availableAt.getTime()).toBeLessThanOrEqual(
			Date.now() + 60_000
		);
	});

	it('recovers FAILED rows before claiming a batch', async () => {
		const { service, prisma } = createService();
		const transaction = {
			outboxEvent: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				findMany: jest.fn().mockResolvedValue([])
			},
			$queryRaw: jest.fn().mockResolvedValue([])
		};
		(prisma.$transaction as jest.Mock).mockImplementation(callback =>
			callback(transaction)
		);

		await (service as any).claimBatch();

		expect(transaction.outboxEvent.updateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({
					status: OutboxEventStatus.FAILED,
					availableAt: expect.objectContaining({
						lte: expect.any(Date)
					})
				}),
				data: expect.objectContaining({
					status: OutboxEventStatus.PENDING,
					lockedAt: null,
					lockedBy: null
				})
			})
		);
	});

	it('skips publishing when it cannot renew the event claim', async () => {
		const { service, prisma, rabbitMq } = createService();
		const event = createEvent();
		jest
			.spyOn(service as any, 'cleanupPublishedEventsIfDue')
			.mockResolvedValue(undefined);
		jest.spyOn(service as any, 'claimBatch').mockResolvedValue([event]);
		jest.spyOn(service as any, 'schedule').mockImplementation(() => {});
		(prisma.outboxEvent.updateMany as jest.Mock).mockResolvedValue({
			count: 0
		});

		await (service as any).poll();

		expect(rabbitMq.publishEvent).not.toHaveBeenCalled();
	});

	it('renews the lease immediately before publishing', async () => {
		const { service, prisma, rabbitMq } = createService();
		const event = createEvent();
		jest
			.spyOn(service as any, 'cleanupPublishedEventsIfDue')
			.mockResolvedValue(undefined);
		jest.spyOn(service as any, 'claimBatch').mockResolvedValue([event]);
		jest.spyOn(service as any, 'schedule').mockImplementation(() => {});

		await (service as any).poll();

		expect(
			(prisma.outboxEvent.updateMany as jest.Mock).mock.calls[0][0]
		).toEqual({
			where: {
				id: event.id,
				status: OutboxEventStatus.PUBLISHING,
				lockedBy: expect.any(String)
			},
			data: { lockedAt: expect.any(Date) }
		});
		expect(rabbitMq.publishEvent).toHaveBeenCalledTimes(1);
		expect(
			(prisma.outboxEvent.updateMany as jest.Mock).mock
				.invocationCallOrder[0]
		).toBeLessThan(
			(rabbitMq.publishEvent as jest.Mock).mock.invocationCallOrder[0]
		);
	});

	it('logs a warning when a published event cannot be finalized', async () => {
		const { service, prisma } = createService();
		const warn = jest
			.spyOn((service as any).logger, 'warn')
			.mockImplementation(() => {});
		(prisma.outboxEvent.updateMany as jest.Mock).mockResolvedValue({
			count: 0
		});

		await (service as any).publish(createEvent());

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				'Published outbox event but could not finalize its claim'
			)
		);
	});

	it('cleans published events in bounded database batches', async () => {
		const { service, prisma } = createService();
		(prisma.$executeRaw as jest.Mock)
			.mockResolvedValueOnce(1000)
			.mockResolvedValueOnce(2);

		await (service as any).cleanupPublishedEventsIfDue();

		expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
	});
});
