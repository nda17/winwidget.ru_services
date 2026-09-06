import { ConfigService } from '@nestjs/config';
import { connect } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { CrmTeamRabbitService } from './team-rabbit.service';
import { TEAM_CONSUMERS, teamQueue } from './team-messaging.contract';

jest.mock('amqp-connection-manager', () => ({ connect: jest.fn() }));

type Setup = (channel: ConfirmChannel) => Promise<void>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

const rawChannel = (firstDeclaration: Promise<void>) => {
	const queues = new Set<string>();
	const channel = {
		on: jest.fn(),
		assertExchange: jest
			.fn()
			.mockResolvedValue(undefined)
			.mockImplementationOnce(() => firstDeclaration),
		assertQueue: jest.fn().mockImplementation(async (name: string) => {
			queues.add(name);
		}),
		bindQueue: jest.fn().mockResolvedValue(undefined),
		prefetch: jest.fn().mockResolvedValue(undefined),
		consume: jest.fn().mockImplementation(async (name: string) => {
			if (!queues.has(name)) throw new Error('QUEUE_NOT_FOUND');
			return { consumerTag: `tag:${name}` };
		}),
		cancel: jest.fn().mockResolvedValue(undefined)
	};
	return { ...channel, raw: channel as unknown as ConfirmChannel };
};

async function fixture() {
	const setups: Setup[] = [];
	const listeners = new Map<string, () => void>();
	const wrapper = {
		addSetup: jest.fn().mockImplementation(async (setup: Setup) => {
			setups.push(setup);
		}),
		waitForConnect: jest.fn().mockResolvedValue(undefined),
		close: jest.fn().mockResolvedValue(undefined)
	};
	const connection = {
		on: jest
			.fn()
			.mockImplementation((name: string, handler: () => void) => {
				listeners.set(name, handler);
			}),
		createChannel: jest
			.fn()
			.mockImplementation(({ setup }: { setup: Setup }) => {
				setups.push(setup);
				return wrapper;
			}),
		connect: jest.fn().mockResolvedValue(undefined),
		isConnected: jest.fn().mockReturnValue(true),
		close: jest.fn().mockResolvedValue(undefined)
	};
	jest.mocked(connect).mockReturnValue(connection as never);
	const service = new CrmTeamRabbitService(
		new ConfigService({
			RABBITMQ_URL: 'amqp://synthetic.invalid/test',
			RABBITMQ_CONNECTION_NAME: 'winwidget-crm-access-worker'
		}),
		{ rabbitEnabled: true, workerEnabled: true, role: 'worker' } as never
	);
	Reflect.set(service, 'logger', { warn: jest.fn() });
	await service.onModuleInit();
	for (const consumer of TEAM_CONSUMERS)
		await service.consume(consumer, async () => undefined);
	expect(setups).toHaveLength(4);
	return { service, setups, listeners };
}

describe('CRM team channel topology lifecycle', () => {
	it('orders concurrent initial and consumer setups behind one topology declaration', async () => {
		const { service, setups } = await fixture();
		const barrier = deferred();
		const channel = rawChannel(barrier.promise);
		// Real ChannelWrapper invokes every registered setup using Promise.all.
		const running = Promise.all(setups.map(setup => setup(channel.raw)));
		await tick();
		expect(channel.assertExchange).toHaveBeenCalledTimes(1);
		expect(channel.prefetch).not.toHaveBeenCalled();
		expect(channel.consume).not.toHaveBeenCalled();
		expect(service.isReady()).toBe(false);
		barrier.resolve();
		await running;
		expect(channel.assertExchange).toHaveBeenCalledTimes(4);
		expect(channel.assertQueue).toHaveBeenCalledTimes(15);
		expect(channel.consume.mock.calls.map(([queue]) => queue)).toEqual(
			TEAM_CONSUMERS.map(teamQueue)
		);
		expect(channel.prefetch).toHaveBeenCalledTimes(3);
		expect(channel.prefetch).toHaveBeenCalledWith(4, false);
		for (const call of channel.consume.mock.calls)
			expect(call[2]).toEqual({ noAck: false });
		expect(service.isReady()).toBe(true);
		await service.onApplicationShutdown();
		expect(channel.cancel).toHaveBeenCalledTimes(3);
	});

	it('binds the readiness barrier to each reconnect channel and never reuses a fulfilled old promise', async () => {
		const { service, setups, listeners } = await fixture();
		const old = rawChannel(Promise.resolve());
		await Promise.all(setups.map(setup => setup(old.raw)));
		listeners.get('disconnect')!();
		expect(service.isReady()).toBe(false);
		const barrier = deferred();
		const next = rawChannel(barrier.promise);
		// Exercise the consumer-first ordering as well as initial setup first.
		const running = Promise.all(
			[...setups].reverse().map(setup => setup(next.raw))
		);
		await tick();
		expect(next.consume).not.toHaveBeenCalled();
		expect(next.assertExchange).toHaveBeenCalledTimes(1);
		barrier.resolve();
		await running;
		expect(next.assertQueue).toHaveBeenCalledTimes(15);
		expect(next.consume).toHaveBeenCalledTimes(3);
		expect(old.consume).toHaveBeenCalledTimes(3);
		expect(service.isReady()).toBe(true);
		await service.onApplicationShutdown();
		expect(next.cancel).toHaveBeenCalledTimes(3);
		expect(old.cancel).not.toHaveBeenCalled();
	});

	it('does not consume after a failed topology and retries instead of caching the rejected promise', async () => {
		const { service, setups } = await fixture();
		const barrier = deferred();
		const channel = rawChannel(barrier.promise);
		const failure = new Error('SYNTHETIC_TOPOLOGY_FAILURE');
		const results = Promise.allSettled(
			setups.map(setup => setup(channel.raw))
		);
		barrier.reject(failure);
		const settled = await results;
		for (const result of settled)
			expect(result).toEqual({ status: 'rejected', reason: failure });
		expect(channel.consume).not.toHaveBeenCalled();
		expect(channel.assertQueue).not.toHaveBeenCalled();
		expect(service.isReady()).toBe(false);
		await Promise.all(setups.map(setup => setup(channel.raw)));
		expect(channel.assertExchange).toHaveBeenCalledTimes(5);
		expect(channel.assertQueue).toHaveBeenCalledTimes(15);
		expect(channel.consume).toHaveBeenCalledTimes(3);
		expect(service.isReady()).toBe(true);
		await service.onApplicationShutdown();
	});
});
