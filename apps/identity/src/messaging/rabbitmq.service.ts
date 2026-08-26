import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	connect,
	type AmqpConnectionManager,
	type ChannelWrapper
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
	IdentityRuntimeService,
	strictBoolean
} from '../runtime/identity-runtime.service';
import {
	DEAD_LETTER_EXCHANGE,
	DEAD_ROUTING_KEY,
	DESTINATION_EVENT,
	DESTINATION_KIND,
	DESTINATION_QUEUE,
	EVENTS_EXCHANGE,
	MANUAL_RETRY_EXCHANGE,
	RETRY_DELAYS_MS,
	RETRY_EXCHANGE,
	retryRoutingKey
} from './messaging.constants';

@Injectable()
export class IdentityRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(IdentityRabbitMqService.name);
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private consumerChannel: ConfirmChannel | null = null;
	private consumerTag: string | null = null;
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly returned = new Map<string, Error | null>();
	private topologyReady = false;
	private maxBytes = 256 * 1024;

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: IdentityRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.rabbitEnabled) return;
		const rabbitUrl = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!rabbitUrl) throw new Error('RABBITMQ_URL is required');
		const expectedName = `winwidget-identity-${this.runtime.role}`;
		if (
			this.config.get<string>('RABBITMQ_CONNECTION_NAME')?.trim() !==
			expectedName
		) {
			throw new Error(`RABBITMQ_CONNECTION_NAME must be ${expectedName}`);
		}
		const maxBytes = Number(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES') ||
				this.maxBytes
		);
		if (
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1024 ||
			maxBytes > 10 * 1024 * 1024
		) {
			throw new Error('RABBITMQ_MAX_MESSAGE_BYTES is invalid');
		}
		this.maxBytes = maxBytes;
		const assertTopology = strictBoolean(
			this.config.get<string>('RABBITMQ_ASSERT_TOPOLOGY'),
			this.runtime.workerEnabled,
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (assertTopology !== this.runtime.workerEnabled) {
			throw new Error(
				`RABBITMQ_ASSERT_TOPOLOGY must be ${this.runtime.workerEnabled} for ${this.runtime.role}`
			);
		}
		this.connection = connect([rabbitUrl], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: { connection_name: expectedName }
			}
		});
		this.connection.on('disconnect', ({ err }) => {
			this.topologyReady = false;
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`);
		});
		this.channel = this.connection.createChannel({
			name: expectedName,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				this.installReturnHandler(channel);
				if (assertTopology) await this.assertTopology(channel);
				this.topologyReady = true;
			}
		});
		await this.connection.connect({ timeout: 15_000 });
		await this.channel.waitForConnect();
	}

	isConnected(): boolean {
		return (
			!this.runtime.rabbitEnabled ||
			Boolean(this.connection?.isConnected())
		);
	}

	isTopologyReady(): boolean {
		return !this.runtime.rabbitEnabled || this.topologyReady;
	}

	isConsumerReady(): boolean {
		return !this.runtime.workerEnabled || Boolean(this.consumerTag);
	}

	async publish(
		exchange: string,
		routingKey: string,
		payload: unknown,
		options: Options.Publish
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ publisher is disabled');
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > this.maxBytes) {
			throw new Error(`RabbitMQ payload exceeds ${this.maxBytes} bytes`);
		}
		const publicationToken = randomUUID();
		this.returned.set(publicationToken, null);
		try {
			await this.channel.publish(exchange, routingKey, body, {
				...options,
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				timestamp: Date.now(),
				headers: {
					...(options.headers || {}),
					'x-publication-token': publicationToken
				}
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			const returned = this.returned.get(publicationToken);
			if (returned) throw returned;
		} finally {
			this.returned.delete(publicationToken);
		}
	}

	async consume(
		handler: (message: ConsumeMessage) => Promise<void>
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ consumer is disabled');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			this.consumerChannel = channel;
			await channel.prefetch(this.runtime.prefetch, false);
			const consumer = await channel.consume(
				DESTINATION_QUEUE,
				message => {
					if (!message) {
						this.consumerTag = null;
						return;
					}
					this.deliveryChannels.set(message, channel);
					void handler(message).catch(error => {
						this.logger.error(
							`Unhandled destination consumer failure: ${this.error(error)}`
						);
						this.nack(message, true);
					});
				},
				{
					noAck: false,
					consumerTag: `${this.config.get<string>(
						'RABBITMQ_CONNECTION_NAME'
					)}:${hostname()}:${DESTINATION_QUEUE}`.slice(0, 255)
				}
			);
			this.consumerTag = consumer.consumerTag;
		});
	}

	ack(message: ConsumeMessage): void {
		this.deliveryChannels.get(message)?.ack(message);
	}

	nack(message: ConsumeMessage, requeue: boolean): void {
		this.deliveryChannels.get(message)?.nack(message, false, requeue);
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.consumerChannel && this.consumerTag) {
			await this.consumerChannel
				.cancel(this.consumerTag)
				.catch(() => undefined);
		}
		this.consumerTag = null;
		this.consumerChannel = null;
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.channel = null;
		this.connection = null;
		this.topologyReady = false;
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
		// Queue arguments are immutable. Keep the established durable-only
		// declaration so a service restart can safely reuse the live queue.
		await channel.assertQueue(DESTINATION_QUEUE, { durable: true });
		await channel.bindQueue(
			DESTINATION_QUEUE,
			EVENTS_EXCHANGE,
			DESTINATION_EVENT
		);
		await channel.bindQueue(
			DESTINATION_QUEUE,
			EVENTS_EXCHANGE,
			`manual.${DESTINATION_KIND}`
		);
		await channel.bindQueue(
			DESTINATION_QUEUE,
			MANUAL_RETRY_EXCHANGE,
			DESTINATION_KIND
		);
		await channel.assertQueue(`${DESTINATION_QUEUE}.dead-letter`, {
			durable: true
		});
		await channel.bindQueue(
			`${DESTINATION_QUEUE}.dead-letter`,
			DEAD_LETTER_EXCHANGE,
			DEAD_ROUTING_KEY
		);
		await channel.bindQueue(
			`${DESTINATION_QUEUE}.dead-letter`,
			EVENTS_EXCHANGE,
			DEAD_ROUTING_KEY
		);
		for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
			const attempt = index + 1;
			const queue = `${DESTINATION_QUEUE}.retry-v2.${attempt}`;
			await channel.assertQueue(queue, {
				durable: true,
				messageTtl: delay,
				deadLetterExchange: MANUAL_RETRY_EXCHANGE,
				deadLetterRoutingKey: DESTINATION_KIND
			});
			await channel.bindQueue(
				queue,
				RETRY_EXCHANGE,
				retryRoutingKey(attempt)
			);
		}
	}

	private installReturnHandler(channel: ConfirmChannel): void {
		channel.on('return', message => {
			const token = message.properties.headers?.['x-publication-token'];
			if (typeof token !== 'string' || !this.returned.has(token)) return;
			this.returned.set(
				token,
				new Error(
					`RabbitMQ returned publication ${message.fields.replyCode} ${message.fields.replyText}`
				)
			);
		});
	}

	private error(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(
			0,
			2_000
		);
	}
}
