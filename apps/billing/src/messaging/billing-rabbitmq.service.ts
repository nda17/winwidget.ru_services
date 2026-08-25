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
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import {
	parseBoundedInteger,
	parseStrictBoolean
} from '../runtime/billing-runtime.service';
import {
	BILLING_CONSUMER_KINDS,
	BillingConsumerKind,
	BILLING_DEAD_LETTER_EXCHANGE,
	BILLING_EVENTS_EXCHANGE,
	BILLING_QUEUE_NAMES,
	BILLING_RETRY_DELAYS_MS,
	BILLING_RETRY_EXCHANGE,
	BILLING_ROUTING_KEYS,
	billingDeadLetterRoutingKey,
	billingRetryRoutingKey
} from './billing-messaging.constants';

interface ConsumerRegistration {
	setup: SetupFunc;
	channel: ConfirmChannel | null;
	consumerTag: string | null;
}

@Injectable()
export class BillingRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(BillingRabbitMqService.name);
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly registrations = new Map<
		BillingConsumerKind,
		ConsumerRegistration
	>();
	private readonly topologySetups = new WeakMap<
		ConfirmChannel,
		Promise<void>
	>();
	private readonly returnedPublications = new Map<string, Error | null>();
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private currentTopologySetup: Promise<void> | null = null;
	private assertTopologyEnabled = false;
	private topologyReady = false;
	private stopping = false;
	private maxMessageBytes = 256 * 1024;

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: BillingRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.rabbitEnabled) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const expectedConnectionName = `winwidget-billing-${this.runtime.role}`;
		const connectionName = this.config
			.get<string>('RABBITMQ_CONNECTION_NAME')
			?.trim();
		if (connectionName !== expectedConnectionName) {
			throw new Error(
				`RABBITMQ_CONNECTION_NAME must be ${expectedConnectionName}`
			);
		}
		this.maxMessageBytes = parseBoundedInteger(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES'),
			256 * 1024,
			1_024,
			10 * 1024 * 1024,
			'RABBITMQ_MAX_MESSAGE_BYTES'
		);
		const assertTopology = parseStrictBoolean(
			this.config.get<string>('RABBITMQ_ASSERT_TOPOLOGY'),
			this.runtime.workerEnabled,
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (assertTopology !== this.runtime.workerEnabled) {
			throw new Error(
				`RABBITMQ_ASSERT_TOPOLOGY must be ${this.runtime.workerEnabled} for role ${this.runtime.role}`
			);
		}
		this.assertTopologyEnabled = assertTopology;
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name: connectionName
				}
			}
		});
		this.connection.on('disconnect', ({ err }) => {
			this.topologyReady = false;
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`);
		});
		this.channel = this.connection.createChannel({
			name: `winwidget-billing-${this.runtime.role}`,
			confirm: true,
			publishTimeout: 15_000,
			setup: (channel: ConfirmChannel) => this.ensureTopologySetup(channel)
		});
		await this.connection.connect({ timeout: 15_000 });
		await this.waitForConnectedTopology();
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
			BILLING_CONSUMER_KINDS.every(kind =>
				Boolean(this.registrations.get(kind)?.consumerTag)
			)
		);
	}

	async publish(
		exchange: string,
		routingKey: string,
		payload: unknown,
		options: Options.Publish = {}
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ publisher is disabled');
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > this.maxMessageBytes) {
			throw new Error(
				`RabbitMQ payload exceeds limit bytes=${body.length}`
			);
		}
		const publicationToken = randomUUID();
		this.returnedPublications.set(publicationToken, null);
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
			const returned = this.returnedPublications.get(publicationToken);
			if (returned) throw returned;
		} finally {
			this.returnedPublications.delete(publicationToken);
		}
	}

	async consume(
		kind: BillingConsumerKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch = 10
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ consumer is disabled');
		await this.waitForConnectedTopology();
		const wrapper = this.channel;
		const registration: ConsumerRegistration = {
			channel: null,
			consumerTag: null,
			setup: async (channel: ConfirmChannel) => {
				registration.channel = channel;
				registration.consumerTag = null;
				await this.ensureTopologySetup(channel);
				await channel.prefetch(prefetch, false);
				const consumer = await channel.consume(
					BILLING_QUEUE_NAMES[kind],
					message => {
						if (!message || this.stopping) return;
						this.deliveryChannels.set(message, channel);
						void handler(message).catch(error => {
							this.logger.error(
								`Unhandled Billing consumer error kind=${kind}: ${this.error(error)}`
							);
							this.nack(message, true);
						});
					},
					{ noAck: false }
				);
				registration.consumerTag = consumer.consumerTag;
			}
		};
		this.registrations.set(kind, registration);
		try {
			await wrapper.addSetup(registration.setup);
		} catch (error) {
			if (this.registrations.get(kind) === registration) {
				this.registrations.delete(kind);
			}
			await wrapper.removeSetup(registration.setup).catch(() => undefined);
			throw error;
		}
	}

	ack(message: ConsumeMessage): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) return;
		channel.ack(message);
		this.deliveryChannels.delete(message);
	}

	nack(message: ConsumeMessage, requeue: boolean): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) return;
		channel.nack(message, false, requeue);
		this.deliveryChannels.delete(message);
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.channel) {
			for (const registration of this.registrations.values()) {
				await this.channel.removeSetup(
					registration.setup,
					async (channel: ConfirmChannel) => {
						if (registration.consumerTag) {
							await channel.cancel(registration.consumerTag);
						}
					}
				);
			}
		}
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
	}

	private async assertWorkerTopology(
		channel: ConfirmChannel
	): Promise<void> {
		await channel.assertExchange(BILLING_RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		await channel.assertExchange(BILLING_DEAD_LETTER_EXCHANGE, 'direct', {
			durable: true
		});
		for (const kind of BILLING_CONSUMER_KINDS) {
			const queue = BILLING_QUEUE_NAMES[kind];
			await channel.assertQueue(queue, {
				durable: true,
				arguments: { 'x-queue-type': 'classic' }
			});
			await channel.bindQueue(
				queue,
				BILLING_EVENTS_EXCHANGE,
				BILLING_ROUTING_KEYS[kind]
			);
			await channel.bindQueue(
				queue,
				BILLING_RETRY_EXCHANGE,
				BILLING_ROUTING_KEYS[kind]
			);
			const deadLetterQueue = `${queue}.dead-letter`;
			await channel.assertQueue(deadLetterQueue, {
				durable: true,
				arguments: { 'x-queue-type': 'classic' }
			});
			await channel.bindQueue(
				deadLetterQueue,
				BILLING_DEAD_LETTER_EXCHANGE,
				billingDeadLetterRoutingKey(kind)
			);
			for (const [index, delay] of BILLING_RETRY_DELAYS_MS.entries()) {
				const attempt = index + 1;
				const retryQueue = `${queue}.retry.${attempt}`;
				await channel.assertQueue(retryQueue, {
					durable: true,
					arguments: { 'x-queue-type': 'classic' },
					messageTtl: delay,
					deadLetterExchange: BILLING_RETRY_EXCHANGE,
					deadLetterRoutingKey: BILLING_ROUTING_KEYS[kind]
				});
				await channel.bindQueue(
					retryQueue,
					BILLING_RETRY_EXCHANGE,
					billingRetryRoutingKey(kind, attempt)
				);
			}
		}
	}

	private ensureTopologySetup(channel: ConfirmChannel): Promise<void> {
		const existing = this.topologySetups.get(channel);
		if (existing) return existing;
		const setup = this.setupTopology(channel);
		this.topologySetups.set(channel, setup);
		this.currentTopologySetup = setup;
		return setup;
	}

	private async setupTopology(channel: ConfirmChannel): Promise<void> {
		this.topologyReady = false;
		this.registerReturnHandler(channel);
		if (this.assertTopologyEnabled) {
			await this.assertWorkerTopology(channel);
		}
		this.topologyReady = true;
	}

	private async waitForConnectedTopology(): Promise<void> {
		if (!this.channel)
			throw new Error('RabbitMQ channel is not initialized');
		await this.channel.waitForConnect();
		const setup = this.currentTopologySetup;
		if (!setup) throw new Error('RabbitMQ topology setup did not start');
		await setup;
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
					`RabbitMQ returned mandatory publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}`
				)
			);
		});
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
