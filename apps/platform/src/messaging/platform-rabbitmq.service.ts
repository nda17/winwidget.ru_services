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
import type { ConfirmChannel, Options } from 'amqplib';
import { randomUUID } from 'node:crypto';
import {
	parsePlatformBoundedInteger,
	parsePlatformStrictBoolean,
	PlatformRuntimeService
} from '../runtime/platform-runtime.service';

@Injectable()
export class PlatformRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(PlatformRabbitMqService.name);
	private readonly topologySetups = new WeakMap<
		ConfirmChannel,
		Promise<void>
	>();
	private readonly returnedPublications = new Map<string, Error | null>();
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private currentTopologySetup: Promise<void> | null = null;
	private topologyReady = false;
	private maxMessageBytes = 256 * 1024;

	constructor(
		private readonly config: ConfigService,
		private readonly runtime: PlatformRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.outboxPublisherEnabled) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const expectedConnectionName = 'winwidget-platform-outbox-publisher';
		const connectionName = this.config
			.get<string>('RABBITMQ_CONNECTION_NAME')
			?.trim();
		if (connectionName !== expectedConnectionName) {
			throw new Error(
				`RABBITMQ_CONNECTION_NAME must be ${expectedConnectionName}`
			);
		}
		const assertTopology = parsePlatformStrictBoolean(
			this.config.get<string>('RABBITMQ_ASSERT_TOPOLOGY'),
			false,
			'RABBITMQ_ASSERT_TOPOLOGY'
		);
		if (assertTopology) {
			throw new Error(
				'RABBITMQ_ASSERT_TOPOLOGY must be false for Platform publisher'
			);
		}
		this.maxMessageBytes = parsePlatformBoundedInteger(
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
		this.connection.on('disconnect', ({ err }) => {
			this.topologyReady = false;
			this.logger.warn(`RabbitMQ disconnected: ${err.message}`);
		});
		this.channel = this.connection.createChannel({
			name: expectedConnectionName,
			confirm: true,
			publishTimeout: 15_000,
			setup: (channel: ConfirmChannel) => this.ensureSetup(channel)
		});
		await this.connection.connect({ timeout: 15_000 });
		await this.waitForConnectedTopology();
	}

	isConnected(): boolean {
		return (
			!this.runtime.outboxPublisherEnabled ||
			Boolean(this.connection?.isConnected())
		);
	}

	isTopologyReady(): boolean {
		return !this.runtime.outboxPublisherEnabled || this.topologyReady;
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

	async onApplicationShutdown(): Promise<void> {
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.topologyReady = false;
	}

	private ensureSetup(channel: ConfirmChannel): Promise<void> {
		const existing = this.topologySetups.get(channel);
		if (existing) return existing;
		const setup = this.setup(channel);
		this.topologySetups.set(channel, setup);
		this.currentTopologySetup = setup;
		return setup;
	}

	private async setup(channel: ConfirmChannel): Promise<void> {
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
				new Error(
					`RabbitMQ returned mandatory publication exchange=${message.fields.exchange} routingKey=${message.fields.routingKey}`
				)
			);
		});
		this.topologyReady = true;
	}

	private async waitForConnectedTopology(): Promise<void> {
		if (!this.channel) {
			throw new Error('RabbitMQ channel is not initialized');
		}
		await this.channel.waitForConnect();
		const setup = this.currentTopologySetup;
		if (!setup) throw new Error('RabbitMQ topology setup did not start');
		await setup;
	}
}
