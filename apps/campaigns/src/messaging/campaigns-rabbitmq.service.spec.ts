import {
	CAMPAIGNS_QUEUE_NAMES,
	CAMPAIGNS_RETRY_EXCHANGE,
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE
} from './campaigns-messaging.constants';
import { CampaignsRabbitMqService } from './campaigns-rabbitmq.service';
import type { ConsumeMessage } from 'amqplib';

const EVENT_ID = '05a1256d-d21b-4c11-9193-f23f0e3648d9';

describe('CampaignsRabbitMqService delivery guarantees', () => {
	it('asserts only Campaigns-owned topology and binds to shared exchanges', async () => {
		const channel = {
			assertExchange: jest.fn().mockResolvedValue(undefined),
			assertQueue: jest.fn().mockResolvedValue(undefined),
			bindQueue: jest.fn().mockResolvedValue(undefined)
		};
		const service = new CampaignsRabbitMqService(
			{ get: jest.fn() } as never,
			{ rabbitEnabled: true, workerEnabled: true } as never
		);
		const internals = service as unknown as {
			assertTopology: (target: typeof channel) => Promise<void>;
		};

		await internals.assertTopology(channel);

		expect(CAMPAIGNS_RETRY_EXCHANGE).toBe('winwidget.campaigns.retry');
		expect(channel.assertExchange).toHaveBeenCalledTimes(1);
		expect(channel.assertExchange).toHaveBeenCalledWith(
			CAMPAIGNS_RETRY_EXCHANGE,
			'direct',
			{ durable: true }
		);
		expect(channel.assertExchange).not.toHaveBeenCalledWith(
			EVENTS_EXCHANGE,
			expect.anything(),
			expect.anything()
		);
		expect(channel.assertExchange).not.toHaveBeenCalledWith(
			DEAD_LETTER_EXCHANGE,
			expect.anything(),
			expect.anything()
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			CAMPAIGNS_QUEUE_NAMES.snapshot,
			EVENTS_EXCHANGE,
			'campaign.snapshot.requested.v1'
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			`${CAMPAIGNS_QUEUE_NAMES.outcome}.dead-letter`,
			DEAD_LETTER_EXCHANGE,
			'campaigns.outcome.dead-letter'
		);
	});

	it('rejects a confirmed mandatory publication returned by RabbitMQ', async () => {
		let returned:
			| ((message: {
					properties: {
						headers: Record<string, unknown>;
					};
					fields: {
						exchange: string;
						routingKey: string;
						replyCode: number;
						replyText: string;
					};
			  }) => void)
			| undefined;
		const rawChannel = {
			on: jest.fn((event: string, handler: typeof returned) => {
				if (event === 'return') returned = handler;
			})
		};
		const wrapper = {
			publish: jest.fn(
				async (
					exchange: string,
					routingKey: string,
					_body: Buffer,
					options: {
						headers?: Record<string, unknown>;
					}
				) => {
					returned?.({
						properties: {
							headers: options.headers || {}
						},
						fields: {
							exchange,
							routingKey,
							replyCode: 312,
							replyText: 'NO_ROUTE'
						}
					});
				}
			)
		};
		const service = new CampaignsRabbitMqService(
			{ get: jest.fn() } as never,
			{ rabbitEnabled: true, workerEnabled: false } as never
		);
		const internals = service as unknown as {
			channel: typeof wrapper;
			registerReturnHandler: (channel: typeof rawChannel) => void;
		};
		internals.channel = wrapper;
		internals.registerReturnHandler(rawChannel);

		await expect(
			service.publish(
				CAMPAIGNS_RETRY_EXCHANGE,
				'snapshot.retry.1',
				{ test: true },
				{
					messageId: EVENT_ID,
					type: 'campaigns.retry-test.v1'
				}
			)
		).rejects.toThrow('NO_ROUTE');

		expect(wrapper.publish).toHaveBeenCalledWith(
			CAMPAIGNS_RETRY_EXCHANGE,
			'snapshot.retry.1',
			expect.any(Buffer),
			expect.objectContaining({
				mandatory: true,
				messageId: EVENT_ID,
				headers: expect.objectContaining({
					'x-publication-token': expect.any(String)
				})
			})
		);
	});

	it('forces connection recovery when the broker cancels a consumer', async () => {
		let onMessage: ((message: ConsumeMessage | null) => void) | undefined;
		const rawChannel = {
			once: jest.fn(),
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest.fn(
				(
					_queue: string,
					handler: (message: ConsumeMessage | null) => void
				) => {
					onMessage = handler;
					return Promise.resolve({
						consumerTag: 'campaigns-snapshot-test'
					});
				}
			)
		};
		const wrapper = {
			addSetup: jest.fn(
				(setup: (channel: typeof rawChannel) => Promise<void>) =>
					setup(rawChannel)
			),
			removeSetup: jest.fn()
		};
		const connection = {
			isConnected: jest.fn().mockReturnValue(true),
			reconnect: jest.fn()
		};
		const service = new CampaignsRabbitMqService(
			{ get: jest.fn() } as never,
			{ rabbitEnabled: true, workerEnabled: true } as never
		);
		const internals = service as unknown as {
			channel: typeof wrapper;
			connection: typeof connection;
		};
		internals.channel = wrapper;
		internals.connection = connection;

		await service.consume('snapshot', jest.fn(), 10);
		expect(service.areConsumersReady()).toBe(false);
		onMessage?.(null);

		expect(connection.isConnected).toHaveBeenCalled();
		expect(connection.reconnect).toHaveBeenCalledTimes(1);
		expect(service.areConsumersReady()).toBe(false);
		expect(wrapper.addSetup).toHaveBeenCalledTimes(1);
	});
});
