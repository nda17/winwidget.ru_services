import { ConfigService } from '@nestjs/config';
import { connect } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { DESTINATION_QUEUE } from './messaging.constants';
import { IdentityRabbitMqService } from './rabbitmq.service';

jest.mock('amqp-connection-manager', () => ({ connect: jest.fn() }));

describe('Identity RabbitMQ topology', () => {
	it('reasserts the legacy main queue with durable-only arguments', async () => {
		const channel = {
			assertExchange: jest.fn(),
			assertQueue: jest.fn(),
			bindQueue: jest.fn()
		};
		const service = new IdentityRabbitMqService(
			{} as any,
			{ workerEnabled: true } as any
		);
		await (service as any).assertTopology(channel);
		const declaration = channel.assertQueue.mock.calls.find(
			call => call[0] === DESTINATION_QUEUE
		);
		expect(declaration).toEqual([DESTINATION_QUEUE, { durable: true }]);
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
async function topologyFixture(worker = true) {
	const setups: TopologySetup[] = [];
	const listeners = new Map<string, (context: { err: Error }) => void>();
	const wrapper = {
		addSetup: jest.fn(async (setup: TopologySetup) => {
			setups.push(setup);
		}),
		waitForConnect: jest.fn().mockResolvedValue(undefined),
		close: jest.fn().mockResolvedValue(undefined),
		publish: jest.fn().mockResolvedValue(true)
	};
	const connection = {
		on: jest.fn(
			(name: string, handler: (context: { err: Error }) => void) => {
				listeners.set(name, handler);
			}
		),
		createChannel: jest.fn(({ setup }: { setup: TopologySetup }) => {
			setups.push(setup);
			return wrapper;
		}),
		connect: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn().mockReturnValue(true),
		close: jest.fn().mockResolvedValue(undefined)
	};
	jest.mocked(connect).mockReturnValueOnce(connection as never);
	const role = worker ? 'worker' : 'outbox-publisher';
	const service = new IdentityRabbitMqService(
		new ConfigService({
			RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1/isolated_test',
			RABBITMQ_CONNECTION_NAME: `winwidget-identity-${role}`,
			RABBITMQ_ASSERT_TOPOLOGY: String(worker)
		}),
		{
			rabbitEnabled: true,
			workerEnabled: worker,
			role,
			prefetch: 7
		} as never
	);
	Reflect.set(service, 'logger', { warn: jest.fn() });
	const initializing = service.onModuleInit();
	// Identity's provider OnModuleInit hooks can register the consumer before connect.
	if (worker) await service.consume(async () => undefined);
	await initializing;
	expect(setups).toHaveLength(worker ? 2 : 1);
	return { service, setups, listeners, wrapper, connection };
}

describe('Identity channel topology barrier', () => {
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
			const ordered = consumerFirst ? [...setups].reverse() : setups;
			const running = Promise.all(
				ordered.map(setup => setup(channel.raw))
			);
			await topologyTick();
			expect(channel.assertExchange).toHaveBeenCalledTimes(1);
			expect(channel.assertQueue).not.toHaveBeenCalled();
			expect(channel.prefetch).not.toHaveBeenCalled();
			expect(channel.consume).not.toHaveBeenCalled();
			expect(service.isTopologyReady()).toBe(false);
			expect(service.isConsumerReady()).toBe(false);
			declaration.resolve();
			await topologyTick();
			expect(channel.bindQueue).toHaveBeenCalledTimes(1);
			expect(channel.consume).not.toHaveBeenCalled();
			binding.resolve();
			await running;
			expect(channel.assertExchange).toHaveBeenCalledTimes(4);
			expect(channel.assertQueue).toHaveBeenCalledTimes(5);
			expect(channel.consume).toHaveBeenCalledTimes(1);
			expect(channel.consume).toHaveBeenCalledWith(
				DESTINATION_QUEUE,
				expect.any(Function),
				expect.objectContaining({ noAck: false })
			);
			expect(channel.prefetch).toHaveBeenCalledWith(7, false);
			expect(service.isTopologyReady()).toBe(true);
			expect(service.isConsumerReady()).toBe(true);
			await service.onApplicationShutdown();
		}
	);

	it('uses a new topology barrier after reconnect instead of reusing the old channel promise', async () => {
		const { service, setups, listeners } = await topologyFixture();
		const previous = topologyChannel();
		await Promise.all(setups.map(setup => setup(previous.raw)));
		listeners.get('disconnect')!({
			err: new Error('SYNTHETIC_DISCONNECT')
		});
		expect(service.isTopologyReady()).toBe(false);
		const declaration = topologyDeferred();
		const next = topologyChannel(declaration.promise);
		const running = Promise.all(
			[...setups].reverse().map(setup => setup(next.raw))
		);
		await topologyTick();
		expect(next.assertExchange).toHaveBeenCalledTimes(1);
		expect(next.consume).not.toHaveBeenCalled();
		expect(service.isTopologyReady()).toBe(false);
		declaration.resolve();
		await running;
		expect(next.assertQueue).toHaveBeenCalledTimes(5);
		expect(next.consume).toHaveBeenCalledTimes(1);
		expect(previous.consume).toHaveBeenCalledTimes(1);
		expect(service.isConsumerReady()).toBe(true);
		await service.onApplicationShutdown();
		expect(next.cancel).toHaveBeenCalledTimes(1);
		expect(previous.cancel).not.toHaveBeenCalled();
	});

	it.each(['declaration', 'binding'] as const)(
		'rejects both setups on %s failure and permits a new attempt',
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
			expect(service.isTopologyReady()).toBe(false);
			expect(service.isConsumerReady()).toBe(false);
			await Promise.all(
				[...setups].reverse().map(setup => setup(channel.raw))
			);
			expect(channel.assertExchange).toHaveBeenCalledTimes(
				stage === 'declaration' ? 5 : 8
			);
			expect(channel.consume).toHaveBeenCalledTimes(1);
			expect(service.isConsumerReady()).toBe(true);
			await service.onApplicationShutdown();
		}
	);

	it('keeps publisher-only topology disabled and preserves mandatory confirmed Buffer publication', async () => {
		const { service, setups, wrapper, connection } =
			await topologyFixture(false);
		const channel = topologyChannel();
		await setups[0](channel.raw);
		expect(connection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true, publishTimeout: 15000 })
		);
		await service.publish(
			'winwidget.events',
			'identity.workspace.invitation.accepted.v1',
			{ fixture: true },
			{}
		);
		expect(channel.assertExchange).not.toHaveBeenCalled();
		expect(channel.assertQueue).not.toHaveBeenCalled();
		expect(channel.bindQueue).not.toHaveBeenCalled();
		expect(channel.consume).not.toHaveBeenCalled();
		expect(wrapper.publish).toHaveBeenCalledWith(
			'winwidget.events',
			'identity.workspace.invitation.accepted.v1',
			expect.any(Buffer),
			expect.objectContaining({ mandatory: true, deliveryMode: 2 })
		);
		expect(service.isTopologyReady()).toBe(true);
		await service.onApplicationShutdown();
	});
});
