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
import { waitForWidgetsShutdown } from '../common/widgets-shutdown';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	getWidgetsDeadLetterRoutingKey,
	getWidgetsManualRetryRoutingKey,
	getWidgetsRetryRoutingKey,
	WIDGETS_DEAD_LETTER_EXCHANGE,
	WIDGETS_EVENTS_EXCHANGE,
	WIDGETS_MANUAL_RETRY_EXCHANGE,
	WIDGETS_CONSUMER_KINDS,
	WIDGETS_PROJECTION_KINDS,
	WidgetsConsumerKind,
	WIDGETS_QUEUE_NAMES,
	WIDGETS_RETRY_DELAYS_MS,
	WIDGETS_RETRY_EXCHANGE,
	WIDGETS_ROUTING_KEYS
} from './widgets-messaging.constants';

const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const RABBITMQ_SHUTDOWN_TIMEOUT_MS = 10_000;

interface ConsumerRegistration {
	setup: SetupFunc;
	channel: ConfirmChannel | null;
	consumerTag: string | null;
}

export type WidgetsPublishExchange =
	| typeof WIDGETS_EVENTS_EXCHANGE
	| typeof WIDGETS_RETRY_EXCHANGE
	| typeof WIDGETS_MANUAL_RETRY_EXCHANGE
	| typeof WIDGETS_DEAD_LETTER_EXCHANGE;

