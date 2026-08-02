import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { waitForReportingShutdown } from '../common/reporting-shutdown';
import {
	REPORTING_ACCEPTED_ROUTING_KEYS,
	REPORTING_CONSUMER_KINDS,
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_EVENTS_EXCHANGE,
	REPORTING_MANUAL_RETRY_EXCHANGE,
	REPORTING_QUEUE_NAMES,
	REPORTING_RETRY_DELAYS_MS,
	REPORTING_RETRY_EXCHANGE,
	REPORTING_ROUTING_KEYS,
	ReportingConsumerKind,
	getReportingDeadLetterRoutingKey,
	getReportingManualRetryRoutingKey,
	getReportingRetryRoutingKey
} from './reporting-messaging.constants';
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
const RABBITMQ_SHUTDOWN_TIMEOUT_MS = 10_000;

interface ConsumerRegistration {
	setup: SetupFunc;
	channel: ConfirmChannel | null;
	consumerTag: string | null;
}

export type ReportingPublishExchange =
	| typeof REPORTING_EVENTS_EXCHANGE
	| typeof REPORTING_RETRY_EXCHANGE
	| typeof REPORTING_MANUAL_RETRY_EXCHANGE
	| typeof REPORTING_DEAD_LETTER_EXCHANGE;

@Injectable()
export class ReportingRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(ReportingRabbitMqService.name);
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

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: ReportingRuntimeService,
		private readonly metrics: ReportingMetricsService
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
						`winwidget-reporting-${this.runtime.role}-${process.pid}`
				}
			}
		});
		this.connection.on('connect', () => {
			this.logger.log('Connected to RabbitMQ');
			this.metrics.setGauge('rabbitmq_connected', 1);
		});
		this.connection.on('disconnect', ({ err }) => {
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`);
			this.metrics.setGauge('rabbitmq_connected', 0);
			this.topologyReady = false;
		});
		this.channel = this.connection.createChannel({
			name: `winwidget-reporting-${this.runtime.role}`,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				this.topologyReady = false;
				this.registerReturnHandler(channel);
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

	areConsumersReady(): boolean {
		return (
			!this.runtime.workerEnabled ||
			(this.registrations.size === REPORTING_CONSUMER_KINDS.length &&
				[...this.registrations].every(
					registration => registration.consumerTag !== null
				))
		);
	}

	async publish(
		exchange: ReportingPublishExchange,
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
			// RabbitMQ sends basic.return before the publisher confirmation for an
			// unroutable mandatory message. Yield once so both callbacks have been
			// observed before an Outbox row can be marked PUBLISHED.
			await new Promise<void>(resolve => setImmediate(resolve));
			const returned = this.returnedPublications.get(publicationToken);
			if (returned) throw returned;
			this.metrics.increment('rabbitmq_publications_confirmed_total');
		} finally {
			this.returnedPublications.delete(publicationToken);
		}
	}

	async consume(
		kind: ReportingConsumerKind,
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
					REPORTING_QUEUE_NAMES[kind],
					message => {
						if (!message) {
							registration.consumerTag = null;
							this.logger.error(
								`RabbitMQ cancelled reporting consumer kind=${kind}`
							);
							return;
						}
						this.deliveryChannels.set(message, channel);
						if (this.stopping) return;
						void handler(message).catch(error => {
							this.logger.error(
								`Unhandled reporting consumer error kind=${kind}: ${this.error(error)}`
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
		const closed = await waitForReportingShutdown(
			Promise.allSettled([
				this.cancelConsumers(),
				this.channel?.close() || Promise.resolve(),
				this.connection?.close() || Promise.resolve()
			]),
			RABBITMQ_SHUTDOWN_TIMEOUT_MS
		);
		if (!closed) {
			this.logger.warn('RabbitMQ shutdown exceeded 10000ms');
		}
	}

	private async assertTopology(channel: ConfirmChannel): Promise<void> {
		// Shared exchanges are provisioned by deployment and intentionally are not
		// declared with the schema-scoped Reporting RabbitMQ credentials.
		await channel.assertExchange(REPORTING_RETRY_EXCHANGE, 'direct', {
			durable: true
		});
		await channel.assertExchange(
			REPORTING_MANUAL_RETRY_EXCHANGE,
			'direct',
			{
				durable: true
			}
		);
		for (const kind of REPORTING_CONSUMER_KINDS) {
			const queue = REPORTING_QUEUE_NAMES[kind];
			await channel.assertQueue(queue, { durable: true });
			for (const routingKey of REPORTING_ACCEPTED_ROUTING_KEYS[kind]) {
				await channel.bindQueue(
					queue,
					REPORTING_EVENTS_EXCHANGE,
					routingKey
				);
			}
			await channel.bindQueue(
				queue,
				REPORTING_MANUAL_RETRY_EXCHANGE,
				getReportingManualRetryRoutingKey(kind)
			);
			const deadLetterQueue = `${queue}.dead-letter`;
			await channel.assertQueue(deadLetterQueue, { durable: true });
			await channel.bindQueue(
				deadLetterQueue,
				REPORTING_DEAD_LETTER_EXCHANGE,
				getReportingDeadLetterRoutingKey(kind)
			);
			for (const [index, delay] of REPORTING_RETRY_DELAYS_MS.entries()) {
				const retryQueue = `${queue}.retry.${index + 1}`;
				await channel.assertQueue(retryQueue, {
					durable: true,
					messageTtl: delay,
					deadLetterExchange: REPORTING_EVENTS_EXCHANGE,
					deadLetterRoutingKey: REPORTING_ROUTING_KEYS[kind]
				});
				await channel.bindQueue(
					retryQueue,
					REPORTING_RETRY_EXCHANGE,
					getReportingRetryRoutingKey(kind, index)
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
			'RABBITMQ_ASSERT_TOPOLOGY must be explicitly set for reporting messaging processes'
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
