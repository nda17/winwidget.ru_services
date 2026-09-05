import {
	Injectable,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	connect,
	type AmqpConnectionManager,
	type ChannelWrapper
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { CONTROL_RETRY_MS } from './widget-control.contract';
import {
	parseControlEvent,
	type ControlEvent
} from './widget-control.contract';

export const CONTROL_EXCHANGE =
	'winwidget.crm-intake.widget-control.events';
export const CONTROL_RETRY_EXCHANGE =
	'winwidget.crm-intake.widget-control.retry';
export const CONTROL_DEAD_EXCHANGE =
	'winwidget.crm-intake.widget-control.dead-letter';
export const CONTROL_QUEUE = 'winwidget.crm-intake.widget-control.v1';
export const CONTROL_EVENT_TYPE = 'crm.intake.widget-control.requested.v1';
export const CONTROL_DEAD_QUEUE = `${CONTROL_QUEUE}.dead-letter`;

@Injectable()
export class WidgetControlRabbit
	implements OnModuleInit, OnApplicationShutdown
{
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private consumerChannel: ConfirmChannel | null = null;
	private consumerTag: string | null = null;
	private stopping = false;
	private channelReady = false;
	private readonly returns = new Map<string, boolean>();
	private readonly deliveryChannels = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	async onModuleInit() {
		const value = process.env.CRM_INTAKE_RABBITMQ_URL || '';
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error('CRM_INTAKE_RABBITMQ_URL must be configured');
		}
		if (
			!(
				url.protocol === 'amqps:' ||
				(url.protocol === 'amqp:' &&
					['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
			)
		)
			throw new Error('RabbitMQ requires TLS except on loopback');
		if (!url.username || !url.password)
			throw new Error('RabbitMQ requires scoped credentials');
		const assertTopology =
			process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY === 'true';
		if (
			!['true', 'false', undefined].includes(
				process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY
			)
		)
			throw new Error(
				'CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY must be boolean'
			);
		this.connection = connect([value], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5
		});
		this.connection.on('disconnect', () => {
			this.consumerTag = null;
			this.channelReady = false;
		});
		this.channel = this.connection.createChannel({
			confirm: true,
			publishTimeout: 15000,
			setup: async (channel: ConfirmChannel) => {
				this.channelReady = false;
				channel.once('close', () => {
					this.channelReady = false;
				});
				channel.on('return', message => {
					const token =
						message.properties.headers?.['x-publication-token'];
					if (typeof token === 'string' && this.returns.has(token))
						this.returns.set(token, true);
				});
				if (assertTopology) await this.topology(channel);
				this.channelReady = true;
			}
		});
		this.channel.on('error', () => {
			this.channelReady = false;
		});
		let timeout: NodeJS.Timeout | undefined;
		try {
			await this.connection.connect({ timeout: 15000 });
			await Promise.race([
				this.channel.waitForConnect(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error('BROKER_CHANNEL_TIMEOUT')),
						15000
					);
				})
			]);
		} catch {
			await this.channel.close().catch(() => undefined);
			await this.connection.close().catch(() => undefined);
			throw new Error('CRM Intake messaging initialization failed');
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	private async topology(channel: ConfirmChannel) {
		for (const exchange of [
			CONTROL_EXCHANGE,
			CONTROL_RETRY_EXCHANGE,
			CONTROL_DEAD_EXCHANGE
		])
			await channel.assertExchange(exchange, 'direct', { durable: true });
		await channel.assertQueue(CONTROL_QUEUE, { durable: true });
		await channel.bindQueue(
			CONTROL_QUEUE,
			CONTROL_EXCHANGE,
			CONTROL_EVENT_TYPE
		);
		await channel.assertQueue(CONTROL_DEAD_QUEUE, { durable: true });
		await channel.bindQueue(
			CONTROL_DEAD_QUEUE,
			CONTROL_DEAD_EXCHANGE,
			CONTROL_EVENT_TYPE
		);
		for (let i = 0; i < CONTROL_RETRY_MS.length; i++) {
			const queue = `${CONTROL_QUEUE}.retry.${i + 1}`;
			await channel.assertQueue(queue, {
				durable: true,
				arguments: {
					'x-message-ttl': CONTROL_RETRY_MS[i],
					'x-dead-letter-exchange': CONTROL_EXCHANGE,
					'x-dead-letter-routing-key': CONTROL_EVENT_TYPE
				}
			});
			await channel.bindQueue(
				queue,
				CONTROL_RETRY_EXCHANGE,
				`widget-control.retry.${i + 1}`
			);
		}
	}
	ready(worker = false) {
		return Boolean(
			this.connection?.isConnected() &&
			this.channelReady &&
			!this.stopping &&
			(!worker || this.consumerTag)
		);
	}
	async publish(event: ControlEvent, route: string, retryAttempt: number) {
		if (!this.channel || this.stopping)
			throw new Error('PUBLISHER_UNAVAILABLE');
		parseControlEvent(event);
		if (
			!['MAIN', 'RETRY_1', 'RETRY_2', 'RETRY_3', 'DLQ'].includes(route) ||
			!Number.isInteger(retryAttempt) ||
			retryAttempt < 0 ||
			retryAttempt > 3
		)
			throw new Error('INVALID_ROUTE');
		const body = Buffer.from(JSON.stringify(event));
		if (body.length > 16384) throw new Error('MESSAGE_SIZE');
		const publication = randomUUID();
		this.returns.set(publication, false);
		try {
			await this.channel.publish(
				route === 'MAIN'
					? CONTROL_EXCHANGE
					: route === 'DLQ'
						? CONTROL_DEAD_EXCHANGE
						: CONTROL_RETRY_EXCHANGE,
				route.startsWith('RETRY_')
					? `widget-control.retry.${route.slice(-1)}`
					: CONTROL_EVENT_TYPE,
				body,
				{
					contentType: 'application/json',
					contentEncoding: 'utf-8',
					persistent: true,
					mandatory: true,
					messageId: event.eventId,
					type: CONTROL_EVENT_TYPE,
					headers: {
						'x-publication-token': publication,
						'x-retry-attempt': retryAttempt
					}
				}
			);
			if (this.returns.get(publication))
				throw new Error('MANDATORY_RETURN');
		} finally {
			this.returns.delete(publication);
		}
	}
	async consume(handler: (message: ConsumeMessage) => Promise<void>) {
		if (!this.channel) throw new Error('CONSUMER_UNAVAILABLE');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			this.consumerChannel = channel;
			this.consumerTag = null;
			channel.once('close', () => {
				if (this.consumerChannel === channel) this.consumerTag = null;
			});
			await channel.prefetch(5, false);
			const registration = await channel.consume(
				CONTROL_QUEUE,
				message => {
					if (!message) {
						this.consumerTag = null;
						void channel.close().catch(() => undefined);
						return;
					}
					this.deliveryChannels.set(message, channel);
					if (this.stopping) {
						channel.nack(message, false, true);
						return;
					}
					void handler(message).catch(() => this.nack(message));
				},
				{ noAck: false }
			);
			this.consumerTag = registration.consumerTag;
		});
	}
	ack(message: ConsumeMessage) {
		const channel = this.deliveryChannels.get(message);
		if (channel) {
			try {
				channel.ack(message);
			} catch {
				// A closed transport will redeliver; the committed receipt makes that replay safe.
			} finally {
				this.deliveryChannels.delete(message);
			}
		}
	}
	nack(message: ConsumeMessage) {
		const channel = this.deliveryChannels.get(message);
		if (channel) {
			try {
				channel.nack(message, false, true);
			} catch {
				// Closed channels already return unacknowledged deliveries to the broker.
			} finally {
				this.deliveryChannels.delete(message);
			}
		}
	}
	async cancel() {
		this.stopping = true;
		if (this.consumerTag && this.consumerChannel)
			await this.consumerChannel.cancel(this.consumerTag);
		this.consumerTag = null;
	}
	async onApplicationShutdown() {
		await this.cancel().catch(() => undefined);
		await this.channel?.close();
		await this.connection?.close();
	}
}