@Injectable()
export class WidgetsRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(WidgetsRabbitMqService.name);
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly registrations = new Set<ConsumerRegistration>();
	private readonly returnedPublications = new Map<string, Error | null>();
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private stopping = false;
	private topologyReady = false;
	private consumerRecoveryRequested = false;

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: WidgetsRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.rabbitEnabled) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const assertTopology = this.parseAssertTopology(
			this.config.get<string | boolean>('RABBITMQ_ASSERT_TOPOLOGY')
		);
		const topologyKinds = this.parseTopologyKinds(
			this.config.get<string>('WIDGETS_RABBITMQ_TOPOLOGY_SCOPE')
		);
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name:
						this.config.get<string>('RABBITMQ_CONNECTION_NAME') ||
						`winwidget-widgets-${this.runtime.role}-${process.pid}`
				}
			}
		});
		this.connection.on('connect', () => {
			this.consumerRecoveryRequested = false;
			this.logger.log('Connected to RabbitMQ');
		});
		this.connection.on('disconnect', ({ err }) => {
			this.topologyReady = false;
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`);
		});
		this.channel = this.connection.createChannel({
			name: `winwidget-widgets-${this.runtime.role}`,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				this.topologyReady = false;
				this.registerReturnHandler(channel);
				if (assertTopology) {
					await this.assertTopology(channel, topologyKinds);
				}
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

	areConsumersReady(): boolean {
		return (
			!this.runtime.workerEnabled ||
			(this.registrations.size === WIDGETS_CONSUMER_KINDS.length &&
				[...this.registrations].every(
					registration => registration.consumerTag !== null
				))
		);
	}

	async publish(
		exchange: WidgetsPublishExchange,
		routingKey: string,
		payload: unknown,
		options: Options.Publish
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ publisher is disabled');
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > this.maxMessageBytes()) {
			throw new Error(
				`RabbitMQ payload exceeds limit bytes=${body.length}`
			);
		}
		const publicationToken = randomUUID();
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
			// RabbitMQ emits basic.return before confirm for an unroutable mandatory
			// publication. Yield once so both callbacks are visible to this claim.
			await new Promise<void>(resolve => setImmediate(resolve));
			const returned = this.returnedPublications.get(publicationToken);
			if (returned) throw returned;
		} finally {
			this.returnedPublications.delete(publicationToken);
		}
	}

	async consume(
		kind: WidgetsConsumerKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ consumer is disabled');
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
					WIDGETS_QUEUE_NAMES[kind],
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
								`Unhandled Widgets consumer error kind=${kind}: ${this.error(error)}`
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
		const closed = await waitForWidgetsShutdown(
			Promise.allSettled([
				this.cancelConsumers(),
				this.channel?.close() || Promise.resolve(),
				this.connection?.close() || Promise.resolve()
			]),
			RABBITMQ_SHUTDOWN_TIMEOUT_MS
		);
		if (!closed) this.logger.warn('RabbitMQ shutdown exceeded 10000ms');
	}

	private async assertTopology(
		channel: ConfirmChannel,
		consumerKinds: readonly WidgetsConsumerKind[]
	): Promise<void> {
		// Shared exchanges are deployment-owned. The Widgets credentials own only
		// service-local retry/manual queues and bindings.
		await channel.assertExchange(WIDGETS_RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		await channel.assertExchange(WIDGETS_MANUAL_RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		for (const kind of consumerKinds) {
			const queue = WIDGETS_QUEUE_NAMES[kind];
			await channel.assertQueue(queue, { durable: true });
			await channel.bindQueue(
				queue,
				WIDGETS_EVENTS_EXCHANGE,
				WIDGETS_ROUTING_KEYS[kind]
			);
			await channel.bindQueue(
				queue,
				WIDGETS_MANUAL_RETRY_EXCHANGE,
				getWidgetsManualRetryRoutingKey(kind)
			);
			const deadLetterQueue = `${queue}.dead-letter`;
			await channel.assertQueue(deadLetterQueue, { durable: true });
			await channel.bindQueue(
				deadLetterQueue,
				WIDGETS_DEAD_LETTER_EXCHANGE,
				getWidgetsDeadLetterRoutingKey(kind)
			);
			for (const [index, delay] of WIDGETS_RETRY_DELAYS_MS.entries()) {
				const retryQueue = `${queue}.retry.${index + 1}`;
				await channel.assertQueue(retryQueue, {
					durable: true,
					messageTtl: delay,
					deadLetterExchange: WIDGETS_EVENTS_EXCHANGE,
					deadLetterRoutingKey: WIDGETS_ROUTING_KEYS[kind]
				});
				await channel.bindQueue(
					retryQueue,
					WIDGETS_RETRY_EXCHANGE,
					getWidgetsRetryRoutingKey(kind, index)
				);
			}
		}
	}

	private parseTopologyKinds(
		value: string | undefined
	): readonly WidgetsConsumerKind[] {
		const scope = value?.trim() || 'all';
		if (scope === 'all') return WIDGETS_CONSUMER_KINDS;
		if (scope === 'projections') {
			if (this.runtime.workerEnabled || this.runtime.publisherEnabled) {
				throw new Error(
					'Projection-only Widgets RabbitMQ topology is forbidden for worker or publisher runtimes'
				);
			}
			return WIDGETS_PROJECTION_KINDS;
		}
		throw new Error(
			'WIDGETS_RABBITMQ_TOPOLOGY_SCOPE must be all or projections'
		);
	}

	private requestConsumerRecovery(kind: WidgetsConsumerKind): void {
		if (this.stopping || this.consumerRecoveryRequested) return;
		this.consumerRecoveryRequested = true;
		this.logger.warn(
			`RabbitMQ cancelled Widgets consumer kind=${kind}; reconnecting`
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
				`Could not reconnect Widgets consumer kind=${kind}: ${this.error(error)}`
			);
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
					`RabbitMQ returned mandatory publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}: ${message.fields.replyCode} ${message.fields.replyText}`
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
			'RABBITMQ_ASSERT_TOPOLOGY must be explicitly set for Widgets messaging processes'
		);
	}

	private maxMessageBytes(): number {
		const value = Number(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES') ||
				DEFAULT_MAX_MESSAGE_BYTES
		);
		return Number.isInteger(value) && value >= 1024
			? Math.min(value, 10 * 1024 * 1024)
			: DEFAULT_MAX_MESSAGE_BYTES;
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
