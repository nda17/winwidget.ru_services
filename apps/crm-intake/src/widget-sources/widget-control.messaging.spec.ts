import { randomUUID } from 'node:crypto';
import { connect } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { Test } from '@nestjs/testing';
import { WidgetControlPublisher } from './widget-control.publisher';
import { WidgetControlWorker } from './widget-control.worker';
import {
	WidgetControlRabbit,
	CONTROL_QUEUE,
	CONTROL_EVENT_TYPE
} from './widget-control.messaging';
import { WidgetControlProcessor } from './widget-control.processor';
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
	connect: jest.fn(() => mockConnection)
}));

const event = () => ({
	schemaVersion: 1 as const,
	eventId: randomUUID(),
	workspaceId: randomUUID(),
	sourceId: randomUUID(),
	commandId: randomUUID(),
	controlVersion: 1,
	generation: 1
});
describe('durable Widget control messaging', () => {
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
		const rabbit = new WidgetControlRabbit();
		await rabbit.onModuleInit();
		await rabbit.publish(event(), 'MAIN', 0);
		expect(mockConnection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true })
		);
		expect(mockWrapper.publish).toHaveBeenCalledWith(
			expect.any(String),
			CONTROL_EVENT_TYPE,
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
		const rabbit = new WidgetControlRabbit();
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
	it.each([5000, 30000, 120000].map((delay, index) => [delay, index + 1]))(
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
				widgetControlOutbox: {
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
			await new WidgetControlPublisher(
				prisma as never,
				rabbit as never
			).tick();
			expect(rabbit.publish).not.toHaveBeenCalled();
			clock = new Date(start.getTime() + delay);
			await new WidgetControlPublisher(
				prisma as never,
				rabbit as never
			).tick();
			expect(rabbit.publish).toHaveBeenCalledWith(value, 'MAIN', attempt);
			expect(row.route).toBe(`RETRY_${attempt}`);
			expect(row.status).toBe('PUBLISHED');
			expect(
				prisma.widgetControlOutbox.findMany.mock.calls[0][0]
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
			expect(
				prisma.widgetControlOutbox.updateMany
			).toHaveBeenLastCalledWith(
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
			widgetControlOutbox: {
				updateMany: jest.fn(),
				findMany: jest.fn().mockResolvedValue([])
			}
		};
		const rabbit = { publish: jest.fn() };
		await new WidgetControlPublisher(
			prisma as never,
			rabbit as never
		).tick();
		expect(prisma.widgetControlOutbox.findMany).toHaveBeenCalledWith(
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
			const rabbit = new WidgetControlRabbit();
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
		const rabbit = new WidgetControlRabbit();
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
				type: CONTROL_EVENT_TYPE,
				contentType: 'application/json'
			}
		};
		await new WidgetControlWorker(
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
			widgetControlOutbox: {
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
		await new WidgetControlPublisher(
			prisma as never,
			rabbit as never
		).tick();
		expect(prisma.widgetControlOutbox.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					lastErrorCode: 'PUBLICATION_UNCONFIRMED'
				})
			})
		);
		expect(
			prisma.widgetControlOutbox.updateMany.mock.calls.some(
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
		const prisma = { widgetControlOutbox: { createMany: jest.fn() } };
		const worker = new WidgetControlWorker(
			processor as never,
			rabbit as never,
			prisma as never
		);
		const value = event();
		const message = {
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: CONTROL_EVENT_TYPE,
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
			JSON.stringify(prisma.widgetControlOutbox.createMany.mock.calls)
		).not.toContain('+79000000001');
		expect(prisma.widgetControlOutbox.createMany).toHaveBeenCalledWith(
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
				WidgetControlWorker,
				{ provide: WidgetControlProcessor, useValue: processor },
				{ provide: WidgetControlRabbit, useValue: rabbit },
				{ provide: CrmIntakePrismaService, useValue: prisma }
			]
		}).compile();
		await module.init();
		const value = event();
		const task = deliver({
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: CONTROL_EVENT_TYPE,
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

type TopologySetup = (channel: ConfirmChannel) => Promise<void>;
const topologyTick = () =>
	new Promise<void>(resolve => setImmediate(resolve));
const topologyDeferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const topologyChannel = (
	declaration = Promise.resolve(),
	binding = Promise.resolve()
) => {
	const queues = new Set<string>();
	const channel = {
		on: jest.fn(),
		once: jest.fn(),
		assertExchange: jest
			.fn()
			.mockResolvedValue(undefined)
			.mockImplementationOnce(() => declaration),
		assertQueue: jest.fn(async (name: string) => {
			queues.add(name);
		}),
		bindQueue: jest
			.fn()
			.mockResolvedValue(undefined)
			.mockImplementationOnce(() => binding),
		prefetch: jest.fn().mockResolvedValue(undefined),
		consume: jest.fn(async (name: string) => {
			if (!queues.has(name)) throw new Error('QUEUE_NOT_FOUND');
			return { consumerTag: `tag:${name}` };
		}),
		cancel: jest.fn().mockResolvedValue(undefined)
	};
	return { ...channel, raw: channel as unknown as ConfirmChannel };
};
async function topologyFixture(assertTopology = true) {
	const setups: TopologySetup[] = [];
	const listeners = new Map<string, () => void>();
	const wrapper = {
		on: jest.fn(),
		addSetup: jest.fn(async (setup: TopologySetup) => {
			setups.push(setup);
		}),
		waitForConnect: jest.fn().mockResolvedValue(undefined),
		close: jest.fn().mockResolvedValue(undefined),
		publish: jest.fn().mockResolvedValue(true)
	};
	const connection = {
		on: jest.fn((name: string, handler: () => void) => {
			listeners.set(name, handler);
		}),
		createChannel: jest.fn(({ setup }: { setup: TopologySetup }) => {
			setups.push(setup);
			return wrapper;
		}),
		connect: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn().mockReturnValue(true),
		close: jest.fn().mockResolvedValue(undefined)
	};
	jest.mocked(connect).mockReturnValueOnce(connection as never);
	process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = String(assertTopology);
	const service = new WidgetControlRabbit();
	await service.onModuleInit();
	if (assertTopology) await service.consume(async () => undefined);
	expect(setups).toHaveLength(assertTopology ? 2 : 1);
	return { service, setups, listeners, wrapper, connection };
}

describe('WidgetControlRabbit channel topology barrier', () => {
	const env = process.env;
	beforeEach(() => {
		process.env = {
			...env,
			CRM_INTAKE_RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1/isolated_test'
		};
	});
	afterEach(() => {
		process.env = env;
	});

	it.each([false, true])(
		'waits for declarations and bindings when consumer-first=%s',
		async consumerFirst => {
			const { service, setups } = await topologyFixture();
			const declaration = topologyDeferred(),
				binding = topologyDeferred();
			const channel = topologyChannel(
				declaration.promise,
				binding.promise
			);
			// ChannelWrapper runs registered setups concurrently, including on reconnect.
			const ordered = consumerFirst ? [...setups].reverse() : setups;
			const running = Promise.all(
				ordered.map(setup => setup(channel.raw))
			);
			await topologyTick();
			expect(channel.assertExchange).toHaveBeenCalledTimes(1);
			expect(channel.assertQueue).not.toHaveBeenCalled();
			expect(channel.prefetch).not.toHaveBeenCalled();
			expect(channel.consume).not.toHaveBeenCalled();
			expect(service.ready(true)).toBe(false);
			declaration.resolve();
			await topologyTick();
			expect(channel.bindQueue).toHaveBeenCalledTimes(1);
			expect(channel.consume).not.toHaveBeenCalled();
			binding.resolve();
			await running;
			expect(channel.assertExchange).toHaveBeenCalledTimes(2);
			expect(channel.assertQueue).toHaveBeenCalledTimes(2);
			expect(channel.consume).toHaveBeenCalledTimes(1);
			expect(channel.consume).toHaveBeenCalledWith(
				CONTROL_QUEUE,
				expect.any(Function),
				{ noAck: false }
			);
			expect(channel.prefetch).toHaveBeenCalledWith(5, false);
			expect(service.ready(true)).toBe(true);
			await service.onApplicationShutdown();
		}
	);

	it('uses a fresh barrier for the reconnect channel instead of a fulfilled old promise', async () => {
		const { service, setups, listeners } = await topologyFixture();
		const previous = topologyChannel();
		await Promise.all(setups.map(setup => setup(previous.raw)));
		listeners.get('disconnect')!();
		expect(service.ready(true)).toBe(false);
		const declaration = topologyDeferred();
		const next = topologyChannel(declaration.promise);
		const running = Promise.all(
			[...setups].reverse().map(setup => setup(next.raw))
		);
		await topologyTick();
		expect(next.assertExchange).toHaveBeenCalledTimes(1);
		expect(next.consume).not.toHaveBeenCalled();
		expect(service.ready(true)).toBe(false);
		declaration.resolve();
		await running;
		expect(next.assertQueue).toHaveBeenCalledTimes(2);
		expect(next.consume).toHaveBeenCalledTimes(1);
		expect(previous.consume).toHaveBeenCalledTimes(1);
		expect(service.ready(true)).toBe(true);
		await service.onApplicationShutdown();
		expect(next.cancel).toHaveBeenCalledTimes(1);
		expect(previous.cancel).not.toHaveBeenCalled();
	});

	it.each(['declaration', 'binding'] as const)(
		'rejects both setups on %s failure and allows a new attempt',
		async stage => {
			const { service, setups } = await topologyFixture();
			const gate = topologyDeferred();
			const channel = topologyChannel(
				stage === 'declaration' ? gate.promise : Promise.resolve(),
				stage === 'binding' ? gate.promise : Promise.resolve()
			);
			const failure = new Error('SYNTHETIC_TOPOLOGY_FAILURE');
			const running = Promise.allSettled(
				setups.map(setup => setup(channel.raw))
			);
			await topologyTick();
			gate.reject(failure);
			for (const result of await running)
				expect(result).toEqual({ status: 'rejected', reason: failure });
			expect(channel.consume).not.toHaveBeenCalled();
			expect(channel.prefetch).not.toHaveBeenCalled();
			expect(service.ready(true)).toBe(false);
			await Promise.all(
				[...setups].reverse().map(setup => setup(channel.raw))
			);
			expect(channel.assertExchange).toHaveBeenCalledTimes(
				stage === 'declaration' ? 3 : 4
			);
			expect(channel.consume).toHaveBeenCalledTimes(1);
			expect(service.ready(true)).toBe(true);
			await service.onApplicationShutdown();
		}
	);

	it('keeps publisher-only topology disabled and preserves confirmed mandatory Buffer publication', async () => {
		const { service, setups, wrapper, connection } =
			await topologyFixture(false);
		const channel = topologyChannel();
		await setups[0](channel.raw);
		expect(connection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true, publishTimeout: 15000 })
		);
		await service.publish(event(), 'MAIN', 0);
		expect(channel.assertExchange).not.toHaveBeenCalled();
		expect(channel.assertQueue).not.toHaveBeenCalled();
		expect(channel.bindQueue).not.toHaveBeenCalled();
		expect(channel.consume).not.toHaveBeenCalled();
		expect(wrapper.publish).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.any(Buffer),
			expect.objectContaining({ mandatory: true, persistent: true })
		);
		expect(service.ready()).toBe(true);
		await service.onApplicationShutdown();
	});
});
