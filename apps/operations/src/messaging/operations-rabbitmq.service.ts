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
import { randomUUID } from 'node:crypto';
import {
	parseOperationsBoundedInteger,
	parseOperationsStrictBoolean,
	OperationsRuntimeService
} from '../runtime/operations-runtime.service';
import {
	getOperationsAuditDeadLetterQueue,
	getOperationsAuditDeadLetterRoutingKey,
	getOperationsAuditQueue,
	getOperationsAuditRetryQueue,
	getOperationsAuditRetryRoutingKey,
	OPERATIONS_AUDIT_EVENT_TYPE,
	OPERATIONS_AUDIT_SOURCES,
	OPERATIONS_DATABASE_RESTORE_DLQ,
	OPERATIONS_DATABASE_RESTORE_QUEUE,
	OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
	OPERATIONS_DEAD_LETTER_EXCHANGE,
	OPERATIONS_EVENTS_EXCHANGE,
	OPERATIONS_MANUAL_RETRY_EXCHANGE,
	OPERATIONS_RETRY_EXCHANGE,
	OPERATIONS_SCHEDULED_JOB_DLQ,
	OPERATIONS_SCHEDULED_JOB_QUEUE,
	OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE,
	OperationsAuditSource
} from './operations-messaging.constants';

export type OperationsConsumeDecision = 'ack' | 'requeue' | 'reject';
export type OperationsAuditHandler = (
	source: OperationsAuditSource,
	message: ConsumeMessage
) => Promise<OperationsConsumeDecision>;
export type OperationsJobHandler = (
	message: ConsumeMessage
) => Promise<OperationsConsumeDecision>;

