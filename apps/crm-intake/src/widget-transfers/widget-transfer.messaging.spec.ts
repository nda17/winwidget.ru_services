import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { WidgetTransferPublisher } from './widget-transfer.publisher';
import { WidgetTransferWorker } from './widget-transfer.worker';
import {
	WidgetTransferRabbit,
	TRANSFER_EVENT_TYPE,
	TRANSFER_EXCHANGE,
	TRANSFER_DEAD_EXCHANGE,
	TRANSFER_QUEUE,
	TRANSFER_DEAD_QUEUE,
	TRANSFER_UPSTREAM_EXCHANGE
} from './widget-transfer.messaging';
import { WidgetTransferProcessor } from './widget-transfer.processor';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';

import { intakeProcessRole } from '../acceptance/acceptance.messaging';

const mockReturn = {
	handler: null as null | ((value: unknown) => void),
	enabled: false
};
const mockChannel = {
	on: jest.fn((event, handler) => {
		if (event === 'return') mockReturn.handler = handler;
	}),
	once: jest.fn(),
	assertExchange: jest.fn(),
	assertQueue: jest.fn(),
	bindQueue: jest.fn(),
	prefetch: jest.fn(),
	ack: jest.fn(),
	nack: jest.fn(),
	cancel: jest.fn().mockResolvedValue(undefined),
	close: jest.fn().mockResolvedValue(undefined),
	consume: jest.fn().mockResolvedValue({ consumerTag: 'tag' })
};
const mockWrapper = {
	on: jest.fn(),
	waitForConnect: jest.fn(),
	addSetup: jest.fn(async fn => fn(mockChannel)),
	close: jest.fn(),
	publish: jest.fn(async (_exchange, _key, _body, properties) => {
		if (mockReturn.enabled) mockReturn.handler?.({ properties });
		return true;
	})
};
const mockConnection = {
	on: jest.fn(),
	connect: jest.fn(),
	close: jest.fn(),
	isConnected: jest.fn().mockReturnValue(true),
	createChannel: jest.fn(options => {
		void options.setup(mockChannel);
		return mockWrapper;
	})
};
jest.mock('amqp-connection-manager', () => ({
	connect: () => mockConnection
}));

