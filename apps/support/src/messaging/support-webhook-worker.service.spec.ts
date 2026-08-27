import {
	ConsumerReceiptStatus,
	OutboxExchange,
	SupportInboxOutcome,
	SupportInboxStatus,
	SupportMappingKind
} from '@prisma/support-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import type { SupportRuntimeService } from '../runtime/support-runtime.service';
import { SupportTelegramError } from '../telegram/support-telegram.transport';
import type { SupportTelegramOutboundService } from '../telegram/support-telegram-outbound.service';
import {
	SUPPORT_DEAD_ROUTING_KEY,
	SUPPORT_WEBHOOK_CONSUMER,
	SUPPORT_WEBHOOK_EVENT,
	SUPPORT_WEBHOOK_ROUTING_KEY,
	supportRetryRoutingKey
} from './support-messaging.constants';
import type { SupportRabbitMqService } from './support-rabbitmq.service';
import { SupportWebhookWorkerService } from './support-webhook-worker.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const INBOX_ID = '22222222-2222-4222-8222-222222222222';
const DELIVERY_TOKEN = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const OCCURRED_AT = '2026-08-24T00:00:00.000Z';

interface WorkerHandle {
	handle(message: ConsumeMessage): Promise<void>;
}

interface MessageFixture {
	bodyHash: string;
	event: {
		bodyHash: string;
		eventId: string;
		eventType: typeof SUPPORT_WEBHOOK_EVENT;
		inboxId: string;
		occurredAt: string;
		schemaVersion: 1;
		updateId: string;
	};
	message: ConsumeMessage;
	rawPayload: Buffer;
}

function messageFixture(
	update: Record<string, unknown>,
	headers: Record<string, string | number | boolean> = {},
	routingKey = SUPPORT_WEBHOOK_ROUTING_KEY
): MessageFixture {
	const rawPayload = Buffer.from(JSON.stringify(update));
	const bodyHash = createHash('sha256').update(rawPayload).digest('hex');
	const event: MessageFixture['event'] = {
		bodyHash,
		eventId: EVENT_ID,
		eventType: SUPPORT_WEBHOOK_EVENT,
		inboxId: INBOX_ID,
		occurredAt: OCCURRED_AT,
		schemaVersion: 1 as const,
		updateId: String(update.update_id)
	};
	const message = {
		content: Buffer.from(JSON.stringify(event)),
		fields: {
			consumerTag: 'support-worker-spec',
			deliveryTag: 1,
			redelivered: false,
			exchange: 'winwidget.events',
			routingKey
		},
		properties: {
			appId: undefined,
			clusterId: undefined,
			contentEncoding: 'utf-8',
			contentType: 'application/json',
			correlationId: CORRELATION_ID,
			deliveryMode: 2,
			expiration: undefined,
			headers: {
				'x-correlation-id': CORRELATION_ID,
				...headers
			},
			messageId: EVENT_ID,
			priority: undefined,
			replyTo: undefined,
			timestamp: 0,
			type: SUPPORT_WEBHOOK_EVENT,
			userId: undefined
		}
	} as unknown as ConsumeMessage;
	return { bodyHash, event, message, rawPayload };
}

function privateUpdate(text = 'Нужна помощь'): Record<string, unknown> {
	return {
		update_id: 42,
		message: {
			message_id: 7,
			from: {
				id: 99,
				username: 'customer',
				first_name: 'Иван',
				last_name: 'Иванов'
			},
			chat: { id: 100, type: 'private' },
			text
		}
	};
}

function ignoredUpdate(): Record<string, unknown> {
	return {
		update_id: 42,
		message: {
			message_id: 7,
			chat: { id: -100, type: 'channel' },
			text: 'ignored'
		}
	};
}

