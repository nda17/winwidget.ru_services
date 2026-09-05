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
import { randomUUID } from 'node:crypto';
import { CrmAccessRuntimeService } from '../runtime/crm-access-runtime.service';
import { TEAM_EVENTS, type TeamConsumer } from './team.util';
import {
	TEAM_CONSUMERS,
	TEAM_RETRY_DELAYS,
	teamQueue,
	teamRetryRoute,
	teamRoute
} from './team-messaging.contract';

@Injectable()
export class CrmTeamRabbitService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(CrmTeamRabbitService.name);
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private readonly deliveries = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly consumers = new Map<
		TeamConsumer,
		{ channel: ConfirmChannel; tag: string }
	>();
	private readonly returns = new Map<string, boolean>();
	constructor(
		private readonly config: ConfigService,
		private readonly runtime: CrmAccessRuntimeService
	) {}
	async onModuleInit() {
		if (!this.runtime.rabbitEnabled) return;
		const url = this.config.get<string>('RABBITMQ_URL')?.trim();
		if (!url) throw new Error('RABBITMQ_URL is required');
		const name = `winwidget-crm-access-${this.runtime.role}`;
		if (
			this.config.get<string>('RABBITMQ_CONNECTION_NAME')?.trim() !== name
		)
			throw new Error(`RABBITMQ_CONNECTION_NAME must be ${name}`);
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: { clientProperties: { connection_name: name } }
		});
		this.connection.on('disconnect', () => {
			this.consumers.clear();
			this.logger.warn('CRM team broker disconnected');
		});
		this.channel = this.connection.createChannel({
			name,
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				channel.on('return', message => {
					const token =
						message.properties.headers?.['x-publication-token'];
					if (typeof token === 'string' && this.returns.has(token))
						this.returns.set(token, true);
				});
				if (this.runtime.workerEnabled) await this.topology(channel);
			}
		});
		await this.connection.connect({ timeout: 15_000 });
		await this.channel.waitForConnect();
	}
	isReady() {
		return (
			!this.runtime.rabbitEnabled ||
			Boolean(
				this.connection?.isConnected() &&
				(!this.runtime.workerEnabled ||
					this.consumers.size === TEAM_CONSUMERS.length)
			)
		);
	}
	async publish(
		exchange: string,
		routingKey: string,
		payload: unknown,
		options: Options.Publish
	) {
		if (!this.channel || !this.runtime.publisherEnabled)
			throw new Error('CRM publisher is disabled');
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > 32_768)
			throw new Error('CRM team event exceeds byte limit');
		const token = randomUUID();
		this.returns.set(token, false);
		try {
			await this.channel.publish(exchange, routingKey, body, {
				...options,
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				headers: { ...options.headers, 'x-publication-token': token }
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			if (this.returns.get(token))
				throw new Error('CRM team publication was returned');
		} finally {
			this.returns.delete(token);
		}
	}
	async consume(
		consumer: TeamConsumer,
		handler: (message: ConsumeMessage) => Promise<void>
	) {
		if (!this.channel || !this.runtime.workerEnabled)
			throw new Error('CRM consumer is disabled');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			await channel.prefetch(4, false);
			const { consumerTag } = await channel.consume(
				teamQueue(consumer),
				message => {
					if (!message) {
						this.consumers.delete(consumer);
						return;
					}
					this.deliveries.set(message, channel);
					void handler(message).catch(() => {
						this.logger.error('CRM team delivery transaction failed');
						this.nack(message);
					});
				},
				{ noAck: false }
			);
			this.consumers.set(consumer, { channel, tag: consumerTag });
		});
	}
	ack(message: ConsumeMessage) {
		this.deliveries.get(message)?.ack(message);
	}
	nack(message: ConsumeMessage) {
		this.deliveries.get(message)?.nack(message, false, true);
	}
	async stopConsumers() {
		for (const value of this.consumers.values())
			await value.channel.cancel(value.tag).catch(() => undefined);
		this.consumers.clear();
	}
	async onApplicationShutdown() {
		await this.stopConsumers();
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.channel = null;
		this.connection = null;
	}
	private async topology(channel: ConfirmChannel) {
		for (const [name, type] of [
			['winwidget.events', 'topic'],
			['winwidget.retry', 'direct'],
			['winwidget.dead-letter', 'topic'],
			['winwidget.manual-retry', 'direct']
		] as const)
			await channel.assertExchange(name, type, { durable: true });
		for (const consumer of TEAM_CONSUMERS) {
			const queue = teamQueue(consumer);
			const route = teamRoute(consumer);
			await channel.assertQueue(queue, { durable: true });
			await channel.bindQueue(
				queue,
				'winwidget.events',
				TEAM_EVENTS[consumer]
			);
			await channel.bindQueue(queue, 'winwidget.manual-retry', route);
			await channel.assertQueue(`${queue}.dead-letter`, { durable: true });
			await channel.bindQueue(
				`${queue}.dead-letter`,
				'winwidget.dead-letter',
				`${route}.dead-letter`
			);
			for (const [index, delay] of TEAM_RETRY_DELAYS.entries()) {
				const retryQueue = `${queue}.retry.${index + 1}`;
				await channel.assertQueue(retryQueue, {
					durable: true,
					messageTtl: delay,
					deadLetterExchange: 'winwidget.manual-retry',
					deadLetterRoutingKey: route
				});
				await channel.bindQueue(
					retryQueue,
					'winwidget.retry',
					teamRetryRoute(consumer, index + 1)
				);
			}
		}
	}
}
