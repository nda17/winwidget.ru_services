import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { INTEGRATION_KINDS } from '@/messaging/messaging.constants';
import type { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { PrismaService } from '@/prisma.service';
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

		const prisma = {
			integrationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			mailingDelivery: {
				findUnique: jest.fn()
			},
			$executeRaw: jest.fn().mockResolvedValue(0)
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
