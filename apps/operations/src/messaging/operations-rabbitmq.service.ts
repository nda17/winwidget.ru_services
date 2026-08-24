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
	OPERATIONS_DEAD_LETTER_EXCHANGE,
	OPERATIONS_EVENTS_EXCHANGE,
	OPERATIONS_RETRY_EXCHANGE,
	OperationsAuditSource
} from './operations-messaging.constants';

export type OperationsConsumeDecision = 'ack' | 'requeue' | 'reject';
export type OperationsAuditHandler = (
	source: OperationsAuditSource,
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
		if (this.consumerRegistered) {
			throw new Error('Operations audit consumer is already registered');
		}
		this.consumerRegistered = true;
		await this.connect();
		if (!this.channel) throw new Error('RabbitMQ channel is unavailable');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			this.consumerReady = false;
			await channel.assertExchange(OPERATIONS_EVENTS_EXCHANGE, 'topic', {
				durable: true
			});
			await channel.assertExchange(OPERATIONS_RETRY_EXCHANGE, 'direct', {
				durable: true
			});
			await channel.assertExchange(
				OPERATIONS_DEAD_LETTER_EXCHANGE,
				'topic',
				{ durable: true }
			);
			await channel.prefetch(10);
			for (const source of OPERATIONS_AUDIT_SOURCES) {
				await this.setupAuditSource(channel, source, handler);
			}
			this.consumerReady = true;
		});
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
		return !this.runtime.workerEnabled || this.consumerReady;
	}

	async onApplicationShutdown(): Promise<void> {
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.topologyReady = false;
		this.consumerReady = false;
	}

	private async connect(): Promise<void> {
		if (this.channel) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const expectedConnectionName = this.runtime.workerEnabled
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
		const assertTopology = parseOperationsStrictBoolean(
			this.config.get<string>('RABBITMQ_ASSERT_TOPOLOGY'),
			this.runtime.workerEnabled,
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (assertTopology !== this.runtime.workerEnabled) {
			throw new Error(
				`RABBITMQ_ASSERT_TOPOLOGY must be ${this.runtime.workerEnabled}`
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
			this.topologyReady = false;
			this.consumerReady = false;
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
		handler: OperationsAuditHandler
	): Promise<void> {
		const queue = getOperationsAuditQueue(source);
		const retryQueue = getOperationsAuditRetryQueue(source);
		const deadLetterQueue = getOperationsAuditDeadLetterQueue(source);
		const deadLetterRoutingKey =
			getOperationsAuditDeadLetterRoutingKey(source);
		await channel.assertQueue(queue, {
			durable: true,
			arguments: {
				'x-dead-letter-exchange': OPERATIONS_DEAD_LETTER_EXCHANGE,
				'x-dead-letter-routing-key': deadLetterRoutingKey
			}
		});
		await channel.bindQueue(
			queue,
			OPERATIONS_EVENTS_EXCHANGE,
			source.routingKey
		);
		await channel.assertQueue(retryQueue, {
			durable: true,
			arguments: {
				'x-dead-letter-exchange': OPERATIONS_EVENTS_EXCHANGE,
				'x-dead-letter-routing-key': source.routingKey
			}
		});
		await channel.bindQueue(
			retryQueue,
			OPERATIONS_RETRY_EXCHANGE,
			getOperationsAuditRetryRoutingKey(source)
		);
		await channel.assertQueue(deadLetterQueue, { durable: true });
		await channel.bindQueue(
			deadLetterQueue,
			OPERATIONS_DEAD_LETTER_EXCHANGE,
			deadLetterRoutingKey
		);
		await channel.consume(
			queue,
			message => {
				if (!message) return;
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
	}
}
