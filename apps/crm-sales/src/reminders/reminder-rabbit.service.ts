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
	REMINDER_EXCHANGE,
	REMINDER_QUEUE,
	REMINDER_TICK
} from './reminder-delivery.contract';

@Injectable()
export class ReminderRabbitService
	implements OnModuleInit, OnApplicationShutdown
{
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private consumer: { channel: ConfirmChannel; tag: string } | null = null;
	private returns = new Map<string, boolean>();
	private origins = new WeakMap<ConsumeMessage, ConfirmChannel>();
	async onModuleInit() {
		const url = process.env.RABBITMQ_URL;
		if (
			!url ||
			process.env.RABBITMQ_CONNECTION_NAME !==
				'winwidget-crm-sales-reminders'
		)
			throw new Error('REMINDER_BROKER_CONFIGURATION');
		this.connection = connect([url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name: 'winwidget-crm-sales-reminders'
				}
			}
		});
		this.connection.on('disconnect', () => {
			this.consumer = null;
		});
		this.channel = this.connection.createChannel({
			confirm: true,
			publishTimeout: 15_000,
			setup: async (channel: ConfirmChannel) => {
				channel.on('return', message => {
					const key = message.properties.headers?.['x-publication-token'];
					if (typeof key === 'string' && this.returns.has(key))
						this.returns.set(key, true);
				});
			}
		});
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				(async () => {
					await this.connection!.connect({ timeout: 15_000 });
					await this.channel!.waitForConnect();
				})(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error('REMINDER_BROKER_START_TIMEOUT')),
						20_000
					);
				})
			]);
		} catch {
			await this.onApplicationShutdown();
			throw new Error('REMINDER_BROKER_START_FAILED');
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	isReady() {
		return !!this.connection?.isConnected() && !!this.consumer;
	}
	async consume(handler: (message: ConsumeMessage) => Promise<void>) {
		if (!this.channel) throw new Error('REMINDER_BROKER_DISABLED');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			// The release controller owns topology/ACL. Runtime only consumes the exact queue.
			await channel.prefetch(1, false);
			const { consumerTag } = await channel.consume(
				REMINDER_QUEUE,
				message => {
					if (!message) {
						this.consumer = null;
						return;
					}
					this.origins.set(message, channel);
					void handler(message).catch(() => this.nack(message));
				},
				{ noAck: false }
			);
			this.consumer = { channel, tag: consumerTag };
		});
	}
	async publish(messageId: string, eventType: string, payload: unknown) {
		if (!this.channel) throw new Error('REMINDER_BROKER_DISABLED');
		if (
			eventType !== REMINDER_TICK &&
			!/^notification\.wincrm\.task-reminder\.(email|telegram)\.requested\.v1$/.test(
				eventType
			)
		)
			throw new Error('REMINDER_OUTBOX_ROUTE');
		const body = Buffer.from(JSON.stringify(payload));
		if (body.length > 2048) throw new Error('REMINDER_OUTBOX_SIZE');
		const token = randomUUID();
		this.returns.set(token, false);
		try {
			await this.channel.publish(REMINDER_EXCHANGE, eventType, body, {
				messageId,
				type: eventType,
				contentType: 'application/json',
				contentEncoding: 'utf-8',
				deliveryMode: 2,
				mandatory: true,
				headers: { 'x-publication-token': token }
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			if (this.returns.get(token))
				throw new Error('REMINDER_PUBLICATION_RETURNED');
		} finally {
			this.returns.delete(token);
		}
	}
	ack(message: ConsumeMessage) {
		this.origins.get(message)?.ack(message);
	}
	nack(message: ConsumeMessage, requeue = true) {
		this.origins.get(message)?.nack(message, false, requeue);
	}
	async stopConsumers() {
		const consumer = this.consumer;
		this.consumer = null;
		if (consumer) await consumer.channel.cancel(consumer.tag);
	}
	async onApplicationShutdown() {
		await this.stopConsumers().catch(() => undefined);
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
		this.channel = null;
		this.connection = null;
	}
}
