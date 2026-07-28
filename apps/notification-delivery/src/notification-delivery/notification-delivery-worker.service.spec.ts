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

	const createTelegramMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'telegram',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-27T10:00:00.000Z'
					},
					destination: { telegramChatId: '12345' }
				})
			),
			fields: {
				exchange: 'winwidget.events',
				routingKey: 'lead.integration.telegram.v2'
			},
			properties: {
				messageId: eventId,
				type: 'lead.integration.requested.v2',
				headers: {}
			}
		}) as ConsumeMessage;

	const createLimitTelegramMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 2,
					eventType: 'lead.limit.reached.telegram.v2',
					entity: {
						id: 'widget-1',
						name: 'Колесо',
						type: 'widget'
					},
					limit: 10,
					destination: { telegramChatId: '12345' }
				})
			),
			fields: {
				exchange: 'winwidget.events',
				routingKey: 'lead.limit.reached.telegram.v2'
			},
			properties: {
				messageId: eventId,
				type: 'lead.limit.reached.telegram.v2',
				headers: {}
			}
		}) as ConsumeMessage;

	const createPaymentTelegramMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					eventType: 'payment.notification.telegram.requested.v1',
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
						email: null,
						phone: null
					},
					destination: {
						telegramChatId: '-1001234567890',
						messageThreadId: 42
					}
				})
			),
			fields: {
				exchange: 'winwidget.events',
				routingKey: 'payment.notification.telegram.requested.v1'
			},
			properties: {
				messageId: eventId,
				type: 'payment.notification.telegram.requested.v1',
				headers: {}
			}
		}) as ConsumeMessage;

	const createCampaignEmailMessage = (): ConsumeMessage =>
		({
			content: Buffer.from(
				JSON.stringify({
					schemaVersion: 1,
					eventType: 'notification.campaign.email.requested.v1',
					reference: {
						type: 'mailing-delivery',
						id: '22222222-2222-4222-8222-222222222222',
						aggregateId: '33333333-3333-4333-8333-333333333333'
					},
					destination: { email: 'owner@example.com' },
					content: {
						subject: 'Новости',
						message: 'Текст рассылки'
					}
				})
			),
			fields: {
				exchange: 'winwidget.events',
				routingKey: 'notification.campaign.email.requested.v1'
			},
			properties: {
				messageId: eventId,
				type: 'notification.campaign.email.requested.v1',
				headers: {}
			}
		}) as ConsumeMessage;

	const createService = (configuredKinds?: string) => {
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
			markSuccessfulConsume: jest.fn(),
			setConsumerKinds: jest.fn()
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
			get: jest.fn((name: string) =>
				name === 'NOTIFICATION_DELIVERY_KINDS'
					? configuredKinds
					: undefined
			)
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

	it('subscribes to all owned queues and their DLQs by default', async () => {
		const { service, rabbitMq, heartbeat } = createService();

		await service.onModuleInit();

		expect(rabbitMq.consume).toHaveBeenCalledTimes(11);
		expect(rabbitMq.consumeDeadLetter).toHaveBeenCalledTimes(11);
		expect(
			(rabbitMq.consume as jest.Mock).mock.calls.map(call => call[0])
		).toEqual([
			'email',
			'telegram',
			'payment-email',
			'payment-telegram',
			'limit-email',
			'limit-telegram',
			'campaign-email',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram'
		]);
		expect(heartbeat.setConsumerKinds).toHaveBeenCalledWith([
			'email',
			'telegram',
			'payment-email',
			'payment-telegram',
			'limit-email',
			'limit-telegram',
			'campaign-email',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram'
		]);
	});

	it('subscribes only to the configured deduplicated subset', async () => {
		const { service, rabbitMq, heartbeat } = createService(
			'payment-telegram, limit-telegram,payment-telegram'
		);

		await service.onModuleInit();

		expect(
			(rabbitMq.consume as jest.Mock).mock.calls.map(call => call[0])
		).toEqual(['payment-telegram', 'limit-telegram']);
		expect(
			(rabbitMq.consumeDeadLetter as jest.Mock).mock.calls.map(
				call => call[0]
			)
		).toEqual(['payment-telegram', 'limit-telegram']);
		expect(heartbeat.setConsumerKinds).toHaveBeenCalledWith([
			'payment-telegram',
			'limit-telegram'
		]);
	});

	it.each(['', ' , '])(
		'rejects an explicitly empty consumer allowlist %p',
		async configuredKinds => {
			const { service, rabbitMq } = createService(configuredKinds);

			await expect(service.onModuleInit()).rejects.toThrow(
				'NOTIFICATION_DELIVERY_KINDS must not be empty'
			);
			expect(rabbitMq.consume).not.toHaveBeenCalled();
		}
	);

	it('rejects unknown consumer kinds before subscribing', async () => {
		const { service, rabbitMq } = createService(
			'email,legacy-payment-telegram'
		);

		await expect(service.onModuleInit()).rejects.toThrow(
			'NOTIFICATION_DELIVERY_KINDS contains unsupported kinds: legacy-payment-telegram'
		);
		expect(rabbitMq.consume).not.toHaveBeenCalled();
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

	it('emits a durable delivered outcome for campaign orchestration', async () => {
		const { service, rabbitMq, adapter, transaction } = createService();

		await (service as any).handle(
			'campaign-email',
			createCampaignEmailMessage()
		);

		expect(adapter.deliver).toHaveBeenCalledWith(
			'campaign-email',
			expect.objectContaining({
				reference: {
					type: 'mailing-delivery',
					id: '22222222-2222-4222-8222-222222222222',
					aggregateId: '33333333-3333-4333-8333-333333333333'
				}
			}),
			eventId,
			expect.any(String)
		);
		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					deduplicationKey: `notification:${eventId}:campaign-email:outcome:delivered:v1`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType: 'notification.delivery.outcome.v1',
					routingKey: 'notification.delivery.outcome.v1',
					payload: expect.objectContaining({
						sourceEventId: eventId,
						sourceKind: 'campaign-email',
						status: 'DELIVERED',
						failure: null
					})
				})
			],
			skipDuplicates: true
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
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

	it('emits a durable failed outcome with terminal campaign failure', async () => {
		const { service, rabbitMq, adapter, transaction } = createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Invalid envelope'), {
				code: 'EENVELOPE'
			})
		);

		await (service as any).handle(
			'campaign-email',
			createCampaignEmailMessage()
		);

		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					deduplicationKey: `notification:${eventId}:campaign-email:outcome:failed:v1`,
					eventType: 'notification.delivery.outcome.v1',
					routingKey: 'notification.delivery.outcome.v1',
					payload: expect.objectContaining({
						sourceEventId: eventId,
						sourceKind: 'campaign-email',
						status: 'FAILED',
						failure: {
							normalizedCode: 'SMTP_EENVELOPE',
							safeReason: 'SMTP rejected the message permanently'
						}
					})
				})
			],
			skipDuplicates: true
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('persists a destination-unavailable outcome atomically with a terminal Telegram failure', async () => {
		const { service, rabbitMq, adapter, prisma, transaction } =
			createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Telegram destination failed'), {
				httpStatus: 400,
				description: 'Bad Request: chat not found'
			})
		);

		await (service as any).handle('telegram', createTelegramMessage());

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
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: NotificationDeliveryExchange.DEAD_LETTER,
				routingKey: 'telegram.dead-letter'
			})
		});
		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					messageId: expect.any(String),
					deduplicationKey: `notification:${eventId}:telegram:telegram-destination-unavailable:v1`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType: 'notification.telegram.destination-unavailable.v1',
					routingKey: 'notification.telegram.destination-unavailable.v1',
					payload: {
						schemaVersion: 1,
						eventType: 'notification.telegram.destination-unavailable.v1',
						sourceEventId: eventId,
						sourceKind: 'telegram',
						destination: { telegramChatId: '12345' },
						normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
						occurredAt: expect.any(String)
					},
					headers: expect.objectContaining({
						'x-causation-id': eventId,
						'x-correlation-id': expect.any(String),
						'x-request-id': expect.any(String)
					})
				})
			],
			skipDuplicates: true
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('persists a destination-unavailable outcome for a terminal limit Telegram failure', async () => {
		const { service, adapter, transaction } = createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Telegram destination failed'), {
				httpStatus: 400,
				description: 'Bad Request: bot was blocked by the user'
			})
		);

		await (service as any).handle(
			'limit-telegram',
			createLimitTelegramMessage()
		);

		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					deduplicationKey: `notification:${eventId}:limit-telegram:telegram-destination-unavailable:v1`,
					payload: expect.objectContaining({
						sourceEventId: eventId,
						sourceKind: 'limit-telegram',
						destination: { telegramChatId: '12345' },
						normalizedCode: 'TELEGRAM_BOT_BLOCKED'
					})
				})
			],
			skipDuplicates: true
		});
	});

	it('does not create a destination-unavailable outcome for a transient Telegram retry', async () => {
		const { service, adapter, transaction } = createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Telegram temporarily unavailable'), {
				httpStatus: 503,
				description: 'Service Unavailable'
			})
		);

		await (service as any).handle('telegram', createTelegramMessage());

		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: NotificationDeliveryExchange.EVENTS,
				routingKey: 'manual.telegram'
			})
		});
		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).not.toHaveBeenCalled();
	});

	it('does not create a public-channel outcome for payment Telegram destination failures', async () => {
		const { service, adapter, transaction } = createService();
		(adapter.deliver as jest.Mock).mockRejectedValue(
			Object.assign(new Error('Telegram destination failed'), {
				httpStatus: 400,
				description: 'Bad Request: chat not found'
			})
		);

		await (service as any).handle(
			'payment-telegram',
			createPaymentTelegramMessage()
		);

		expect(
			transaction.notificationDeliveryOutboxEvent.create
		).toHaveBeenCalledWith({
			data: expect.objectContaining({
				exchange: NotificationDeliveryExchange.DEAD_LETTER,
				routingKey: 'payment-telegram.dead-letter'
			})
		});
		expect(
			transaction.notificationDeliveryOutboxEvent.createMany
		).not.toHaveBeenCalled();
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
