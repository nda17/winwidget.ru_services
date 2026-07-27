import {
	NotificationDeliveryExchange,
	NotificationDeliveryReceiptStatus
} from '@prisma/notification-delivery-client';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import type { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { RabbitMqService } from '../messaging/rabbitmq.service';
import type { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';

describe('NotificationDeliveryWorkerService', () => {
	const eventId = '11111111-1111-4111-8111-111111111111';

	const createPaymentMessage = (
		routingKey = 'payment.succeeded.v1'
	): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					eventType: 'payment.succeeded.v1',
					payment: {
						id: 'payment-1',
						yookassaId: 'yookassa-1',
						amount: '1000',
						plan: 'EASY',
						billingPeriod: 'MONTHLY',
						succeededAt: '2026-07-27T10:00:00.000Z'
					},
					user: {
						id: 'user-1',
						name: null,
						email: 'owner@example.com',
						phone: null
					},
					subscription: {
						expiresAt: '2026-08-27T10:00:00.000Z'
					}
				})
			),
			fields: {
				exchange: 'winwidget.events',
				routingKey
			},
			properties: {
				messageId: eventId,
				type: 'payment.succeeded.v1',
				headers: {}
			}
		}) as ConsumeMessage;

	const createService = () => {
		const rabbitMq = {
			consume: jest.fn().mockResolvedValue(undefined),
			consumeDeadLetter: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			nack: jest.fn(),
			cancelConsumers: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const adapter = {
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as NotificationDeliveryAdapterService;
		const heartbeat = {
			markSuccessfulConsume: jest.fn()
		} as unknown as NotificationDeliveryHeartbeatService;
		const receiptUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
		const failureUpsert = jest.fn().mockResolvedValue({});
		const outboxCreate = jest.fn().mockResolvedValue({});
		const transaction = {
			notificationDeliveryReceipt: {
				findUnique: jest.fn().mockResolvedValue({
					status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
				}),
				createMany: jest.fn().mockResolvedValue({ count: 0 }),
				updateMany: receiptUpdateMany
			},
			notificationDeliveryFailure: {
				findUnique: jest.fn().mockResolvedValue(null),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				upsert: failureUpsert
			},
			notificationDeliveryOutboxEvent: {
				create: outboxCreate,
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			notificationDeliveryReceipt: {
				create: jest.fn().mockResolvedValue({}),
				findUnique: jest.fn(),
				updateMany: receiptUpdateMany,
				deleteMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			notificationDeliveryOutboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as NotificationDeliveryPrismaService;
		const configService = {
			get: jest.fn()
		} as unknown as ConfigService;
		const service = new NotificationDeliveryWorkerService(
			rabbitMq,
			adapter,
			prisma,
			configService,
			heartbeat
		);

		return {
			service,
			rabbitMq,
			adapter,
			prisma,
			transaction,
			heartbeat
		};
	};

	beforeEach(() => {
		jest.restoreAllMocks();
	});

	it('subscribes to the four main queues and their DLQs', async () => {
		const { service, rabbitMq } = createService();

		await service.onModuleInit();

		expect(rabbitMq.consume).toHaveBeenCalledTimes(4);
		expect(rabbitMq.consumeDeadLetter).toHaveBeenCalledTimes(4);
		expect(
			(rabbitMq.consume as jest.Mock).mock.calls.map(call => call[0])
		).toEqual(['email', 'telegram', 'payment-email', 'limit-email']);
	});

	it('marks a successful provider delivery before acknowledging', async () => {
		const { service, rabbitMq, adapter, prisma, transaction } =
			createService();

		await (service as any).handle('payment-email', createPaymentMessage());

		expect(adapter.deliver).toHaveBeenCalledTimes(1);
		expect(prisma.notificationDeliveryReceipt.create).toHaveBeenCalledWith(
			{
				data: expect.objectContaining({
					eventId,
					consumer: 'payment-email',
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockedBy: expect.any(String),
					lockToken: expect.any(String),
					leaseExpiresAt: expect.any(Date)
				})
			}
		);
		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: expect.any(Date),
					lockToken: null
				})
			})
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('persists retry state and a manual-route outbox event atomically', async () => {
		const { service, rabbitMq, adapter, prisma, transaction } =
			createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('SMTP unavailable'), {
				code: 'ECONNECTION'
			})
		);

		await (service as any).handle('payment-email', createPaymentMessage());

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: 1,
					retryToken: expect.any(String)
				})
			})
		);
		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: eventId,
				exchange: NotificationDeliveryExchange.EVENTS,
				routingKey: 'manual.payment-email',
				headers: expect.objectContaining({
					'x-retry-attempt': 1,
					'x-delivery-token': expect.any(String)
				})
			})
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('persists terminal failure, receipt and DLQ outbox in one transaction', async () => {
		const { service, rabbitMq, adapter, prisma, transaction } =
			createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Invalid envelope'), {
				code: 'EENVELOPE'
			})
		);

		await (service as any).handle('payment-email', createPaymentMessage());

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
				})
			})
		);
		expect(
			transaction.notificationDeliveryFailure.upsert
		).toHaveBeenCalledTimes(1);
		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: NotificationDeliveryExchange.DEAD_LETTER,
				routingKey: 'payment-email.dead-letter'
			})
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('acks a DLQ message only after its canonical failure is persisted', async () => {
		const { service, rabbitMq, transaction } = createService();
		const message = createPaymentMessage('payment-email.dead-letter');
		message.fields.exchange = 'winwidget.dead-letter';
		message.properties.headers = {
			'x-retry-attempt': 2,
			'x-error-category': 'PERMANENT',
			'x-error-code': 'SMTP_REJECTED',
			'x-safe-reason': 'SMTP rejected the message',
			'x-error-retryable': false,
			'x-classification-version': 1
		};

		await (service as any).collectDeadLetter('payment-email', message);

		expect(
			transaction.notificationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					eventId,
					consumer: 'payment-email',
					attempts: 2,
					normalizedCode: 'SMTP_REJECTED'
				})
			})
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(
			transaction.notificationDeliveryFailure.upsert.mock
				.invocationCallOrder[0]
		).toBeLessThan(
			(rabbitMq.ack as jest.Mock).mock.invocationCallOrder[0]
		);
	});

	it('acks a stale DLQ copy without interrupting an active manual retry', async () => {
		const { service, rabbitMq, transaction } = createService();
		const activeRetryToken = '22222222-2222-4222-8222-222222222222';
		(
			transaction.notificationDeliveryReceipt.findUnique as jest.Mock
		).mockResolvedValue({
			status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
			retryToken: activeRetryToken
		});
		(
			transaction.notificationDeliveryFailure.findUnique as jest.Mock
		).mockResolvedValue({
			attempts: 1,
			firstFailedAt: new Date(),
			resolvedAt: null,
			retryingAt: new Date(),
			activeRetryToken
		});
		const message = createPaymentMessage('payment-email.dead-letter');
		message.fields.exchange = 'winwidget.dead-letter';

		await (service as any).collectDeadLetter('payment-email', message);

		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).not.toHaveBeenCalled();
		expect(
			transaction.notificationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('persists a malformed message with a bounded fallback event type', async () => {
		const { service, rabbitMq, transaction } = createService();
		const message = createPaymentMessage();
		message.content = Buffer.from('{');
		message.properties.type = '   ';

		await (service as any).handle('payment-email', message);

		expect(
			transaction.notificationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					eventId,
					consumer: 'payment-email',
					normalizedCode: 'INVALID_EVENT_PAYLOAD'
				})
			})
		);
		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					eventType: 'unknown',
					routingKey: 'payment-email.dead-letter'
				})
			],
			skipDuplicates: true
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('never persists or logs malformed payload contents through parser errors', async () => {
		const { service, transaction } = createService();
		const secretBody = 'SECRET_PASSWORD=top-secret-value';
		const message = createPaymentMessage();
		message.content = Buffer.from(secretBody);
		const logError = jest
			.spyOn((service as any).logger, 'error')
			.mockImplementation();

		await (service as any).handle('payment-email', message);

		expect(
			transaction.notificationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					payload: {
						malformed: true,
						contentLength: Buffer.byteLength(secretBody)
					},
					lastError: 'Notification payload failed contract validation',
					safeReason: 'Notification payload failed contract validation',
					normalizedCode: 'INVALID_EVENT_PAYLOAD',
					headers: expect.objectContaining({
						'x-last-error':
							'Notification payload failed contract validation',
						'x-safe-reason':
							'Notification payload failed contract validation'
					})
				})
			})
		);
		const durableAndLoggedState = JSON.stringify([
			transaction.notificationDeliveryFailure.upsert.mock.calls,
			transaction.notificationDeliveryOutboxEvent.createMany.mock.calls,
			logError.mock.calls
		]);
		expect(durableAndLoggedState).not.toContain(secretBody);
		expect(durableAndLoggedState).not.toContain('SECRET_PASSWORD');
	});

	it.each([
		NotificationDeliveryReceiptStatus.PROCESSING,
		NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
		NotificationDeliveryReceiptStatus.DELIVERED,
		NotificationDeliveryReceiptStatus.CLOSED_NO_RETRY
	])(
		'acks malformed duplicates without replacing an active %s receipt',
		async status => {
			const { service, rabbitMq, transaction } = createService();
			(
				transaction.notificationDeliveryReceipt.findUnique as jest.Mock
			).mockResolvedValue({ status });
			const message = createPaymentMessage();
			message.content = Buffer.from('{');

			await (service as any).handle('payment-email', message);

			expect(
				transaction.notificationDeliveryReceipt.updateMany
			).not.toHaveBeenCalled();
			expect(
				transaction.notificationDeliveryFailure.upsert
			).not.toHaveBeenCalled();
			expect(
				transaction.notificationDeliveryOutboxEvent.createMany
			).not.toHaveBeenCalled();
			expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
			expect(rabbitMq.nack).not.toHaveBeenCalled();
		}
	);

	it('does not reopen a DLQ failure when the receipt CAS is lost', async () => {
		const { service, rabbitMq, transaction } = createService();
		(
			transaction.notificationDeliveryReceipt.updateMany as jest.Mock
		).mockResolvedValueOnce({ count: 0 });
		const message = createPaymentMessage('payment-email.dead-letter');
		message.fields.exchange = 'winwidget.dead-letter';

		await (service as any).collectDeadLetter('payment-email', message);

		expect(
			transaction.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
				})
			})
		);
		expect(
			transaction.notificationDeliveryFailure.findUnique
		).not.toHaveBeenCalled();
		expect(
			transaction.notificationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('normalizes an out-of-range DLQ HTTP status before persistence', async () => {
		const { service, transaction } = createService();
		const message = createPaymentMessage('payment-email.dead-letter');
		message.fields.exchange = 'winwidget.dead-letter';
		message.properties.headers = {
			'x-http-status': 99
		};

		await (service as any).collectDeadLetter('payment-email', message);

		expect(
			transaction.notificationDeliveryFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					httpStatus: null
				}),
				update: expect.objectContaining({
					httpStatus: null
				})
			})
		);
	});

	it('locks the receipt before reading and updating the DLQ failure', async () => {
		const { service, transaction } = createService();
		const message = createPaymentMessage('payment-email.dead-letter');
		message.fields.exchange = 'winwidget.dead-letter';

		await (service as any).collectDeadLetter('payment-email', message);

		expect(
			transaction.notificationDeliveryReceipt.updateMany.mock
				.invocationCallOrder[0]
		).toBeLessThan(
			transaction.notificationDeliveryFailure.findUnique.mock
				.invocationCallOrder[0]
		);
		expect(
			transaction.notificationDeliveryReceipt.updateMany.mock
				.invocationCallOrder[0]
		).toBeLessThan(
			transaction.notificationDeliveryFailure.upsert.mock
				.invocationCallOrder[0]
		);
	});
});
