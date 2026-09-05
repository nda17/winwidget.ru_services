import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { AcceptancePublisher } from './acceptance.publisher';
import { AcceptanceWorker } from './acceptance.worker';
import {
	AcceptanceRabbit,
	ACCEPTANCE_EVENT_TYPE,
	intakeProcessRole
} from './acceptance.messaging';
import { AcceptanceProcessor } from './acceptance.processor';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';

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
	consume: jest.fn((queue, deliver) => {
		void queue;
		void deliver;
		return Promise.resolve({ consumerTag: 'tag' });
	}),
	ack: jest.fn(),
	nack: jest.fn(),
	cancel: jest.fn().mockResolvedValue(undefined)
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
	workflowId: randomUUID(),
	generation: 1,
	mode: 'EXECUTE' as const
});
describe('durable Acceptance messaging', () => {
	const env = process.env;
	beforeEach(() => {
		process.env = {
			...env,
			CRM_INTAKE_RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1/isolated_test',
			CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'false'
		};
		jest.clearAllMocks();
		mockReturn.enabled = false;
	});
	afterEach(() => {
		process.env = env;
	});
	it('publishes a Buffer with confirms and fails mandatory-return before a success can be recorded', async () => {
		const rabbit = new AcceptanceRabbit();
		await rabbit.onModuleInit();
		await rabbit.publish(event(), 'MAIN', 0);
		expect(mockConnection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true })
		);
		expect(mockWrapper.publish).toHaveBeenCalledWith(
			expect.any(String),
			ACCEPTANCE_EVENT_TYPE,
			expect.any(Buffer),
			expect.objectContaining({ mandatory: true, persistent: true })
		);
		mockReturn.enabled = true;
		await expect(rabbit.publish(event(), 'MAIN', 0)).rejects.toThrow(
			'MANDATORY_RETURN'
		);
		await rabbit.onApplicationShutdown();
	});

	it('declares only MAIN and DLQ topology, never recreates or deletes legacy retry queues', async () => {
		process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'true';
		const rabbit = new AcceptanceRabbit();
		await rabbit.onModuleInit();
		await new Promise(resolve => setImmediate(resolve));
		expect(mockChannel.assertExchange).toHaveBeenCalledTimes(2);
		expect(mockChannel.assertQueue).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(mockChannel.assertQueue.mock.calls)).not.toMatch(
			/retry|ttl|dead-letter-exchange/
		);
		await expect(rabbit.publish(event(), 'RETRY_1', 1)).rejects.toThrow(
			'INVALID_ROUTE'
		);
		await rabbit.onApplicationShutdown();
	});
	it.each(
		[30000, 300000, 1800000].map((delay, index) => [delay, index + 1])
	)(
		'waits/resumes legacy retry delay %i using only the DB clock, preserving immutable route',
		async (delay, attempt) => {
			const start = new Date('2001-01-01T00:00:00.000Z');
			let clock = new Date(start.getTime() + delay - 1);
			const value = event();
			const row = {
				id: randomUUID(),
				eventId: value.eventId,
				payload: value,
				route: `RETRY_${attempt}`,
				retryAttempt: attempt,
				attempts: 0,
				leaseToken: '',
				status: 'PENDING',
				availableAt: start
			};
			const eligible = (where: any) =>
				where.OR.some(
					(option: any) =>
						(typeof option.route === 'string'
							? option.route === row.route
							: option.route.in.includes(row.route)) &&
						row.availableAt <= option.availableAt.lte
				);
			const prisma = {
				$queryRaw: jest
					.fn()
					.mockImplementation(async () => [{ now: clock }]),
				acceptanceOutbox: {
					findMany: jest.fn(async (args: any) =>
						row.status === 'PENDING' && eligible(args.where)
							? [{ id: row.id }]
							: []
					),
					updateMany: jest.fn(async (args: any) => {
						if (args.data.status === 'PUBLISHING') {
							if (!eligible(args.where)) return { count: 0 };
							row.leaseToken = args.data.leaseToken;
						}
						if (args.where.id) row.status = args.data.status;
						return { count: 1 };
					}),
					findUnique: jest.fn(async () => row)
				}
			};
			const rabbit = { publish: jest.fn() };
			await new AcceptancePublisher(
				prisma as never,
				rabbit as never
			).tick();
			expect(rabbit.publish).not.toHaveBeenCalled();
			clock = new Date(start.getTime() + delay);
			await new AcceptancePublisher(
				prisma as never,
				rabbit as never
			).tick();
			expect(rabbit.publish).toHaveBeenCalledWith(value, 'MAIN', attempt);
			expect(row.route).toBe(`RETRY_${attempt}`);
			expect(row.status).toBe('PUBLISHED');
			expect(
				prisma.acceptanceOutbox.findMany.mock.calls[0][0]
			).toMatchObject({
				take: 20,
				where: {
					OR: expect.arrayContaining([
						{
							route: { in: ['MAIN', 'DLQ'] },
							availableAt: { lte: new Date(start.getTime() + delay - 1) }
						}
					])
				}
			});
			expect(prisma.acceptanceOutbox.updateMany).toHaveBeenLastCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ publishedAt: clock })
				})
			);
		}
	);
	it('selects MAIN due predicates before LIMIT and rechecks due after the claim clock advances', async () => {
		const databaseNow = new Date('2001-01-01T00:00:00.000Z');
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ now: databaseNow }]),
			acceptanceOutbox: {
				updateMany: jest.fn(),
				findMany: jest.fn().mockResolvedValue([])
			}
		};
		const rabbit = { publish: jest.fn() };
		await new AcceptancePublisher(prisma as never, rabbit as never).tick();
		expect(prisma.acceptanceOutbox.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 20,
				where: {
					status: 'PENDING',
					OR: expect.arrayContaining([
						{
							route: { in: ['MAIN', 'DLQ'] },
							availableAt: { lte: databaseNow }
						}
					])
				}
			})
		);
		expect(rabbit.publish).not.toHaveBeenCalled();
	});
	it.each(['leased', 'database failure'])(
		'holds %s rejection unacked for five seconds before requeue',
		async reason => {
			jest.useFakeTimers();
			const rabbit = new AcceptanceRabbit();
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
	it('interrupts five unacked waits and tolerates cancel failure before shutdown drain', async () => {
		jest.useFakeTimers();
		const rabbit = new AcceptanceRabbit();
		try {
			await rabbit.onModuleInit();
			await rabbit.consume(async () => {
				throw new Error('leased');
			});
			const deliver = mockChannel.consume.mock.calls[0][1];
			for (let i = 0; i < 5; i++)
				deliver({ content: Buffer.from('{}'), properties: {} });
			await jest.advanceTimersByTimeAsync(0);
			expect(mockChannel.prefetch).toHaveBeenCalledWith(5, false);
			mockChannel.cancel.mockRejectedValueOnce(new Error('closed'));
			await rabbit.cancel();
			expect(mockChannel.nack).toHaveBeenCalledTimes(5);
			expect(mockChannel.ack).not.toHaveBeenCalled();
			expect(jest.getTimerCount()).toBe(0);
		} finally {
			await rabbit.onApplicationShutdown();
			jest.useRealTimers();
		}
	});
	it('awaits the same cooldown when failure state could not commit', async () => {
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
				type: ACCEPTANCE_EVENT_TYPE,
				contentType: 'application/json'
			}
		};
		await new AcceptanceWorker(
			processor as never,
			rabbit as never,
			{} as never
		).handle(message as never);
		expect(rabbit.nackAfterBackoff).toHaveBeenCalledWith(message);
		expect(rabbit.nack).not.toHaveBeenCalled();
		expect(rabbit.ack).not.toHaveBeenCalled();
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
			$queryRaw: jest
				.fn()
				.mockResolvedValue([
					{ now: new Date('2030-01-01T00:00:00.000Z') }
				]),
			acceptanceOutbox: {
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
		await new AcceptancePublisher(prisma as never, rabbit as never).tick();
		expect(prisma.acceptanceOutbox.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					lastErrorCode: 'PUBLICATION_UNCONFIRMED'
				})
			})
		);
		expect(
			prisma.acceptanceOutbox.updateMany.mock.calls.some(
				([args]) => args.data.status === 'PUBLISHED'
			)
		).toBe(false);
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
		const prisma = { acceptanceOutbox: { createMany: jest.fn() } };
		const worker = new AcceptanceWorker(
			processor as never,
			rabbit as never,
			prisma as never
		);
		const value = event();
		const message = {
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: ACCEPTANCE_EVENT_TYPE,
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
			JSON.stringify(prisma.acceptanceOutbox.createMany.mock.calls)
		).not.toContain('+79000000001');
		expect(prisma.acceptanceOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true })
		);
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
				AcceptanceWorker,
				{ provide: AcceptanceProcessor, useValue: processor },
				{ provide: AcceptanceRabbit, useValue: rabbit },
				{ provide: CrmIntakePrismaService, useValue: prisma }
			]
		}).compile();
		await module.init();
		const value = event();
		const task = deliver({
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: ACCEPTANCE_EVENT_TYPE,
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
	it('makes non-API roles explicit and rejects unknown role configuration', () => {
		process.env.CRM_INTAKE_PROCESS_ROLE = 'worker';
		expect(intakeProcessRole()).toBe('worker');
		process.env.CRM_INTAKE_PROCESS_ROLE = 'arbitrary';
		expect(() => intakeProcessRole()).toThrow();
	});
});
