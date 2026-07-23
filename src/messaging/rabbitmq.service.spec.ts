import { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { ConfigService } from '@nestjs/config';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

describe('RabbitMqService topology', () => {
	it('fans out payment events but keeps retries consumer-specific', async () => {
		const channel = {
			on: jest.fn(),
			assertExchange: jest.fn().mockResolvedValue(undefined),
			assertQueue: jest.fn().mockResolvedValue(undefined),
			bindQueue: jest.fn().mockResolvedValue(undefined)
		} as unknown as ConfirmChannel;
		const service = new RabbitMqService({
			get: jest.fn()
		} as unknown as ConfigService);

		await (service as any).assertTopology(channel);

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
			'winwidget.limit-notification.telegram',
			'winwidget.events',
			'lead.limit.reached.v1'
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
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.succeeded.v1'
		};

		await service.publishEvent('payment.succeeded.v1', payload, {
			messageId: 'event-1'
		});

		expect(publish).toHaveBeenCalledWith(
			'winwidget.events',
			'payment.succeeded.v1',
			expect.any(Buffer),
			expect.objectContaining({
				contentType: 'application/json',
				messageId: 'event-1'
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
				options: { correlationId: string }
			) => {
				(service as any).returnedPublications.set(
					options.correlationId,
					new Error('RabbitMQ returned publication: NO_ROUTE')
				);
				return true;
			}
		);
		(service as any).channel = { publish };

		await expect(
			service.publishEvent(
				'missing.route',
				{ schemaVersion: 1 },
				{
					messageId: 'event-1'
				}
			)
		).rejects.toThrow('NO_ROUTE');
		expect((service as any).returnedPublications.size).toBe(0);
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
});
