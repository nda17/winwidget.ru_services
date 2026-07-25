import { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

describe('RabbitMqService topology', () => {
	const paymentPayload = {
		schemaVersion: 1,
		eventType: 'payment.succeeded.v1',
		payment: {
			id: 'payment-1',
			yookassaId: 'yookassa-1',
			amount: '1000',
			plan: 'EASY',
			billingPeriod: 'MONTHLY',
			succeededAt: '2026-07-25T00:00:00.000Z'
		},
		user: {
			id: 'user-1',
			name: null,
			email: 'owner@example.com',
			phone: null
		},
		subscription: {
			expiresAt: '2026-08-25T00:00:00.000Z'
		}
	};
	const messageId = '11111111-1111-4111-8111-111111111111';

	it('fans out payment events but keeps retries consumer-specific', async () => {
		const channel = {
			on: jest.fn(),
			assertExchange: jest.fn().mockResolvedValue(undefined),
			assertQueue: jest.fn().mockResolvedValue(undefined),
			bindQueue: jest.fn().mockResolvedValue(undefined),
			unbindQueue: jest.fn().mockResolvedValue(undefined)
		} as unknown as ConfirmChannel;
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);

		await (service as any).assertTopology(channel);

		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.lead-integration.webhook',
			'winwidget.events',
			'lead.integration.webhook.v2'
		);
		expect(channel.unbindQueue).toHaveBeenCalledWith(
			'winwidget.lead-integration.webhook',
			'winwidget.events',
			'lead.integration.webhook.v1'
		);
		expect(channel.unbindQueue).toHaveBeenCalledTimes(5);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.payment-notification.email',
			'winwidget.events',
			'payment.succeeded.v1'
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.payment-notification.telegram',
			'winwidget.events',
			'payment.succeeded.v1'
		);
		expect(channel.assertQueue).toHaveBeenCalledWith(
			'winwidget.payment-notification.email.retry-v2.1',
			expect.objectContaining({
				deadLetterExchange: 'winwidget.manual-retry',
				deadLetterRoutingKey: 'payment-email'
			})
		);
		expect(channel.assertQueue).toHaveBeenCalledWith(
			'winwidget.payment-notification.telegram.retry-v2.1',
			expect.objectContaining({
				deadLetterExchange: 'winwidget.manual-retry',
				deadLetterRoutingKey: 'payment-telegram'
			})
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.mailing.email',
			'winwidget.events',
			'mailing.delivery.email.v1'
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.limit-notification.email',
			'winwidget.events',
			'lead.limit.reached.email.v2'
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.limit-notification.telegram',
			'winwidget.events',
			'lead.limit.reached.telegram.v2'
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			'winwidget.limit-notification.telegram',
			'winwidget.events',
			'manual.limit-telegram'
		);
	});

	it('publishes event payload as JSON bytes', async () => {
		const publish = jest.fn().mockResolvedValue(true);
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).channel = { publish };
		const payload = paymentPayload;

		await service.publishEvent('payment.succeeded.v1', payload, {
			messageId,
			type: 'payment.succeeded.v1'
		});

		expect(publish).toHaveBeenCalledWith(
			'winwidget.events',
			'payment.succeeded.v1',
			expect.any(Buffer),
			expect.objectContaining({
				contentType: 'application/json',
				messageId,
				type: 'payment.succeeded.v1'
			})
		);
		const content = publish.mock.calls[0][2] as Buffer;
		expect(JSON.parse(content.toString('utf8'))).toEqual(payload);
	});

	it('rejects a mandatory publication returned by RabbitMQ', async () => {
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		const publish = jest.fn(
			async (
				_exchange: string,
				_routingKey: string,
				_content: Buffer,
				options: {
					headers: { 'x-publication-token': string };
				}
			) => {
				(service as any).returnedPublications.set(
					options.headers['x-publication-token'],
					new Error('RabbitMQ returned publication: NO_ROUTE')
				);
				return true;
			}
		);
		(service as any).channel = { publish };

		await expect(
			service.publishEvent('payment.succeeded.v1', paymentPayload, {
				messageId,
				type: 'payment.succeeded.v1'
			})
		).rejects.toThrow('NO_ROUTE');
		expect((service as any).returnedPublications.size).toBe(0);
	});

	it('keeps business correlation separate from mandatory-return tracking', async () => {
		const publish = jest.fn().mockResolvedValue(true);
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).channel = { publish };

		await service.publishEvent('payment.succeeded.v1', paymentPayload, {
			messageId,
			type: 'payment.succeeded.v1',
			headers: {
				'x-correlation-id': 'business-correlation'
			}
		});

		const options = publish.mock.calls[0][3];
		expect(options.correlationId).toBe('business-correlation');
		expect(options.headers['x-publication-token']).not.toBe(
			'business-correlation'
		);
	});

	it('rejects oversized messages before publishing', async () => {
		const publish = jest.fn().mockResolvedValue(true);
		const service = new RabbitMqService({
			get: jest.fn((key: string) =>
				key === 'RABBITMQ_MAX_MESSAGE_BYTES' ? '1024' : undefined
			)
		} as unknown as ConfigService);
		(service as any).channel = { publish };

		await expect(
			service.publishEvent(
				'payment.succeeded.v1',
				{
					...paymentPayload,
					user: {
						...paymentPayload.user,
						name: 'x'.repeat(2048)
					}
				},
				{
					messageId,
					type: 'payment.succeeded.v1'
				}
			)
		).rejects.toThrow('payload exceeds limit');
		expect(publish).not.toHaveBeenCalled();
	});

	it('acknowledges a delivery only on the channel that received it', () => {
		const deliveryChannel = {
			ack: jest.fn()
		} as unknown as ConfirmChannel;
		const message = {} as ConsumeMessage;
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).deliveryChannels.set(message, deliveryChannel);

		service.ack(message);

		expect(deliveryChannel.ack).toHaveBeenCalledWith(message);
		expect((service as any).deliveryChannels.has(message)).toBe(false);
	});

	it('cancels registered consumers and leaves late deliveries for channel requeue', async () => {
		let deliveryHandler:
			| ((message: ConsumeMessage | null) => void)
			| undefined;
		const deliveryChannel = {
			prefetch: jest.fn().mockResolvedValue(undefined),
			consume: jest
				.fn()
				.mockImplementation(
					(_queue, handler: (message: ConsumeMessage | null) => void) => {
						deliveryHandler = handler;
						return Promise.resolve({ consumerTag: 'consumer-1' });
					}
				),
			cancel: jest.fn().mockResolvedValue(undefined),
			nack: jest.fn()
		} as unknown as ConfirmChannel;
		const channel = {
			addSetup: jest.fn(async setup => setup(deliveryChannel)),
			removeSetup: jest.fn(async (_setup, teardown) =>
				teardown?.(deliveryChannel)
			)
		};
		const handler = jest.fn().mockResolvedValue(undefined);
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).channel = channel;

		await service.consume('database-backup', handler, 1);
		await service.cancelConsumers();

		expect(channel.removeSetup).toHaveBeenCalledTimes(1);
		expect(deliveryChannel.cancel).toHaveBeenCalledWith('consumer-1');

		const message = {} as ConsumeMessage;
		deliveryHandler?.(message);
		expect(handler).not.toHaveBeenCalled();
		expect(deliveryChannel.nack).not.toHaveBeenCalled();
	});

	it('requires an explicit topology ownership setting', () => {
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);

		expect(() => (service as any).getAssertTopologyEnabled()).toThrow(
			'RABBITMQ_ASSERT_TOPOLOGY must be explicitly set'
		);
	});

	it.each([
		['true', true],
		['false', false],
		[true, true],
		[false, false]
	])('parses topology ownership value %p', (configured, expected) => {
		const service = new RabbitMqService({
			get: jest.fn(() => configured)
		} as unknown as ConfigService);

		expect((service as any).getAssertTopologyEnabled()).toBe(expected);
	});

	it('keeps a worker consumer setup registered while the topology owner is starting', async () => {
		const setupError = new Error('NOT_FOUND - no queue');
		const channel = {
			addSetup: jest.fn().mockRejectedValue(setupError),
			removeSetup: jest.fn()
		};
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).channel = channel;
		(service as any).assertTopologyEnabled = false;

		await expect(
			service.consume('database-backup', jest.fn(), 1)
		).resolves.toBeUndefined();

		expect((service as any).consumerRegistrations.size).toBe(1);
		expect(channel.removeSetup).not.toHaveBeenCalled();
	});

	it('fails fast when topology owner setup cannot be registered', async () => {
		const setupError = new Error('ACCESS_REFUSED');
		const channel = {
			addSetup: jest.fn().mockRejectedValue(setupError),
			removeSetup: jest.fn().mockResolvedValue(undefined)
		};
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);
		(service as any).channel = channel;
		(service as any).assertTopologyEnabled = true;

		await expect(
			service.consume('database-backup', jest.fn(), 1)
		).rejects.toThrow('ACCESS_REFUSED');

		expect((service as any).consumerRegistrations.size).toBe(0);
		expect(channel.removeSetup).toHaveBeenCalledTimes(1);
	});
});
