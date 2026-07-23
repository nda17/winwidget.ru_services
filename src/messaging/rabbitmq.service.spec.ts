import { RabbitMqService } from '@/messaging/rabbitmq.service';
import type { ConfigService } from '@nestjs/config';
import type { ConfirmChannel } from 'amqplib';

describe('RabbitMqService topology', () => {
	it('fans out payment events but keeps retries consumer-specific', async () => {
		const channel = {
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
	});
});
