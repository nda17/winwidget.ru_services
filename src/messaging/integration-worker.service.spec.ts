import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { INTEGRATION_KINDS } from '@/messaging/messaging.constants';
import type { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { PrismaService } from '@/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';

describe('IntegrationWorkerService', () => {
	const createService = (
		values: Record<string, string | undefined> = {}
	) => {
		const rabbitMq = {
			consume: jest.fn().mockResolvedValue(undefined),
			consumeDeadLetter: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			publishRetry: jest.fn()
		} as unknown as RabbitMqService;
		const delivery = {
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as IntegrationDeliveryService;
		const configService = {
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService;

		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			}
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
			prisma
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

	it('skips an event that already has a delivery receipt', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();
		(
			prisma.integrationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({ id: 'receipt-1' });

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('stores a receipt before acknowledging successful delivery', async () => {
		const { service, rabbitMq, delivery, prisma } = createService();

		await (service as any).handle('webhook', createMessage());

		expect(delivery.deliver).toHaveBeenCalledTimes(1);
		expect(prisma.integrationDeliveryReceipt.create).toHaveBeenCalledWith({
			data: {
				eventId: '11111111-1111-4111-8111-111111111111',
				integration: 'webhook'
			}
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});
});
