import {
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	MANUAL_RETRY_EXCHANGE,
	MESSAGING_KINDS,
	MESSAGING_QUEUE_NAMES,
	MESSAGING_ROUTING_KEYS,
	MessagingKind,
	RETRY_DELAYS_MS,
	RETRY_EXCHANGE
} from '@/messaging/messaging.constants';
import {
	createMessagingHeaders,
	runWithMessageContext
} from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
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
	consumerTag: string | null;
	channel: ConfirmChannel | null;
}

export interface DeadLetterClassificationMetadata {
	category: string;
	normalizedCode: string;
	safeReason: string;
	httpStatus?: number | null;
	providerCode?: string | null;
	retryable: boolean;
	classificationVersion: number;
	firstFailedAt?: string;
	deliveryToken?: string;
}

@Injectable()
export class RabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(RabbitMqService.name);
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly returnedPublications = new Map<string, Error | null>();
	private readonly consumerRegistrations = new Set<ConsumerRegistration>();
	private consumersStopping = false;
	private consumerRecoveryRequested = false;
	private assertTopologyEnabled = false;
	private connection!: AmqpConnectionManager;
	private channel!: ChannelWrapper;

	constructor(private readonly configService: ConfigService) {}

	async onModuleInit(): Promise<void> {
		const url = this.configService.get<string>('RABBITMQ_URL');
		if (!url) {
			throw new Error('RABBITMQ_URL is required for messaging processes');
		}
		this.assertTopologyEnabled = this.getAssertTopologyEnabled();

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
		this.connection.on('connect', () => {
			this.consumerRecoveryRequested = false;
			this.logger.log('Connected to RabbitMQ');
		});
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
			setup: async channel => {
				const confirmChannel = channel as ConfirmChannel;
				this.registerReturnHandler(confirmChannel);
				if (this.assertTopologyEnabled) {
					await this.assertTopology(confirmChannel);
				}
			}
		});

		this.channel.on('error', error =>
			this.logger.error(`RabbitMQ channel error: ${error.message}`)
		);

		await this.connection.connect({ timeout: 15_000 });
		await this.channel.waitForConnect();
	}

	isConnected(): boolean {
		return this.connection?.isConnected() ?? false;
	}

	areConsumersReady(): boolean {
		return (
			this.consumerRegistrations.size > 0 &&
			[...this.consumerRegistrations].every(
				registration => registration.consumerTag !== null
			)
		);
	}

	async publishEvent(
		routingKey: string,
		payload: unknown,
		options: Options.Publish = {}
	): Promise<void> {
		const messageId =
			typeof options.messageId === 'string' ? options.messageId : '';
		const eventType = typeof options.type === 'string' ? options.type : '';
		assertMessagingEventContract(payload, {
			eventType,
			routingKey,
			messageId
		});
		await this.publishConfirmed(EVENTS_EXCHANGE, routingKey, payload, {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			deliveryMode: 2,
			mandatory: true,
			timestamp: Date.now(),
			...options
		});
	}

	async publishRetry(
		kind: MessagingKind,
		payload: unknown,
		attempt: number,
		eventId: string,
		eventType: string
	): Promise<void> {
		const retryIndex = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
		const routingKey = this.getRetryRoutingKey(kind, retryIndex);

		await this.publishConfirmed(RETRY_EXCHANGE, routingKey, payload, {
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			deliveryMode: 2,
			mandatory: true,
			messageId: eventId,
			type: eventType,
			headers: createMessagingHeaders({
				messageId: eventId,
				causationId: eventId,
				headers: { 'x-retry-attempt': attempt }
			}),
			timestamp: Date.now()
		});
	}

	async publishDeadLetter(
		kind: MessagingKind,
		payload: unknown,
		attempt: number,
		eventId: string,
		error: string,
		eventType: string,
		classification?: DeadLetterClassificationMetadata
	): Promise<void> {
		await this.publishConfirmed(
			DEAD_LETTER_EXCHANGE,
			getDeadLetterRoutingKey(kind),
			payload,
			{
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				messageId: eventId,
				type: eventType,
				headers: createMessagingHeaders({
					messageId: eventId,
					causationId: eventId,
					headers: {
						'x-retry-attempt': attempt,
						'x-last-error': error.slice(0, 1000),
						...(classification
							? {
									'x-error-category': classification.category,
									'x-error-code': classification.normalizedCode.slice(
										0,
										255
									),
									'x-safe-reason': classification.safeReason.slice(
										0,
										1000
									),
									'x-error-retryable': classification.retryable,
									'x-classification-version':
										classification.classificationVersion,
									...(classification.firstFailedAt
										? {
												'x-first-failed-at': classification.firstFailedAt
											}
										: {}),
									...(classification.deliveryToken
										? {
												'x-delivery-token': classification.deliveryToken
											}
										: {}),
									...(classification.httpStatus !== null &&
									classification.httpStatus !== undefined
										? {
												'x-http-status': classification.httpStatus
											}
										: {}),
									...(classification.providerCode
										? {
												'x-provider-code':
													classification.providerCode.slice(0, 255)
											}
										: {})
								}
							: {})
					}
				}),
				timestamp: Date.now()
			}
		);
	}

	private async publishConfirmed(
		exchange: string,
		routingKey: string,
		payload: unknown,
		options: Options.Publish
	): Promise<void> {
		const publicationToken = randomUUID();
		const content = this.encodePayload(payload);
		const messageId =
			typeof options.messageId === 'string' && options.messageId
				? options.messageId
				: publicationToken;
		const contextHeaders = createMessagingHeaders({
			messageId,
			headers: this.getScalarHeaders(options.headers)
		});
		const correlationId =
			typeof options.correlationId === 'string' && options.correlationId
				? options.correlationId
				: String(contextHeaders['x-correlation-id']);
		this.returnedPublications.set(publicationToken, null);
		try {
			await this.channel.publish(exchange, routingKey, content, {
				...options,
				correlationId,
				headers: {
					...(options.headers || {}),
					...contextHeaders,
					'x-publication-token': publicationToken
				}
			});
			const returned = this.returnedPublications.get(publicationToken);
			if (returned) throw returned;
		} finally {
			this.returnedPublications.delete(publicationToken);
		}
	}

	private encodePayload(payload: unknown): Buffer {
		const content = Buffer.from(JSON.stringify(payload));
		const configured = Number(
			this.configService.get<string>('RABBITMQ_MAX_MESSAGE_BYTES') ||
				DEFAULT_MAX_MESSAGE_BYTES
		);
		const maxBytes =
			Number.isInteger(configured) && configured >= 1024
				? Math.min(configured, 10 * 1024 * 1024)
				: DEFAULT_MAX_MESSAGE_BYTES;
		if (content.length > maxBytes) {
			throw new Error(
				`RabbitMQ payload exceeds limit bytes=${content.length} maxBytes=${maxBytes}`
			);
		}
		return content;
	}

	private getScalarHeaders(
		headers: Options.Publish['headers']
	): Record<string, string | number | boolean> {
		if (!headers) return {};
		return Object.fromEntries(
			Object.entries(headers).filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
		);
	}

	async consume(
		kind: MessagingKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		await this.consumeQueue(
			MESSAGING_QUEUE_NAMES[kind],
			`${kind} integration`,
			handler,
			prefetch
		);
	}

	async consumeDeadLetter(
		kind: MessagingKind,
		handler: (message: ConsumeMessage) => Promise<void>,
		prefetch: number
	): Promise<void> {
		await this.consumeQueue(
			`${MESSAGING_QUEUE_NAMES[kind]}.dead-letter`,
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
		if (this.consumersStopping) {
			throw new Error('RabbitMQ consumers are stopping');
		}

		const registration: ConsumerRegistration = {
			consumerTag: null,
			channel: null,
			setup: async channel => {
				registration.consumerTag = null;
				const deliveryChannel = channel as ConfirmChannel;
				registration.channel = deliveryChannel;
				deliveryChannel.once('close', () => {
					if (registration.channel === deliveryChannel) {
						registration.channel = null;
						registration.consumerTag = null;
					}
				});
				await deliveryChannel.prefetch(prefetch, false);
				const consumer = await deliveryChannel.consume(
					queue,
					message => {
						if (!message) {
							registration.consumerTag = null;
							this.requestConsumerRecovery(consumerName);
							return;
						}
						this.deliveryChannels.set(message, deliveryChannel);
						if (this.consumersStopping) {
							return;
						}
						void runWithMessageContext(message, () =>
							handler(message)
						).catch(error => {
							this.logger.error(
								`Unhandled ${consumerName} consumer error: ${
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
		this.consumerRegistrations.add(registration);
		try {
			await this.channel.addSetup(registration.setup);
		} catch (error) {
			this.consumerRegistrations.delete(registration);
			await this.channel
				.removeSetup(registration.setup)
				.catch(() => undefined);
			throw error;
		}
	}

	private requestConsumerRecovery(consumerName: string): void {
		if (this.consumersStopping || this.consumerRecoveryRequested) {
			return;
		}

		this.consumerRecoveryRequested = true;
		this.logger.warn(
			`RabbitMQ cancelled the ${consumerName} consumer; reconnecting to restore subscriptions`
		);
		if (!this.connection.isConnected()) {
			return;
		}

		try {
			this.connection.reconnect();
		} catch (error) {
			this.consumerRecoveryRequested = false;
			this.logger.error(
				`Failed to request RabbitMQ consumer recovery: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	async cancelConsumers(): Promise<void> {
		this.consumersStopping = true;
		const registrations = [...this.consumerRegistrations];
		this.consumerRegistrations.clear();
		const results = await Promise.allSettled(
			registrations.map(registration =>
				this.channel.removeSetup(registration.setup, async channel => {
					const consumerTag = registration.consumerTag;
					registration.consumerTag = null;
					registration.channel = null;
					if (consumerTag) {
						await (channel as ConfirmChannel).cancel(consumerTag);
					}
				})
			)
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult =>
				result.status === 'rejected'
		);
		if (failures.length) {
			throw new AggregateError(
				failures.map(result => result.reason),
				`Failed to cancel ${failures.length} RabbitMQ consumer(s)`
			);
		}
	}

	ack(message: ConsumeMessage): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) {
			this.logger.warn(
				'Skipped ack for a message without its delivery channel'
			);
			return;
		}
		try {
			channel.ack(message);
		} catch (error) {
			this.logger.warn(
				`Skipped ack on a closed delivery channel: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		} finally {
			this.deliveryChannels.delete(message);
		}
	}

	nack(message: ConsumeMessage, requeue: boolean): void {
		const channel = this.deliveryChannels.get(message);
		if (!channel) {
			this.logger.warn(
				'Skipped nack for a message without its delivery channel'
			);
			return;
		}
		try {
			channel.nack(message, false, requeue);
		} catch (error) {
			this.logger.warn(
				`Skipped nack on a closed delivery channel: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		} finally {
			this.deliveryChannels.delete(message);
		}
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.channel) {
			await this.channel.close();
		}
		if (this.connection) {
			await this.connection.close();
		}
	}

	private registerReturnHandler(channel: ConfirmChannel): void {
		channel.on('return', message => {
			const publicationToken =
				message.properties.headers?.['x-publication-token'];
			const normalizedToken = Buffer.isBuffer(publicationToken)
				? publicationToken.toString('utf8')
				: typeof publicationToken === 'string'
					? publicationToken
					: null;
			if (!normalizedToken) {
				this.logger.error(
					`RabbitMQ returned an uncorrelated publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}: ${message.fields.replyText}`
				);
				return;
			}
			if (!this.returnedPublications.has(normalizedToken)) {
				this.logger.warn(
					`RabbitMQ returned a publication after its confirm timeout publicationToken=${normalizedToken}`
				);
				return;
			}
			this.returnedPublications.set(
				normalizedToken,
				new Error(
					`RabbitMQ returned publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}: ${message.fields.replyCode} ${message.fields.replyText}`
				)
			);
		});
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

		for (const kind of MESSAGING_KINDS) {
			const queue = MESSAGING_QUEUE_NAMES[kind];
			const routingKey = MESSAGING_ROUTING_KEYS[kind];
			const deadLetterQueue = `${queue}.dead-letter`;

			await channel.assertQueue(queue, {
				durable: true,
				...(kind === 'database-backup'
					? { arguments: { 'x-single-active-consumer': true } }
					: {})
			});
			await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
			await channel.bindQueue(
				queue,
				EVENTS_EXCHANGE,
				getManualRetryRoutingKey(kind)
			);
			await channel.bindQueue(queue, MANUAL_RETRY_EXCHANGE, kind);

			await channel.assertQueue(deadLetterQueue, { durable: true });
			await channel.bindQueue(
				deadLetterQueue,
				DEAD_LETTER_EXCHANGE,
				getDeadLetterRoutingKey(kind)
			);
			await channel.bindQueue(
				deadLetterQueue,
				EVENTS_EXCHANGE,
				getDeadLetterRoutingKey(kind)
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

	private getAssertTopologyEnabled(): boolean {
		const configured = this.configService.get<string | boolean>(
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (configured === true || configured === 'true') return true;
		if (configured === false || configured === 'false') return false;

		throw new Error(
			'RABBITMQ_ASSERT_TOPOLOGY must be explicitly set to true for the topology owner or false for workers'
		);
	}

	private getRetryRoutingKey(kind: MessagingKind, index: number): string {
		return `${kind}.retry.${index + 1}`;
	}
}
