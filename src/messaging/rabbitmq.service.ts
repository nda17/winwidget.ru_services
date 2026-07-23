import {
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
	INTEGRATION_KINDS,
	INTEGRATION_QUEUE_NAMES,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind,
	MANUAL_RETRY_EXCHANGE,
	RETRY_DELAYS_MS,
	RETRY_EXCHANGE
} from '@/messaging/messaging.constants';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AmqpConnectionManager,
	ChannelWrapper,
	connect
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';

@Injectable()
export class RabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(RabbitMqService.name);
	private connection!: AmqpConnectionManager;
	private channel!: ChannelWrapper;

	constructor(private readonly configService: ConfigService) {}

	async onModuleInit(): Promise<void> {
		const url = this.configService.get<string>('RABBITMQ_URL');
		if (!url) {
			throw new Error('RABBITMQ_URL is required for messaging processes');
		}

		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name:
						this.configService.get<string>('RABBITMQ_CONNECTION_NAME') ||
						`winwidget-${process.pid}`
				}
			}
		});
		this.connection.on('connect', () =>
			this.logger.log('Connected to RabbitMQ')
		);
		this.connection.on('disconnect', ({ err }) =>
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`)
		);
		this.connection.on('connectFailed', ({ err }) =>
			this.logger.warn(`RabbitMQ connection failed: ${err.message}`)
		);

		this.channel = this.connection.createChannel({
			name: 'winwidget-messaging',
			confirm: true,
			publishTimeout: 15_000,
			setup: channel => this.assertTopology(channel as ConfirmChannel)
		});

		this.channel.on('error', error =>
			this.logger.error(`RabbitMQ channel error: ${error.message}`)
		);

		await this.connection.connect({ timeout: 15_000 });
		await this.channel.waitForConnect();
	}

	async publishEvent(
		routingKey: string,
		payload: unknown,
		options: Options.Publish = {}
	): Promise<void> {
		await this.channel.publish(EVENTS_EXCHANGE, routingKey, payload, {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			deliveryMode: 2,
			mandatory: true,
			timestamp: Date.now(),
			...options
		});
	}

	async publishRetry(
		kind: IntegrationKind,
		payload: unknown,
		attempt: number,
		eventId: string,
		eventType: string
	): Promise<void> {
		const retryIndex = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
		const routingKey = this.getRetryRoutingKey(kind, retryIndex);

		await this.channel.publish(RETRY_EXCHANGE, routingKey, payload, {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			deliveryMode: 2,
			mandatory: true,
			messageId: eventId,
			type: eventType,
			headers: { 'x-retry-attempt': attempt },
			timestamp: Date.now()
		});
	}

	async publishDeadLetter(
		kind: IntegrationKind,
		payload: unknown,
		attempt: number,
		eventId: string,
		error: string,
		eventType: string
	): Promise<void> {
		await this.channel.publish(
			DEAD_LETTER_EXCHANGE,
			this.getDeadLetterRoutingKey(kind),
			payload,
			{
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				messageId: eventId,
				type: eventType,
				headers: {
					'x-retry-attempt': attempt,
					'x-last-error': error.slice(0, 1000)
				},
				timestamp: Date.now()
			}
		);
	}

	async consume(
		kind: IntegrationKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		await this.consumeQueue(
			INTEGRATION_QUEUE_NAMES[kind],
			`${kind} integration`,
			handler,
			prefetch
		);
	}

	async consumeDeadLetter(
		kind: IntegrationKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		await this.consumeQueue(
			`${INTEGRATION_QUEUE_NAMES[kind]}.dead-letter`,
			`${kind} dead-letter`,
			handler,
			prefetch
		);
	}

	private async consumeQueue(
		queue: string,
		consumerName: string,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		await this.channel.consume(
			queue,
			message => {
				void handler(message).catch(error => {
					this.logger.error(
						`Unhandled ${consumerName} consumer error: ${
							error instanceof Error ? error.stack : String(error)
						}`
					);
					this.channel.nack(message, false, true);
				});
			},
			{ noAck: false, prefetch }
		);
	}

	ack(message: ConsumeMessage): void {
		this.channel.ack(message);
	}

	nack(message: ConsumeMessage, requeue: boolean): void {
		this.channel.nack(message, false, requeue);
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.channel) {
			await this.channel.close();
		}
		if (this.connection) {
			await this.connection.close();
		}
	}

	private async assertTopology(channel: ConfirmChannel): Promise<void> {
		await channel.assertExchange(EVENTS_EXCHANGE, 'topic', {
			durable: true
		});
		await channel.assertExchange(RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', {
			durable: true
		});
		await channel.assertExchange(MANUAL_RETRY_EXCHANGE, 'direct', {
			durable: true
		});

		for (const kind of INTEGRATION_KINDS) {
			const queue = INTEGRATION_QUEUE_NAMES[kind];
			const routingKey = INTEGRATION_ROUTING_KEYS[kind];
			const deadLetterQueue = `${queue}.dead-letter`;

			await channel.assertQueue(queue, {
				durable: true
			});
			await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
			await channel.bindQueue(queue, MANUAL_RETRY_EXCHANGE, kind);

			await channel.assertQueue(deadLetterQueue, { durable: true });
			await channel.bindQueue(
				deadLetterQueue,
				DEAD_LETTER_EXCHANGE,
				this.getDeadLetterRoutingKey(kind)
			);

			for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
				const retryQueue = `${queue}.retry-v2.${index + 1}`;
				const retryRoutingKey = this.getRetryRoutingKey(kind, index);

				await channel.assertQueue(retryQueue, {
					durable: true,
					messageTtl: delay,
					deadLetterExchange: MANUAL_RETRY_EXCHANGE,
					deadLetterRoutingKey: kind
				});
				await channel.bindQueue(
					retryQueue,
					RETRY_EXCHANGE,
					retryRoutingKey
				);
			}
		}
	}

	private getRetryRoutingKey(
		kind: IntegrationKind,
		index: number
	): string {
		return `${kind}.retry.${index + 1}`;
	}

	private getDeadLetterRoutingKey(kind: IntegrationKind): string {
		return `${kind}.dead-letter`;
	}
}