@Injectable()
export class OperationsRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(OperationsRabbitMqService.name);
	private readonly returnedPublications = new Map<string, Error | null>();
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private topologyReady = false;
	private consumerReady = false;
	private maxMessageBytes = 256 * 1024;
	private consumerRegistered = false;
	private jobConsumerRegistered = false;
	private jobConsumerReady = false;
	private consumerGeneration = 0;
	private readonly consumerTags = new Map<string, string>();

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: OperationsRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.rabbitEnabled) return;
		await this.connect();
	}

	async consumeAuditEvents(
		handler: OperationsAuditHandler
	): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		await this.registerAuditTopology(handler);
	}

	async prepareAuditTopology(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		await this.registerAuditTopology();
	}

	async consumeScheduledJobs(
		handler: OperationsJobHandler
	): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		await this.consumeOperationalQueue(
			OPERATIONS_SCHEDULED_JOB_QUEUE,
			OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE,
			OPERATIONS_SCHEDULED_JOB_DLQ,
			handler
		);
	}

	async consumeDatabaseRestoreJobs(
		handler: OperationsJobHandler
	): Promise<void> {
		if (!this.runtime.restoreWorkerEnabled) return;
		await this.consumeOperationalQueue(
			OPERATIONS_DATABASE_RESTORE_QUEUE,
			OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
			OPERATIONS_DATABASE_RESTORE_DLQ,
			handler
		);
	}

	private async registerAuditTopology(
		handler?: OperationsAuditHandler
	): Promise<void> {
		if (this.consumerRegistered) {
			throw new Error('Operations audit topology is already registered');
		}
		this.consumerRegistered = true;
		await this.connect();
		if (!this.channel) throw new Error('RabbitMQ channel is unavailable');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			const generation = ++this.consumerGeneration;
			this.consumerReady = false;
			this.consumerTags.clear();
			await channel.checkExchange(OPERATIONS_EVENTS_EXCHANGE);
			await channel.checkExchange(OPERATIONS_RETRY_EXCHANGE);
			await channel.checkExchange(OPERATIONS_DEAD_LETTER_EXCHANGE);
			await channel.checkExchange(OPERATIONS_MANUAL_RETRY_EXCHANGE);
			await channel.prefetch(10);
			for (const source of OPERATIONS_AUDIT_SOURCES) {
				const consumerTag = await this.setupAuditSource(
					channel,
					source,
					handler,
					generation
				);
				if (consumerTag) this.consumerTags.set(source.source, consumerTag);
			}
			this.consumerReady =
				!handler ||
				this.consumerTags.size === OPERATIONS_AUDIT_SOURCES.length;
		});
	}

	async publish(
		exchange: string,
		routingKey: string,
		payload: unknown,
		options: Options.Publish = {}
	): Promise<void> {
		if (!this.channel) throw new Error('RabbitMQ publisher is disabled');
		this.assertPublishBoundary(exchange);
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > this.maxMessageBytes) {
			throw new Error('RabbitMQ payload exceeds configured limit');
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

	private assertPublishBoundary(exchange: string): void {
		const consumerEnabled =
			this.runtime.workerEnabled || this.runtime.restoreWorkerEnabled;
		const allowedExchanges = consumerEnabled
			? [OPERATIONS_RETRY_EXCHANGE, OPERATIONS_DEAD_LETTER_EXCHANGE]
			: [OPERATIONS_EVENTS_EXCHANGE, OPERATIONS_MANUAL_RETRY_EXCHANGE];
		if (!allowedExchanges.includes(exchange)) {
			const processLabel = this.runtime.restoreWorkerEnabled
				? 'restore worker'
				: this.runtime.workerEnabled
					? 'worker'
					: 'outbox publisher';
			throw new Error(
				`RabbitMQ exchange is not allowed for the Operations ${processLabel}`
			);
		}
	}

	publishAuditRetry(
		source: OperationsAuditSource,
		payload: unknown,
		eventId: string,
		attempt: number,
		delayMs: number
	): Promise<void> {
		return this.publish(
			OPERATIONS_RETRY_EXCHANGE,
			getOperationsAuditRetryRoutingKey(source),
			payload,
			{
				messageId: eventId,
				type: OPERATIONS_AUDIT_EVENT_TYPE,
				expiration: String(delayMs),
				headers: { 'x-retry-attempt': attempt }
			}
		);
	}

	publishAuditDeadLetter(
		source: OperationsAuditSource,
		payload: unknown,
		eventId: string,
		attempt: number
	): Promise<void> {
		return this.publish(
			OPERATIONS_DEAD_LETTER_EXCHANGE,
			getOperationsAuditDeadLetterRoutingKey(source),
			payload,
			{
				messageId: eventId,
				type: OPERATIONS_AUDIT_EVENT_TYPE,
				headers: {
					'x-retry-attempt': attempt,
					'x-dead-letter-reason': 'AUDIT_RETRY_BUDGET_EXHAUSTED'
				}
			}
		);
	}

	isConnected(): boolean {
		return (
			!this.runtime.rabbitEnabled ||
			Boolean(this.connection?.isConnected())
		);
	}

	isReady(): boolean {
		if (!this.runtime.rabbitEnabled) return true;
		if (!this.topologyReady) return false;
		if (this.runtime.workerEnabled) {
			return (
				this.consumerReady &&
				(!this.jobConsumerRegistered || this.jobConsumerReady)
			);
		}
		if (this.runtime.restoreWorkerEnabled) {
			return this.jobConsumerRegistered && this.jobConsumerReady;
		}
		return true;
	}

	async onApplicationShutdown(): Promise<void> {
		this.consumerGeneration += 1;
		this.consumerTags.clear();
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.topologyReady = false;
		this.consumerReady = false;
		this.jobConsumerReady = false;
	}

	private async consumeOperationalQueue(
		queue: string,
		retryQueue: string,
		deadLetterQueue: string,
		handler: OperationsJobHandler
	): Promise<void> {
		if (this.jobConsumerRegistered) {
			throw new Error('Operations job consumer is already registered');
		}
		this.jobConsumerRegistered = true;
		await this.connect();
		if (!this.channel) throw new Error('RabbitMQ channel is unavailable');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			this.jobConsumerReady = false;
			await channel.prefetch(this.runtime.restoreWorkerEnabled ? 1 : 10);
			await channel.checkQueue(queue);
			await channel.checkQueue(retryQueue);
			await channel.checkQueue(deadLetterQueue);
			const consumerTag = await this.consumeQueue(channel, queue, handler);
			this.jobConsumerReady = Boolean(consumerTag);
		});
	}

	private async connect(): Promise<void> {
		if (this.channel) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const expectedConnectionName = this.runtime.restoreWorkerEnabled
			? 'winwidget-operations-restore-worker'
			: this.runtime.workerEnabled
				? 'winwidget-operations-worker'
				: 'winwidget-operations-outbox-publisher';
		const connectionName = this.config
			.get<string>('RABBITMQ_CONNECTION_NAME')
			?.trim();
		if (connectionName !== expectedConnectionName) {
			throw new Error(
				`RABBITMQ_CONNECTION_NAME must be ${expectedConnectionName}`
			);
		}
		const consumerEnabled =
			this.runtime.workerEnabled || this.runtime.restoreWorkerEnabled;
		const assertTopology = parseOperationsStrictBoolean(
			this.config.get<string>('RABBITMQ_ASSERT_TOPOLOGY'),
			consumerEnabled,
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (assertTopology !== consumerEnabled) {
			throw new Error(
				`RABBITMQ_ASSERT_TOPOLOGY must be ${consumerEnabled}`
			);
		}
		this.maxMessageBytes = parseOperationsBoundedInteger(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES'),
			256 * 1024,
			1_024,
			10 * 1024 * 1024,
			'RABBITMQ_MAX_MESSAGE_BYTES'
		);
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: { connection_name: connectionName }
			}
		});
		this.connection.on('disconnect', () => {
			this.consumerGeneration += 1;
			this.consumerTags.clear();
			this.topologyReady = false;
			this.consumerReady = false;
			this.jobConsumerReady = false;
			this.logger.warn('RabbitMQ disconnected');
		});
		this.channel = this.connection.createChannel({
			name: expectedConnectionName,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				this.topologyReady = false;
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
						new Error('RabbitMQ returned mandatory publication')
					);
				});
				this.topologyReady = true;
			}
		});
		await this.connection.connect({ timeout: 15_000 });
		await this.channel.waitForConnect();
	}

	private async setupAuditSource(
		channel: ConfirmChannel,
		source: OperationsAuditSource,
		handler: OperationsAuditHandler | undefined,
		generation: number
	): Promise<string | null> {
		const queue = getOperationsAuditQueue(source);
		const retryQueue = getOperationsAuditRetryQueue(source);
		const deadLetterQueue = getOperationsAuditDeadLetterQueue(source);
		await channel.checkQueue(queue);
		await channel.checkQueue(retryQueue);
		await channel.checkQueue(deadLetterQueue);
		if (!handler) return null;
		const consumer = await channel.consume(
			queue,
			message => {
				if (!message) {
					this.handleConsumerCancellation(channel, source, generation);
					return;
				}
				void handler(source, message)
					.then(decision => {
						if (decision === 'ack') channel.ack(message);
						else if (decision === 'reject')
							channel.nack(message, false, false);
						else channel.nack(message, false, true);
					})
					.catch(() => channel.nack(message, false, true));
			},
			{ noAck: false }
		);
		return consumer.consumerTag;
	}

	private async consumeQueue(
		channel: ConfirmChannel,
		queue: string,
		handler: OperationsJobHandler
	): Promise<string> {
		const consumer = await channel.consume(
			queue,
			message => {
				if (!message) {
					this.jobConsumerReady = false;
					void channel.close().catch(() => undefined);
					return;
				}
				void handler(message)
					.then(decision => {
						if (decision === 'ack') channel.ack(message);
						else if (decision === 'reject') {
							channel.nack(message, false, false);
						} else channel.nack(message, false, true);
					})
					.catch(() => channel.nack(message, false, true));
			},
			{ noAck: false }
		);
		return consumer.consumerTag;
	}

	private handleConsumerCancellation(
		channel: ConfirmChannel,
		source: OperationsAuditSource,
		generation: number
	): void {
		if (generation !== this.consumerGeneration) return;
		this.consumerTags.delete(source.source);
		this.consumerReady = false;
		this.logger.error(
			`RabbitMQ cancelled Operations consumer for ${source.source}`
		);
		void channel.close().catch(error => {
			this.logger.error(
				`Failed to close cancelled Operations consumer channel: ${String(error)}`
			);
		});
	}
}
