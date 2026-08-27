import { OutboxStatus } from '@prisma/operations-client';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OperationsOutboxPublisherService } from './operations-outbox-publisher.service';
import { OperationsRabbitMqService } from './operations-rabbitmq.service';

describe('OperationsOutboxPublisherService', () => {
	it('marks PUBLISHED only after confirmed mandatory publication', async () => {
		const event = {
			id: 'outbox-1',
			eventId: '3ad36f14-550c-47bd-8f69-2c913cdb83ee',
			messageId: null,
			deduplicationKey: null,
			eventType: 'operations.example.changed.v1',
			aggregateType: 'example',
			aggregateId: 'example-1',
			correlationId: null,
			exchange: 'winwidget.events',
			routingKey: 'operations.example.changed.v1',
			payload: { schemaVersion: 1 },
			headers: {},
			status: OutboxStatus.PROCESSING,
			attempt: 1,
			availableAt: new Date(),
			leaseToken: '5e511f01-7c25-46b0-8e0e-f7c443355db5',
			leaseExpiresAt: new Date(Date.now() + 30_000),
			publishedAt: null,
			lastError: null,
			createdAt: new Date(),
			updatedAt: new Date()
		};
		const updateMany = jest
			.fn()
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });
		const prisma = {
			outboxEvent: {
				findFirst: jest.fn().mockResolvedValue({ id: event.id }),
				updateMany,
				findUniqueOrThrow: jest.fn().mockResolvedValue(event)
			}
		} as unknown as OperationsPrismaService;
		const runtime = {
			outboxPublisherEnabled: true,
			outboxPollIntervalMs: 1_000,
			outboxBatchSize: 50
		} as OperationsRuntimeService;
		const rabbit = {
			publish: jest.fn().mockResolvedValue(undefined)
		} as unknown as OperationsRabbitMqService;
		const service = new OperationsOutboxPublisherService(
			prisma,
			runtime,
			rabbit
		);

		await expect(service.publishOne()).resolves.toBe(true);
		expect(rabbit.publish).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: OutboxStatus.PROCESSING,
					leaseToken: event.leaseToken
				}),
				data: expect.objectContaining({
					status: OutboxStatus.PUBLISHED
				})
			})
		);
		expect(
			(rabbit.publish as jest.Mock).mock.invocationCallOrder[0]
		).toBeLessThan(updateMany.mock.invocationCallOrder[1]);
	});

	it('starts polling immediately in the apps-only runtime', async () => {
		const prisma = {
			outboxEvent: { findFirst: jest.fn().mockResolvedValue(null) }
		} as unknown as OperationsPrismaService;
		const runtime = {
			outboxPublisherEnabled: true,
			outboxPollIntervalMs: 1_000,
			outboxBatchSize: 50
		} as OperationsRuntimeService;
		const rabbit = {
			publish: jest.fn()
		} as unknown as OperationsRabbitMqService;
		const service = new OperationsOutboxPublisherService(
			prisma,
			runtime,
			rabbit
		);

		await service.onModuleInit();
		await new Promise(resolve => setImmediate(resolve));

		expect(service.isReady()).toBe(true);
		expect(prisma.outboxEvent.findFirst).toHaveBeenCalledTimes(1);
		expect(rabbit.publish).not.toHaveBeenCalled();
		service.onApplicationShutdown();
	});
});
