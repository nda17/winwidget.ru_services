import type { SetupFunc } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { BillingRabbitMqService } from './billing-rabbitmq.service';

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('BillingRabbitMqService topology ordering', () => {
	const makeService = () =>
		new BillingRabbitMqService(
			{ get: jest.fn() } as never,
			{ rabbitEnabled: true, workerEnabled: true } as never
		);

	it('waits for the initial channel and topology before registering a consumer', async () => {
		const connected = deferred();
		const topology = deferred();
		const wrapper = {
			waitForConnect: jest.fn().mockReturnValue(connected.promise),
			addSetup: jest.fn().mockResolvedValue(undefined),
			removeSetup: jest.fn().mockResolvedValue(undefined)
		};
		const service = makeService();
		const internals = service as unknown as {
			channel: typeof wrapper;
			currentTopologySetup: Promise<void>;
		};
		internals.channel = wrapper;
		internals.currentTopologySetup = topology.promise;

		const registration = service.consume('identity', jest.fn(), 10);
		await Promise.resolve();
		expect(wrapper.addSetup).not.toHaveBeenCalled();

		connected.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(wrapper.addSetup).not.toHaveBeenCalled();

		topology.resolve();
		await registration;
		expect(wrapper.addSetup).toHaveBeenCalledTimes(1);
	});

	it('awaits the per-channel topology assertion before consuming after reconnect', async () => {
		let consumerSetup: SetupFunc | null = null;
		const wrapper = {
			waitForConnect: jest.fn().mockResolvedValue(undefined),
			addSetup: jest.fn().mockImplementation((setup: SetupFunc) => {
				consumerSetup = setup;
				return Promise.resolve();
			}),
			removeSetup: jest.fn().mockResolvedValue(undefined)
		};
		const topology = deferred();
		const service = makeService();
		const assertWorkerTopology = jest
			.fn()
			.mockReturnValue(topology.promise);
		const internals = service as unknown as {
			channel: typeof wrapper;
			currentTopologySetup: Promise<void>;
			assertTopologyEnabled: boolean;
			assertWorkerTopology: typeof assertWorkerTopology;
		};
		internals.channel = wrapper;
		internals.currentTopologySetup = Promise.resolve();
		internals.assertTopologyEnabled = true;
		internals.assertWorkerTopology = assertWorkerTopology;
		await service.consume('identity', jest.fn(), 10);

		const reconnectChannel = {
			on: jest.fn(),
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest
				.fn()
				.mockResolvedValue({ consumerTag: 'billing-identity-test' })
		};
		const reconnect = (
			consumerSetup as unknown as (
				channel: ConfirmChannel
			) => Promise<void>
		)(reconnectChannel as never);
		await Promise.resolve();
		await Promise.resolve();

		expect(assertWorkerTopology).toHaveBeenCalledWith(reconnectChannel);
		expect(reconnectChannel.prefetch).not.toHaveBeenCalled();
		expect(reconnectChannel.consume).not.toHaveBeenCalled();

		topology.resolve();
		await reconnect;
		expect(reconnectChannel.prefetch).toHaveBeenCalledWith(10, false);
		expect(reconnectChannel.consume).toHaveBeenCalledTimes(1);
	});
});
