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
import {
	parseControlEvent,
	type ControlEvent
} from './widget-control.contract';

export const CONTROL_EXCHANGE =
	'winwidget.crm-intake.widget-control.events';
export const CONTROL_DEAD_EXCHANGE =
	'winwidget.crm-intake.widget-control.dead-letter';
export const CONTROL_QUEUE = 'winwidget.crm-intake.widget-control.v1';
export const CONTROL_EVENT_TYPE = 'crm.intake.widget-control.requested.v1';
export const CONTROL_DEAD_QUEUE = `${CONTROL_QUEUE}.dead-letter`;
export const CONTROL_REQUEUE_DELAY_MS = 5000;

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
	private readonly requeueWaits = new Map<
		ConsumeMessage,
		{ finish: () => void; promise: Promise<void> }
	>();

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
		for (const exchange of [CONTROL_EXCHANGE, CONTROL_DEAD_EXCHANGE])
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
			!['MAIN', 'DLQ'].includes(route) ||
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
				route === 'MAIN' ? CONTROL_EXCHANGE : CONTROL_DEAD_EXCHANGE,
				CONTROL_EVENT_TYPE,
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
				this.interruptRequeues(channel);
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
						this.nack(message);
						return;
					}
					void handler(message).catch(() =>
						this.nackAfterBackoff(message)
					);
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
	async nackAfterBackoff(message: ConsumeMessage): Promise<void> {
		if (this.stopping || !this.deliveryChannels.has(message)) {
			this.nack(message);
			return;
		}
		const pending = this.requeueWaits.get(message);
		if (pending) return pending.promise;
		let finish: () => void = () => {};
		const promise = new Promise<void>(resolve => {
			let settled = false;
			const timer = setTimeout(() => finish(), CONTROL_REQUEUE_DELAY_MS);
			timer.unref();
			finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.requeueWaits.delete(message);
				this.nack(message);
				resolve();
			};
		});
		// The push channel's prefetch bounds these unacknowledged waits to five.
		this.requeueWaits.set(message, { finish, promise });
		return promise;
	}
	private interruptRequeues(channel?: ConfirmChannel) {
		for (const [message, pending] of this.requeueWaits)
			if (!channel || this.deliveryChannels.get(message) === channel)
				pending.finish();
	}
	async cancel() {
		this.stopping = true;
		this.interruptRequeues();
		if (this.consumerTag && this.consumerChannel)
			await this.consumerChannel
				.cancel(this.consumerTag)
				.catch(() => undefined);
		this.consumerTag = null;
	}
	async onApplicationShutdown() {
		await this.cancel().catch(() => undefined);
		await this.channel?.close();
		await this.connection?.close();
	}
}