function setup(fixture: MessageFixture) {
	const payloadHash = createHash('sha256')
		.update(fixture.message.content)
		.digest('hex');
	const receipt = {
		eventId: EVENT_ID,
		consumer: SUPPORT_WEBHOOK_CONSUMER,
		payloadHash,
		status: ConsumerReceiptStatus.PROCESSING as ConsumerReceiptStatus,
		lockToken: DELIVERY_TOKEN,
		leaseExpiresAt: new Date(0),
		manualRetryCycle: 0
	};
	const transaction = {
		consumerReceipt: {
			createMany: jest.fn().mockResolvedValue({ count: 1 }),
			findUniqueOrThrow: jest.fn().mockResolvedValue(receipt),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		telegramWebhookInbox: {
			findUnique: jest.fn().mockResolvedValue({
				id: INBOX_ID,
				updateId: 42n,
				bodyHash: fixture.bodyHash
			}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		supportMessageMapping: {
			createMany: jest.fn().mockResolvedValue({ count: 2 })
		},
		consumerFailure: {
			upsert: jest.fn().mockResolvedValue({}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		outboxEvent: {
			create: jest.fn().mockResolvedValue({}),
			createMany: jest.fn().mockResolvedValue({ count: 1 })
		}
	};
	const prisma = {
		$transaction: jest.fn(
			async (
				callback: (value: typeof transaction) => Promise<unknown> | unknown
			) => callback(transaction)
		),
		telegramWebhookInbox: {
			findUniqueOrThrow: jest.fn().mockResolvedValue({
				rawPayload: fixture.rawPayload,
				bodyHash: fixture.bodyHash
			})
		},
		routingSettings: {
			findUniqueOrThrow: jest.fn().mockResolvedValue({
				id: 'singleton',
				adminChatId: '-100500',
				supportThreadId: 77
			})
		},
		supportMessageMapping: {
			findUnique: jest.fn()
		}
	} as unknown as SupportPrismaService;
	const rabbit = {
		ack: jest.fn(),
		nack: jest.fn(),
		isConsumerReady: jest.fn().mockReturnValue(true)
	} as unknown as SupportRabbitMqService;
	const outbound = {
		copyMessage: jest.fn().mockResolvedValue({ messageId: 501 }),
		sendMessage: jest
			.fn()
			.mockResolvedValueOnce({ messageId: 502 })
			.mockResolvedValue({ messageId: 503 })
	} as unknown as SupportTelegramOutboundService;
	const service = new SupportWebhookWorkerService(
		prisma,
		{
			inboxLeaseMs: 60_000,
			workerEnabled: true
		} as SupportRuntimeService,
		rabbit,
		outbound
	);
	const handle = (service as unknown as WorkerHandle).handle.bind(service);
	return {
		handle,
		outbound: outbound as unknown as {
			copyMessage: jest.Mock;
			sendMessage: jest.Mock;
		},
		prisma: prisma as unknown as {
			$transaction: jest.Mock;
			routingSettings: { findUniqueOrThrow: jest.Mock };
			telegramWebhookInbox: { findUniqueOrThrow: jest.Mock };
		},
		rabbit: rabbit as unknown as {
			ack: jest.Mock;
			nack: jest.Mock;
		},
		receipt,
		transaction
	};
}

describe('SupportWebhookWorkerService', () => {
	it('acks an already delivered duplicate without another external call', async () => {
		const fixture = messageFixture(privateUpdate());
		const context = setup(fixture);
		context.receipt.status = ConsumerReceiptStatus.DELIVERED;

		await context.handle(fixture.message);

		expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
		expect(context.rabbit.nack).not.toHaveBeenCalled();
		expect(context.outbound.copyMessage).not.toHaveBeenCalled();
		expect(context.outbound.sendMessage).not.toHaveBeenCalled();
		expect(
			context.prisma.telegramWebhookInbox.findUniqueOrThrow
		).not.toHaveBeenCalled();
	});

	it('nacks with requeue while another valid receipt lease is busy', async () => {
		const fixture = messageFixture(privateUpdate());
		const context = setup(fixture);
		context.receipt.leaseExpiresAt = new Date(Date.now() + 60_000);
		context.transaction.consumerReceipt.updateMany.mockResolvedValueOnce({
			count: 0
		});

		await context.handle(fixture.message);

		expect(context.rabbit.nack).toHaveBeenCalledWith(
			fixture.message,
			true
		);
		expect(context.rabbit.ack).not.toHaveBeenCalled();
		expect(context.outbound.copyMessage).not.toHaveBeenCalled();
		expect(
			context.transaction.telegramWebhookInbox.updateMany
		).not.toHaveBeenCalled();
	});

	it('parks a receipt payload mismatch in the DLQ before acking', async () => {
		const fixture = messageFixture(privateUpdate());
		const context = setup(fixture);
		context.receipt.payloadHash = 'f'.repeat(64);

		await context.handle(fixture.message);

		expect(
			context.transaction.consumerFailure.upsert
		).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					eventId: EVENT_ID,
					eventType: 'support.poison.v1'
				})
			})
		);
		expect(
			context.transaction.outboxEvent.createMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						exchange: OutboxExchange.DEAD_LETTER,
						routingKey: SUPPORT_DEAD_ROUTING_KEY
					})
				]
			})
		);
		expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
		expect(context.outbound.copyMessage).not.toHaveBeenCalled();
	});

	it('claims, delivers through Telegram, and atomically stores outcome and mappings', async () => {
		const fixture = messageFixture(privateUpdate());
		const context = setup(fixture);

		await context.handle(fixture.message);

		expect(context.outbound.copyMessage).toHaveBeenCalledWith(
			INBOX_ID,
			`${EVENT_ID}:user-copy`,
			expect.objectContaining({
				chatId: '-100500',
				fromChatId: '100',
				messageId: 7,
				messageThreadId: 77
			})
		);
		expect(context.outbound.sendMessage).toHaveBeenCalledTimes(2);
		expect(
			context.transaction.supportMessageMapping.createMany
		).toHaveBeenCalledWith({
			data: expect.arrayContaining([
				expect.objectContaining({
					inboxId: INBOX_ID,
					kind: SupportMappingKind.USER_COPY,
					adminMessageId: 501,
					userChatId: '100'
				}),
				expect.objectContaining({
					inboxId: INBOX_ID,
					kind: SupportMappingKind.USER_CONTEXT,
					adminMessageId: 502,
					userChatId: '100'
				})
			]),
			skipDuplicates: true
		});
		expect(
			context.transaction.telegramWebhookInbox.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: SupportInboxStatus.DELIVERED,
					outcome: SupportInboxOutcome.USER_MESSAGE_FORWARDED
				})
			})
		);
		expect(
			context.transaction.consumerReceipt.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: ConsumerReceiptStatus.DELIVERED
				})
			})
		);
		expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
	});

	it('schedules the exact retry transaction after a retryable Telegram failure', async () => {
		const fixture = messageFixture(privateUpdate());
		const context = setup(fixture);
		context.outbound.copyMessage.mockRejectedValueOnce(
			new SupportTelegramError('temporary Telegram failure', true)
		);

		await context.handle(fixture.message);

		const outbox =
			context.transaction.outboxEvent.create.mock.calls[0][0].data;
		expect(outbox).toMatchObject({
			messageId: EVENT_ID,
			deduplicationKey: `${EVENT_ID}:retry:0:1`,
			exchange: OutboxExchange.RETRY,
			routingKey: supportRetryRoutingKey(1),
			aggregateId: '42'
		});
		expect(outbox.headers).toMatchObject({
			'x-correlation-id': CORRELATION_ID,
			'x-retry-attempt': 1,
			'x-delivery-token': expect.any(String)
		});
		expect(
			context.transaction.consumerReceipt.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: ConsumerReceiptStatus.RETRY_SCHEDULED,
					lockToken: outbox.headers['x-delivery-token']
				})
			})
		);
		expect(
			context.transaction.telegramWebhookInbox.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: SupportInboxStatus.RETRY_SCHEDULED
				})
			})
		);
		expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
		expect(context.rabbit.nack).not.toHaveBeenCalled();
	});

	it.each([
		{ attempt: 0, retryable: false, label: 'permanent' },
		{ attempt: 3, retryable: true, label: 'exhausted' }
	])(
		'dead-letters a $label Telegram failure',
		async ({ attempt, retryable }) => {
			const fixture = messageFixture(privateUpdate(), {
				'x-delivery-token': DELIVERY_TOKEN,
				'x-retry-attempt': attempt
			});
			const context = setup(fixture);
			context.outbound.copyMessage.mockRejectedValueOnce(
				new SupportTelegramError('terminal Telegram failure', retryable)
			);

			await context.handle(fixture.message);

			expect(context.transaction.outboxEvent.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						deduplicationKey: `${EVENT_ID}:dead-letter:0`,
						exchange: OutboxExchange.DEAD_LETTER,
						routingKey: SUPPORT_DEAD_ROUTING_KEY
					})
				})
			);
			expect(
				context.transaction.consumerReceipt.updateMany
			).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					data: expect.objectContaining({
						status: ConsumerReceiptStatus.DEAD_LETTERED,
						lockToken: null
					})
				})
			);
			expect(
				context.transaction.telegramWebhookInbox.updateMany
			).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					data: expect.objectContaining({
						status: SupportInboxStatus.DEAD_LETTERED
					})
				})
			);
			expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
		}
	);

	it('claims a manual retry only through its receipt token CAS', async () => {
		const fixture = messageFixture(
			ignoredUpdate(),
			{ 'x-delivery-token': DELIVERY_TOKEN },
			SUPPORT_WEBHOOK_CONSUMER
		);
		const context = setup(fixture);
		context.receipt.status = ConsumerReceiptStatus.DEAD_LETTERED;
		context.receipt.manualRetryCycle = 2;

		await context.handle(fixture.message);

		expect(
			context.transaction.consumerReceipt.updateMany
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						{
							status: ConsumerReceiptStatus.DEAD_LETTERED,
							lockToken: DELIVERY_TOKEN
						}
					])
				}),
				data: expect.objectContaining({
					lockToken: DELIVERY_TOKEN,
					status: ConsumerReceiptStatus.PROCESSING
				})
			})
		);
		expect(
			context.transaction.telegramWebhookInbox.updateMany
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						{ status: SupportInboxStatus.DEAD_LETTERED }
					])
				}),
				data: expect.objectContaining({
					leaseToken: DELIVERY_TOKEN,
					status: SupportInboxStatus.PROCESSING
				})
			})
		);
		expect(
			context.transaction.telegramWebhookInbox.updateMany
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({
					status: SupportInboxStatus.IGNORED,
					outcome: SupportInboxOutcome.IGNORED_CHAT
				})
			})
		);
		expect(context.rabbit.ack).toHaveBeenCalledWith(fixture.message);
	});

	it('nacks after an external call when durable completion and failure state both crash', async () => {
		const fixture = messageFixture(privateUpdate('/start'));
		const context = setup(fixture);
		let transactionCall = 0;
		context.prisma.$transaction.mockImplementation(
			async (
				callback: (
					value: typeof context.transaction
				) => Promise<unknown> | unknown
			) => {
				transactionCall += 1;
				if (transactionCall > 1) {
					throw new Error('support database unavailable');
				}
				return callback(context.transaction);
			}
		);

		await context.handle(fixture.message);

		expect(context.outbound.sendMessage).toHaveBeenCalledTimes(1);
		expect(context.rabbit.nack).toHaveBeenCalledWith(
			fixture.message,
			true
		);
		expect(context.rabbit.ack).not.toHaveBeenCalled();
		expect(transactionCall).toBe(3);
	});
});
