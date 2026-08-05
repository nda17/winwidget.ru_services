import { ConfigService } from '@nestjs/config';
import {
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	WidgetsOutboxExchange
} from '@prisma/widgets-client';
import type { ConsumeMessage } from 'amqplib';
import type { WidgetsRabbitMqService } from '../messaging/widgets-rabbitmq.service';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import type { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import type { WidgetsLeadIntegrationEvent } from './widgets-integration-delivery.service';
import type { WidgetsIntegrationDeliveryService } from './widgets-integration-delivery.service';
import { WidgetsIntegrationWorkerService } from './widgets-integration-worker.service';
import { WidgetsSafeHttpError } from './widgets-safe-http.service';

const eventId = '33333333-3333-4333-8333-333333333333';
const event: WidgetsLeadIntegrationEvent = {
	schemaVersion: 2,
	eventType: 'lead.integration.requested.v2',
	integration: 'webhook',
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: { id: 'lead-1', createdAt: '2026-08-04T12:00:00.000Z' },
	destination: { credentialRef: '11111111-1111-4111-8111-111111111111' }
};

const message = (
	headers: Record<string, unknown> = {},
	content = Buffer.from(JSON.stringify(event))
): ConsumeMessage =>
	({
		content,
		fields: {} as ConsumeMessage['fields'],
		properties: {
			messageId: eventId,
			type: 'lead.integration.requested.v2',
			correlationId: 'correlation-1',
			headers
		} as ConsumeMessage['properties']
	}) as ConsumeMessage;

describe('WidgetsIntegrationWorkerService', () => {
	const createWorker = (configValues: Record<string, string> = {}) => {
		const transaction = {
			integrationDeliveryReceipt: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				upsert: jest.fn().mockResolvedValue({})
			},
			integrationCredentialSnapshot: {
				deleteMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			widgetsOutboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			integrationDeliveryReceipt: {
				create: jest.fn().mockResolvedValue({}),
				findUnique: jest.fn(),
				findMany: jest.fn().mockResolvedValue([])
			},
			integrationDeliveryFailure: {
				findMany: jest.fn().mockResolvedValue([])
			},
			integrationCredentialSnapshot: { deleteMany: jest.fn() },
			widgetsOutboxEvent: { create: jest.fn().mockResolvedValue({}) },
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as WidgetsPrismaService;
		const rabbit = {
			ack: jest.fn(),
			nack: jest.fn(),
			publish: jest.fn().mockResolvedValue(undefined)
		} as unknown as WidgetsRabbitMqService;
		const delivery = {
			parse: jest.fn().mockReturnValue(event),
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as WidgetsIntegrationDeliveryService;
		const runtime = { workerEnabled: true } as WidgetsRuntimeService;
		const config = {
			get: jest.fn((key: string) => configValues[key])
		} as unknown as ConfigService;
		const worker = new WidgetsIntegrationWorkerService(
			rabbit,
			prisma,
			delivery,
			runtime,
			config
		);
		return { worker, rabbit, prisma, delivery, transaction };
	};

	it('deletes the credential snapshot in the DELIVERED receipt transaction', async () => {
		const { worker, rabbit, delivery, transaction } = createWorker();

		await (
			worker as unknown as {
				handle: (kind: 'webhook', value: ConsumeMessage) => Promise<void>;
			}
		).handle('webhook', message());

		expect(delivery.deliver).toHaveBeenCalledWith(
			'webhook',
			eventId,
			event
		);
		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: IntegrationDeliveryReceiptStatus.DELIVERED
				})
			})
		);
		expect(
			transaction.integrationCredentialSnapshot.deleteMany
		).toHaveBeenCalledWith({
			where: { eventId, integration: 'webhook' }
		});
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
		expect(rabbit.nack).not.toHaveBeenCalled();
	});

	it('moves an authentication failure directly to DLQ with safe diagnostics', async () => {
		const { worker, rabbit, delivery, transaction } = createWorker();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new WidgetsSafeHttpError({
				provider: 'webhook',
				httpStatus: 401,
				providerCode: 'HTTP_401',
				retryAfterMs: null,
				safeReason: 'Webhook request failed (HTTP_401)'
			})
		);

		await (
			worker as unknown as {
				handle: (kind: 'webhook', value: ConsumeMessage) => Promise<void>;
			}
		).handle('webhook', message());

		expect(
			transaction.integrationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
					retryToken: null
				})
			})
		);
		expect(transaction.widgetsOutboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: WidgetsOutboxExchange.DEAD_LETTER
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					category: IntegrationErrorCategory.AUTH_CONFIGURATION,
					httpStatus: 401,
					normalizedCode: 'WEBHOOK_HTTP_401',
					retryable: false
				})
			})
		);
		expect(
			transaction.integrationCredentialSnapshot.deleteMany
		).not.toHaveBeenCalled();
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
	});

	it('schedules a token-bound rate-limit retry no earlier than Retry-After', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
		const { worker, delivery, transaction } = createWorker();
		(delivery.deliver as jest.Mock).mockRejectedValue(
			new WidgetsSafeHttpError({
				provider: 'webhook',
				httpStatus: 429,
				providerCode: 'HTTP_429',
				retryAfterMs: 60_000,
				safeReason: 'Webhook request failed (HTTP_429)'
			})
		);

		await (
			worker as unknown as {
				handle: (kind: 'webhook', value: ConsumeMessage) => Promise<void>;
			}
		).handle('webhook', message());

		const receiptUpdate =
			transaction.integrationDeliveryReceipt.updateMany.mock.calls[0][0];
		expect(receiptUpdate.data).toMatchObject({
			status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
			retryAttempt: 1,
			retryAvailableAt: new Date('2026-08-04T12:01:00.000Z')
		});
		expect(receiptUpdate.data.retryToken).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
		const outbox =
			transaction.widgetsOutboxEvent.create.mock.calls[0][0].data;
		expect(outbox).toMatchObject({
			exchange: WidgetsOutboxExchange.RETRY,
			availableAt: new Date('2026-08-04T12:00:30.000Z'),
			headers: expect.objectContaining({
				'x-retry-attempt': 1,
				'x-error-category': IntegrationErrorCategory.RATE_LIMIT,
				'x-delivery-token': receiptUpdate.data.retryToken
			})
		});
		expect(
			transaction.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
	});

	it('poisons oversized content before parsing or delivery', async () => {
		const { worker, rabbit, delivery } = createWorker({
			RABBITMQ_MAX_MESSAGE_BYTES: '1024'
		});

		await (
			worker as unknown as {
				handle: (kind: 'webhook', value: ConsumeMessage) => Promise<void>;
			}
		).handle('webhook', message({}, Buffer.alloc(1025, 1)));

		expect(delivery.parse).not.toHaveBeenCalled();
		expect(delivery.deliver).not.toHaveBeenCalled();
		expect(rabbit.publish).toHaveBeenCalledWith(
			'winwidget.dead-letter',
			'widgets.webhook.dead-letter',
			expect.objectContaining({ contentBytes: 1025 }),
			expect.any(Object)
		);
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
	});

	afterEach(() => {
		jest.useRealTimers();
	});
});
