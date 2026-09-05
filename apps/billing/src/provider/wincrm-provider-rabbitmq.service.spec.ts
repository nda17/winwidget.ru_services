import { EventEmitter } from 'node:events';
import { WincrmProviderRabbitMqService } from './wincrm-provider-rabbitmq.service';
import {
	WINCRM_PROVIDER_DEAD_EXCHANGE,
	WINCRM_PROVIDER_DEAD_QUEUE,
	WINCRM_PROVIDER_EVENT,
	WINCRM_PROVIDER_QUEUE,
	wincrmPaymentsEnabled,
	wincrmProviderBrokerConfiguration
} from './wincrm-provider.config';
import type { BillingRuntimeService } from '../runtime/billing-runtime.service';
import type { ConsumeMessage } from 'amqplib';

const mockConnect = jest.fn();
jest.mock('amqp-connection-manager', () => ({
	connect: (...args: unknown[]) => mockConnect(...args)
}));

describe('WinCRM provider isolated broker', () => {
	const environment = { ...process.env };
	let channel: any;
	let wrapper: any;
	let connection: any;
	let deliver: (message: ConsumeMessage | null) => void;
	let setups: Array<(channel: any) => Promise<void>>;
	const runtime = { workerEnabled: true } as BillingRuntimeService;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL =
			'amqp://synthetic-user:synthetic-password@127.0.0.1:5673/isolated_ci';
		process.env.BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY = 'true';
		setups = [];
		channel = Object.assign(new EventEmitter(), {
			assertExchange: jest.fn().mockResolvedValue(undefined),
			assertQueue: jest.fn().mockResolvedValue(undefined),
			bindQueue: jest.fn().mockResolvedValue(undefined),
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest.fn().mockImplementation(async (_queue, handler) => {
				deliver = handler;
				return { consumerTag: 'crm-consumer' };
			}),
			ack: jest.fn(),
			nack: jest.fn(),
			cancel: jest.fn().mockResolvedValue(undefined)
		});
		wrapper = Object.assign(new EventEmitter(), {
			waitForConnect: jest.fn().mockImplementation(async () => {
				for (const setup of setups) await setup(channel);
			}),
			addSetup: jest.fn().mockImplementation(async setup => {
				setups.push(setup);
				await setup(channel);
			}),
			close: jest.fn().mockResolvedValue(undefined)
		});
		connection = Object.assign(new EventEmitter(), {
			createChannel: jest.fn().mockImplementation(options => {
				setups.push(options.setup);
				return wrapper;
			}),
			connect: jest.fn().mockResolvedValue(undefined),
			isConnected: jest.fn().mockReturnValue(true),
			close: jest.fn().mockResolvedValue(undefined)
		});
		mockConnect.mockReturnValue(connection);
	});

	afterEach(() => {
		jest.useRealTimers();
		for (const key of [
			'BILLING_WINCRM_PAYMENTS_ENABLED',
			'BILLING_WINCRM_PROVIDER_RABBITMQ_URL',
			'BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY'
		]) {
			if (environment[key] === undefined) delete process.env[key];
			else process.env[key] = environment[key];
		}
	});

	it('is default-off and leaves the Widgets worker alone', async () => {
		delete process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		delete process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		expect(wincrmPaymentsEnabled()).toBe(false);
		expect(mockConnect).not.toHaveBeenCalled();
		expect(service.isReady()).toBe(true);
	});

	it('keeps provisioned reconciliation messaging alive when new payments are disabled', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		expect(mockConnect).toHaveBeenCalledTimes(1);
		await service.consume(async () => undefined);
		expect(service.isReady()).toBe(true);
		await service.onApplicationShutdown();
	});

	it.each(['false', 'yes', '1', 'on'])(
		'parses enable flag without truthy-string coercion (%s)',
		value => {
			process.env.BILLING_WINCRM_PAYMENTS_ENABLED = value;
			if (value === 'false') expect(wincrmPaymentsEnabled()).toBe(false);
			else
				expect(() => wincrmPaymentsEnabled()).toThrow(
					'must be true or false'
				);
		}
	);

	it.each([
		'amqp://u:p@broker.example.test/vhost',
		'amqps://broker.example.test/vhost',
		'amqps://u:p@broker.example.test/vhost?verify=false',
		'amqps://u:p@broker.example.test/vhost#fragment',
		'not-a-url'
	])(
		'rejects unsafe broker configuration without echoing the URL (%s)',
		value => {
			process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL = value;
			expect(() => wincrmProviderBrokerConfiguration()).toThrow(
				/WinCRM provider RabbitMQ/
			);
			try {
				wincrmProviderBrokerConfiguration();
			} catch (error) {
				expect((error as Error).message).not.toContain(value);
			}
		}
	);

	it('uses only its exact main/dead queues and no TTL relay', async () => {
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		expect(channel.assertExchange.mock.calls).toEqual([
			[WINCRM_PROVIDER_DEAD_EXCHANGE, 'direct', { durable: true }]
		]);
		expect(channel.assertQueue.mock.calls).toEqual([
			[WINCRM_PROVIDER_QUEUE, { durable: true }],
			[WINCRM_PROVIDER_DEAD_QUEUE, { durable: true }]
		]);
		expect(channel.bindQueue.mock.calls).toEqual([
			[WINCRM_PROVIDER_QUEUE, 'winwidget.events', WINCRM_PROVIDER_EVENT],
			[
				WINCRM_PROVIDER_DEAD_QUEUE,
				WINCRM_PROVIDER_DEAD_EXCHANGE,
				WINCRM_PROVIDER_EVENT
			]
		]);
		expect(JSON.stringify(channel.assertQueue.mock.calls)).not.toMatch(
			/messageTtl|deadLetterExchange|\.retry\./
		);
		expect(service.isReady()).toBe(false);
		await service.consume(async message => service.ack(message));
		expect(channel.prefetch).toHaveBeenCalledWith(5, false);
		expect(channel.consume).toHaveBeenCalledWith(
			WINCRM_PROVIDER_QUEUE,
			expect.any(Function),
			{ noAck: false }
		);
		expect(service.isReady()).toBe(true);
		const message = { content: Buffer.from('{}') } as ConsumeMessage;
		deliver(message);
		expect(channel.ack).toHaveBeenCalledWith(message);
		await service.onApplicationShutdown();
		expect(service.isReady()).toBe(false);
	});

	it('does not configure topology with runtime-only credentials', async () => {
		process.env.BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY = 'false';
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		expect(channel.assertExchange).not.toHaveBeenCalled();
		expect(channel.assertQueue).not.toHaveBeenCalled();
		await service.onApplicationShutdown();
	});

	it('delays retry without ack and interrupts the wait on shutdown', async () => {
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		let retry: Promise<void> | undefined;
		await service.consume(async message => {
			retry = service.requeue(message);
			await retry;
		});
		jest.useFakeTimers();
		const message = { content: Buffer.from('{}') } as ConsumeMessage;
		deliver(message);
		expect(channel.ack).not.toHaveBeenCalled();
		expect(channel.nack).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(4_999);
		expect(channel.nack).not.toHaveBeenCalled();
		await service.onApplicationShutdown();
		await retry;
		expect(channel.nack).toHaveBeenCalledWith(message, false, true);
		expect(channel.ack).not.toHaveBeenCalled();
	});

	it('fails readiness when disconnected and restores push registration on reconnect', async () => {
		const service = new WincrmProviderRabbitMqService(runtime);
		await service.onModuleInit();
		await service.consume(async () => undefined);
		expect(service.isReady()).toBe(true);
		connection.emit('disconnect', {});
		expect(service.isReady()).toBe(false);
		await wrapper.waitForConnect();
		expect(service.isReady()).toBe(true);
		expect(channel.consume).toHaveBeenCalledTimes(2);
		await service.onApplicationShutdown();
	});
});
