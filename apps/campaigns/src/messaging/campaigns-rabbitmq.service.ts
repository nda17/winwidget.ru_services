import {
	CAMPAIGNS_CONSUMER_KINDS,
	CAMPAIGNS_QUEUE_NAMES,
	CAMPAIGNS_RETRY_DELAYS_MS,
	CAMPAIGNS_RETRY_EXCHANGE,
	CAMPAIGNS_ROUTING_KEYS,
	CampaignsConsumerKind,
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
	getCampaignsDeadLetterRoutingKey,
	getCampaignsRetryRoutingKey
} from './campaigns-messaging.constants';
import { assertCampaignsPublishedEvent } from './campaigns-event.contract';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
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
import type { SetupFunc } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;

interface ConsumerRegistration {
	setup: SetupFunc;
	channel: ConfirmChannel | null;
	consumerTag: string | null;
}

export type CampaignsPublishExchange =
	| typeof EVENTS_EXCHANGE
	| typeof CAMPAIGNS_RETRY_EXCHANGE
	| typeof DEAD_LETTER_EXCHANGE;

@Injectable()
export class CampaignsRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(CampaignsRabbitMqService.name);
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly registrations = new Set<ConsumerRegistration>();
	private readonly returnedPublications = new Map<string, Error | null>();
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private stopping = false;
	private consumerRecoveryRequested = false;

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: CampaignsRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.rabbitEnabled) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const assertTopology = this.parseAssertTopology(
			this.config.get<string | boolean>('RABBITMQ_ASSERT_TOPOLOGY')
		);
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name:
						this.config.get<string>('RABBITMQ_CONNECTION_NAME') ||
						`winwidget-campaigns-${this.runtime.role}-${process.pid}`
				}
			}
		});
		this.connection.on('connect', () => {
			this.consumerRecoveryRequested = false;
			this.logger.log('Connected to RabbitMQ');
		});
		this.connection.on('disconnect', ({ err }) =>
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`)
		);
		this.channel = this.connection.createChannel({
			name: `winwidget-campaigns-${this.runtime.role}`,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				this.registerReturnHandler(channel);
				if (assertTopology) await this.assertTopology(channel);
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

	areConsumersReady(): boolean {
		return (
			!this.runtime.workerEnabled ||
			(this.registrations.size === CAMPAIGNS_CONSUMER_KINDS.length &&
				[...this.registrations].every(
					registration => registration.consumerTag !== null
				))
		);
	}

	async publish(
		exchange: CampaignsPublishExchange,
		routingKey: string,
		payload: unknown,
		options: Options.Publish
	): Promise<void> {
		if (!this.channel) {
			throw new Error('RabbitMQ publisher is disabled');
		}
		const messageId =
			typeof options.messageId === 'string' ? options.messageId : '';
		const eventType = typeof options.type === 'string' ? options.type : '';
		if (exchange === EVENTS_EXCHANGE) {
			assertCampaignsPublishedEvent(payload, eventType, messageId);
			if (routingKey !== eventType) {
				throw new Error(
					'Campaigns event routing key must equal event type'
				);
			}
		}
		const publicationToken = randomUUID();
		const body = Buffer.from(JSON.stringify(payload));
		const maxBytes = this.getMaxMessageBytes();
		if (body.length > maxBytes) {
			throw new Error(
				`RabbitMQ payload exceeds limit bytes=${body.length} maxBytes=${maxBytes}`
			);
		}
		this.returnedPublications.set(publicationToken, null);
		try {
			await this.channel.publish(exchange, routingKey, body, {
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				timestamp: Date.now(),
				...options,
				headers: {
					...(options.headers || {}),
					'x-publication-token': publicationToken
				}
			});
			const returned = this.returnedPublications.get(publicationToken);
			if (returned) throw returned;
		} finally {
			this.returnedPublications.delete(publicationToken);
		}
	}

	async consume(
		kind: CampaignsConsumerKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		if (!this.channel) {
			throw new Error('RabbitMQ consumer is disabled');
		}
		const registration: ConsumerRegistration = {
			channel: null,
			consumerTag: null,
			setup: async (channel: ConfirmChannel) => {
				registration.channel = channel;
				registration.consumerTag = null;
				channel.once('close', () => {
					if (registration.channel === channel) {
						registration.channel = null;
						registration.consumerTag = null;
					}
				});
				await channel.prefetch(prefetch, false);
				const consumer = await channel.consume(
					CAMPAIGNS_QUEUE_NAMES[kind],
					message => {
						if (!message) {
							registration.consumerTag = null;
							this.requestConsumerRecovery(kind);
							return;
						}
						this.deliveryChannels.set(message, channel);
						if (this.stopping) return;
						void handler(message).catch(error => {
							this.logger.error(
								`Unhandled campaigns consumer error kind=${kind}: ${
									error instanceof Error ? error.stack : String(error)
								}`
							);
							this.nack(message, true);
						});
					},
					{ noAck: false }
				);
				registration.consumerTag = consumer.consumerTag;
			}
		};
		this.registrations.add(registration);
		try {
			await this.channel.addSetup(registration.setup);
		} catch (error) {
			this.registrations.delete(registration);
			await this.channel
				.removeSetup(registration.setup)
				.catch(() => undefined);
			throw error;
		}
	}

	ack(message: ConsumeMessage): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) return;
		try {
			channel.ack(message);
		} finally {
			this.deliveryChannels.delete(message);
		}
	}

	nack(message: ConsumeMessage, requeue: boolean): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) return;
		try {
			channel.nack(message, false, requeue);
		} finally {
			this.deliveryChannels.delete(message);
		}
	}

	async cancelConsumers(): Promise<void> {
		this.stopping = true;
		if (!this.channel) return;
		const registrations = [...this.registrations];
		this.registrations.clear();
		await Promise.all(
			registrations.map(registration =>
				this.channel!.removeSetup(
					registration.setup,
					async (channel: ConfirmChannel) => {
						const tag = registration.consumerTag;
						registration.consumerTag = null;
						if (tag) await channel.cancel(tag);
					}
				)
			)
		);
	}

	async onApplicationShutdown(): Promise<void> {
		await this.cancelConsumers().catch(() => undefined);
		if (this.channel) await this.channel.close();
		if (this.connection) await this.connection.close();
	}

	private requestConsumerRecovery(kind: CampaignsConsumerKind): void {
		if (this.stopping || this.consumerRecoveryRequested) return;
		this.consumerRecoveryRequested = true;
		this.logger.warn(
			`RabbitMQ cancelled campaigns consumer kind=${kind}; reconnecting`
		);
		if (!this.connection?.isConnected()) {
			this.consumerRecoveryRequested = false;
			return;
		}
		try {
			this.connection.reconnect();
		} catch (error) {
			this.consumerRecoveryRequested = false;
			this.logger.error(
				`Could not reconnect cancelled campaigns consumer kind=${kind}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async assertTopology(channel: ConfirmChannel): Promise<void> {
		await channel.assertExchange(CAMPAIGNS_RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		for (const kind of CAMPAIGNS_CONSUMER_KINDS) {
			const queue = CAMPAIGNS_QUEUE_NAMES[kind];
			await channel.assertQueue(queue, { durable: true });
			await channel.bindQueue(
				queue,
				EVENTS_EXCHANGE,
				CAMPAIGNS_ROUTING_KEYS[kind]
			);
			const deadLetterQueue = `${queue}.dead-letter`;
			await channel.assertQueue(deadLetterQueue, { durable: true });
			await channel.bindQueue(
				deadLetterQueue,
				DEAD_LETTER_EXCHANGE,
				getCampaignsDeadLetterRoutingKey(kind)
			);
			for (const [index, delay] of CAMPAIGNS_RETRY_DELAYS_MS.entries()) {
				const retryQueue = `${queue}.retry.${index + 1}`;
				await channel.assertQueue(retryQueue, {
					durable: true,
					messageTtl: delay,
					deadLetterExchange: EVENTS_EXCHANGE,
					deadLetterRoutingKey: CAMPAIGNS_ROUTING_KEYS[kind]
				});
				await channel.bindQueue(
					retryQueue,
					CAMPAIGNS_RETRY_EXCHANGE,
					getCampaignsRetryRoutingKey(kind, index)
				);
			}
		}
	}

	private registerReturnHandler(channel: ConfirmChannel): void {
		channel.on('return', message => {
			const raw = message.properties.headers?.['x-publication-token'];
			const token = Buffer.isBuffer(raw)
				? raw.toString('utf8')
				: typeof raw === 'string'
					? raw
					: '';
			if (!token || !this.returnedPublications.has(token)) return;
			this.returnedPublications.set(
				token,
				new Error(
					`RabbitMQ returned publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}: ${message.fields.replyCode} ${message.fields.replyText}`
				)
			);
		});
	}

	private parseAssertTopology(
		value: string | boolean | undefined
	): boolean {
		if (value === true || value === 'true') return true;
		if (value === false || value === 'false') return false;
		throw new Error(
			'RABBITMQ_ASSERT_TOPOLOGY must be explicitly set for campaigns messaging processes'
		);
	}

	private getMaxMessageBytes(): number {
		const value = Number(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES') ||
				DEFAULT_MAX_MESSAGE_BYTES
		);
		return Number.isInteger(value) && value >= 1024
			? Math.min(value, 10 * 1024 * 1024)
			: DEFAULT_MAX_MESSAGE_BYTES;
	}
}