const event = () => ({
	schemaVersion: 1 as const,
	eventId: randomUUID(),
	workspaceId: randomUUID(),
	sourceId: randomUUID(),
	eventType: 'widgets.wincrm.lead-transfer.requested.v1' as const,
	occurredAt: new Date().toISOString(),
	transferId: randomUUID(),
	connectorId: randomUUID(),
	originalSubscriptionId: null,
	originalSubscriptionVersion: null,
	originalPeriodStartsAt: null,
	originalDeadline: null,
	generation: 1
});
describe('durable Widget transfer messaging', () => {
	const env = process.env;
	beforeEach(() => {
		process.env = {
			...env,
			CRM_INTAKE_RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1/isolated_test',
			CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'false',
			CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'true',
			CRM_INTAKE_WIDGETS_ENABLED: 'true'
		};
		jest.clearAllMocks();
		mockReturn.enabled = false;
	});
	afterEach(() => {
		process.env = env;
	});
	it('publishes a Buffer with confirms and fails mandatory-return before a success can be recorded', async () => {
		const rabbit = new WidgetTransferRabbit();
		await rabbit.onModuleInit();
		await rabbit.publish(event(), 'MAIN', 0);
		expect(mockConnection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true })
		);
		expect(mockWrapper.publish).toHaveBeenCalledWith(
			expect.any(String),
			TRANSFER_EVENT_TYPE,
			expect.any(Buffer),
			expect.objectContaining({ mandatory: true, persistent: true })
		);
		mockReturn.enabled = true;
		await expect(rabbit.publish(event(), 'MAIN', 0)).rejects.toThrow(
			'MANDATORY_RETURN'
		);
		await rabbit.onApplicationShutdown();
	});
	it('keeps Outbox PENDING indefinitely on a transport failure even after many attempts', async () => {
		const value = event();
		const row = {
			id: randomUUID(),
			eventId: value.eventId,
			payload: value,
			route: 'MAIN',
			retryAttempt: 0,
			attempts: 100000,
			leaseToken: ''
		};
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ now: new Date() }]),
			widgetTransferOutbox: {
				updateMany: jest.fn(async args => {
					if (args.data.status === 'PUBLISHING')
						row.leaseToken = args.data.leaseToken;
					return { count: 1 };
				}),
				findMany: jest.fn().mockResolvedValue([{ id: row.id }]),
				findUnique: jest.fn().mockResolvedValue(row)
			}
		};
		const rabbit = {
			publish: jest
				.fn()
				.mockRejectedValue(new Error('transport private details'))
		};
		await new WidgetTransferPublisher(
			prisma as never,
			rabbit as never
		).tick();
		expect(
			prisma.widgetTransferOutbox.updateMany
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					lastErrorCode: 'PUBLICATION_UNCONFIRMED'
				})
			})
		);
		expect(
			prisma.widgetTransferOutbox.updateMany.mock.calls.some(
				([args]) => args.data.status === 'PUBLISHED'
			)
		).toBe(false);
	});
	it('provisions only main/DLQ queues with no TTL dead-letter relay', async () => {
		const rabbit = new WidgetTransferRabbit();
		await (
			rabbit as unknown as { topology(channel: unknown): Promise<void> }
		).topology(mockChannel);
		expect(mockChannel.assertExchange.mock.calls).toEqual([
			[TRANSFER_EXCHANGE, 'direct', { durable: true }],
			[TRANSFER_DEAD_EXCHANGE, 'direct', { durable: true }],
			[TRANSFER_UPSTREAM_EXCHANGE, 'topic', { durable: true }]
		]);
		expect(mockChannel.assertQueue.mock.calls).toEqual([
			[TRANSFER_QUEUE, { durable: true }],
			[TRANSFER_DEAD_QUEUE, { durable: true }]
		]);
		await rabbit.onModuleInit();
		await expect(rabbit.publish(event(), 'RETRY_1', 1)).rejects.toThrow(
			'INVALID_ROUTE'
		);
		await rabbit.publish(event(), 'MAIN', 1, 2);
		expect(mockWrapper.publish).toHaveBeenLastCalledWith(
			TRANSFER_EXCHANGE,
			TRANSFER_EVENT_TYPE,
			expect.any(Buffer),
			expect.objectContaining({
				mandatory: true,
				headers: expect.objectContaining({
					'x-retry-attempt': 1,
					'x-wincrm-transfer-retry-generation': 2
				})
			})
		);
		await rabbit.onApplicationShutdown();
	});
	it('uses database time for due selection, independently of a fast publisher clock', async () => {
		const databaseNow = new Date('2026-01-01T00:00:00.000Z');
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ now: databaseNow }]),
			widgetTransferOutbox: {
				updateMany: jest.fn(),
				findMany: jest.fn().mockResolvedValue([])
			}
		};
		const rabbit = { publish: jest.fn() };
		await new WidgetTransferPublisher(
			prisma as never,
			rabbit as never
		).tick();
		expect(prisma.widgetTransferOutbox.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { status: 'PENDING', availableAt: { lte: databaseNow } }
			})
		);
		expect(rabbit.publish).not.toHaveBeenCalled();
	});
	it('acknowledges only after the durable work succeeds, and quarantines poison without PII', async () => {
		const processor = {
			claim: jest
				.fn()
				.mockResolvedValue({ state: 'CLAIMED', token: randomUUID() }),
			run: jest.fn().mockResolvedValue(undefined),
			fail: jest.fn(),
			renew: jest.fn()
		};
		const rabbit = { ack: jest.fn(), nack: jest.fn() };
		const prisma = { widgetTransferOutbox: { createMany: jest.fn() } };
		const worker = new WidgetTransferWorker(
			processor as never,
			rabbit as never,
			prisma as never
		);
		const value = event();
		const message = {
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: TRANSFER_EVENT_TYPE,
				contentType: 'application/json'
			}
		};
		await worker.handle(message as never);
		expect(processor.run.mock.invocationCallOrder[0]).toBeLessThan(
			rabbit.ack.mock.invocationCallOrder[0]
		);
		await worker.handle({
			...message,
			content: Buffer.from('private phone +79000000001')
		} as never);
		expect(
			JSON.stringify(prisma.widgetTransferOutbox.createMany.mock.calls)
		).not.toContain('+79000000001');
		expect(prisma.widgetTransferOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true })
		);
	});
	it.each(['leased', 'database failure'])(
		'keeps %s handling rejections unacked for five seconds before requeue',
		async reason => {
			jest.useFakeTimers();
			const rabbit = new WidgetTransferRabbit();
			try {
				await rabbit.onModuleInit();
				await rabbit.consume(async () => {
					throw new Error(reason);
				});
				const deliver = mockChannel.consume.mock.calls[0][1];
				const message = { content: Buffer.from('{}'), properties: {} };
				deliver(message);
				await jest.advanceTimersByTimeAsync(4999);
				expect(mockChannel.ack).not.toHaveBeenCalled();
				expect(mockChannel.nack).not.toHaveBeenCalled();
				await jest.advanceTimersByTimeAsync(1);
				expect(mockChannel.nack).toHaveBeenCalledTimes(1);
				expect(mockChannel.nack).toHaveBeenCalledWith(
					message,
					false,
					true
				);
			} finally {
				await rabbit.onApplicationShutdown();
				jest.useRealTimers();
			}
		}
	);
	it('interrupts all five unacked waits on shutdown without waiting for timers or acknowledging failures', async () => {
		jest.useFakeTimers();
		const rabbit = new WidgetTransferRabbit();
		try {
			await rabbit.onModuleInit();
			await rabbit.consume(async () => {
				throw new Error('leased');
			});
			const deliver = mockChannel.consume.mock.calls[0][1];
			for (let index = 0; index < 5; index++)
				deliver({ content: Buffer.from('{}'), properties: {} });
			await jest.advanceTimersByTimeAsync(0);
			expect(mockChannel.prefetch).toHaveBeenCalledWith(5, false);
			expect(mockChannel.nack).not.toHaveBeenCalled();
			mockChannel.cancel.mockRejectedValueOnce(
				new Error('channel closed')
			);
			await rabbit.cancel();
			expect(mockChannel.nack).toHaveBeenCalledTimes(5);
			expect(mockChannel.ack).not.toHaveBeenCalled();
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			await rabbit.onApplicationShutdown();
			jest.useRealTimers();
		}
	});
	it('uses the same delayed requeue when failed work cannot commit its durable outcome', async () => {
		const processor = {
			claim: jest
				.fn()
				.mockResolvedValue({ state: 'CLAIMED', token: randomUUID() }),
			run: jest.fn().mockRejectedValue(new Error('dependency')),
			fail: jest.fn().mockResolvedValue(false),
			renew: jest.fn()
		};
		const rabbit = {
			ack: jest.fn(),
			nack: jest.fn(),
			nackAfterBackoff: jest.fn().mockResolvedValue(undefined)
		};
		const value = event();
		const message = {
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: TRANSFER_EVENT_TYPE,
				contentType: 'application/json'
			}
		};
		await new WidgetTransferWorker(
			processor as never,
			rabbit as never,
			{} as never
		).handle(message as never);
		expect(rabbit.nackAfterBackoff).toHaveBeenCalledWith(message);
		expect(rabbit.ack).not.toHaveBeenCalled();
		expect(rabbit.nack).not.toHaveBeenCalled();
	});
	it('drains the active push consumer before Nest disconnects the Prisma pool', async () => {
		let deliver: (message: never) => Promise<void> = async () => {};
		let finish: () => void = () => {};
		const pending = new Promise<void>(resolve => {
			finish = resolve;
		});
		const order: string[] = [];
		const processor = {
			claim: jest
				.fn()
				.mockResolvedValue({ state: 'CLAIMED', token: randomUUID() }),
			run: jest.fn(() => pending),
			renew: jest.fn(),
			fail: jest.fn()
		};
		const rabbit = {
			consume: jest.fn(async handler => {
				deliver = handler;
			}),
			cancel: jest.fn(async () => {
				order.push('cancel');
			}),
			ack: jest.fn(() => order.push('ack')),
			nack: jest.fn(),
			onApplicationShutdown: () => {
				order.push('broker-close');
			}
		};
		const prisma = {
			onApplicationShutdown: () => {
				order.push('db-close');
			}
		};
		const module = await Test.createTestingModule({
			providers: [
				WidgetTransferWorker,
				{ provide: WidgetTransferProcessor, useValue: processor },
				{ provide: WidgetTransferRabbit, useValue: rabbit },
				{ provide: CrmIntakePrismaService, useValue: prisma }
			]
		}).compile();
		await module.init();
		const value = event();
		const task = deliver({
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: TRANSFER_EVENT_TYPE,
				contentType: 'application/json'
			}
		} as never);
		await new Promise(resolve => setImmediate(resolve));
		const closing = module.close();
		await new Promise(resolve => setImmediate(resolve));
		expect(order).toEqual(['cancel']);
		finish();
		await task;
		await closing;
		expect(order.indexOf('ack')).toBeLessThan(order.indexOf('db-close'));
		expect(
			typeof CrmIntakePrismaService.prototype.onApplicationShutdown
		).toBe('function');
		expect('onModuleDestroy' in CrmIntakePrismaService.prototype).toBe(
			false
		);
	});
	it('drains an in-flight lease renewal even after the business handler finishes', async () => {
		jest.useFakeTimers();
		try {
			let finish: () => void = () => {};
			let finishRenewal: (value: boolean) => void = () => {};
			const run = new Promise<void>(resolve => {
				finish = resolve;
			});
			const renewal = new Promise<boolean>(resolve => {
				finishRenewal = resolve;
			});
			const processor = {
				claim: jest
					.fn()
					.mockResolvedValue({ state: 'CLAIMED', token: randomUUID() }),
				run: jest.fn(() => run),
				renew: jest.fn(() => renewal),
				fail: jest.fn()
			};
			let deliver: (message: never) => Promise<void> = async () => {};
			const rabbit = {
				consume: jest.fn(async handler => {
					deliver = handler;
				}),
				cancel: jest.fn(),
				ack: jest.fn(),
				nack: jest.fn()
			};
			const worker = new WidgetTransferWorker(
				processor as never,
				rabbit as never,
				{} as never
			);
			await worker.onApplicationBootstrap();
			const value = event();
			const task = deliver({
				content: Buffer.from(JSON.stringify(value)),
				properties: {
					messageId: value.eventId,
					type: TRANSFER_EVENT_TYPE,
					contentType: 'application/json'
				}
			} as never);
			await jest.advanceTimersByTimeAsync(10000);
			expect(processor.renew).toHaveBeenCalledTimes(1);
			finish();
			await jest.advanceTimersByTimeAsync(0);
			let drained = false;
			const stopping = worker.beforeApplicationShutdown().then(() => {
				drained = true;
			});
			await jest.advanceTimersByTimeAsync(0);
			expect(drained).toBe(false);
			finishRenewal(true);
			await task;
			await stopping;
			expect(drained).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});
	it('makes non-API roles explicit and rejects unknown role configuration', () => {
		process.env.CRM_INTAKE_PROCESS_ROLE = 'worker';
		expect(intakeProcessRole()).toBe('worker');
		process.env.CRM_INTAKE_PROCESS_ROLE = 'arbitrary';
		expect(() => intakeProcessRole()).toThrow();
	});
});
