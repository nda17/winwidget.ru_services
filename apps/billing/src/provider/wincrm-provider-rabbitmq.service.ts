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
import { BILLING_EVENTS_EXCHANGE } from '../messaging/billing-messaging.constants';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import {
	WINCRM_PROVIDER_DEAD_EXCHANGE,
	WINCRM_PROVIDER_DEAD_QUEUE,
	WINCRM_PROVIDER_EVENT,
	WINCRM_PROVIDER_QUEUE,
	WINCRM_PROVIDER_REQUEUE_MS,
	wincrmProviderMessagingEnabled,
	wincrmProviderBrokerConfiguration
} from './wincrm-provider.config';

/** Own push consumer; retries are delayed in PostgreSQL, never in TTL/DLX queues. */
@Injectable()
export class WincrmProviderRabbitMqService
	implements OnModuleInit, OnApplicationShutdown
{
	private connection: AmqpConnectionManager | null = null;
	private channel: ChannelWrapper | null = null;
	private consumerTag: string | null = null;
	private consumerChannel: ConfirmChannel | null = null;
	private stopping = false;
	private readonly deliveries = new WeakMap<
		ConsumeMessage,
		ConfirmChannel
	>();
	private readonly waits = new Set<() => void>();

	constructor(private readonly runtime: BillingRuntimeService) {}

	async onModuleInit() {
		if (!wincrmProviderMessagingEnabled() || !this.runtime.workerEnabled)
			return;
		const configuration = wincrmProviderBrokerConfiguration();
		this.connection = connect([configuration.url], {
			heartbeatIntervalInSeconds: 10,
			reconnectTimeInSeconds: 5,
			connectionOptions: {
				clientProperties: {
					connection_name: 'winwidget-billing-wincrm-provider-worker'
				}
			}
		});
		this.connection.on('disconnect', () => {
			this.consumerTag = null;
		});
		this.channel = this.connection.createChannel({
			name: 'winwidget-billing-wincrm-provider-worker',
			confirm: true,
			setup: async (channel: ConfirmChannel) => {
				if (!configuration.assertTopology) return;
				// winwidget.events is provisioned by the broker owner, not by this credential.
				await channel.assertExchange(
					WINCRM_PROVIDER_DEAD_EXCHANGE,
					'direct',
					{ durable: true }
				);
				await channel.assertQueue(WINCRM_PROVIDER_QUEUE, {
					durable: true
				});
				await channel.bindQueue(
					WINCRM_PROVIDER_QUEUE,
					BILLING_EVENTS_EXCHANGE,
					WINCRM_PROVIDER_EVENT
				);
				await channel.assertQueue(WINCRM_PROVIDER_DEAD_QUEUE, {
					durable: true
				});
				await channel.bindQueue(
					WINCRM_PROVIDER_DEAD_QUEUE,
					WINCRM_PROVIDER_DEAD_EXCHANGE,
					WINCRM_PROVIDER_EVENT
				);
			}
		});
		// Never let a broker/library error include credential-bearing connection details.
		this.channel.on('error', () => {
			this.consumerTag = null;
		});
		let timeout: NodeJS.Timeout | undefined;
		try {
			await this.connection.connect({ timeout: 15_000 });
			await Promise.race([
				this.channel.waitForConnect(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(
						() => reject(new Error('BROKER_CHANNEL_TIMEOUT')),
						15_000
					);
				})
			]);
		} catch {
			await this.channel.close().catch(() => undefined);
			await this.connection.close().catch(() => undefined);
			throw new Error('WinCRM provider messaging initialization failed');
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	isReady() {
		return (
			!wincrmProviderMessagingEnabled() ||
			!this.runtime.workerEnabled ||
			Boolean(
				!this.stopping &&
				this.connection?.isConnected() &&
				this.consumerTag
			)
		);
	}

	async consume(handler: (message: ConsumeMessage) => Promise<void>) {
		if (!this.channel || this.stopping)
			throw new Error('WinCRM provider consumer is unavailable');
		await this.channel.addSetup(async (channel: ConfirmChannel) => {
			this.consumerChannel = channel;
			this.consumerTag = null;
			channel.once('close', () => {
				if (this.consumerChannel === channel) this.consumerTag = null;
			});
			await channel.prefetch(5, false);
			const consumer = await channel.consume(
				WINCRM_PROVIDER_QUEUE,
				message => {
					if (!message || this.stopping) return;
					this.deliveries.set(message, channel);
					void handler(message).catch(() => this.requeue(message));
				},
				{ noAck: false }
			);
			this.consumerTag = consumer.consumerTag;
		});
	}

	ack(message: ConsumeMessage) {
		const channel = this.deliveries.get(message);
		if (!channel) return;
		channel.ack(message);
		this.deliveries.delete(message);
	}

	async requeue(message: ConsumeMessage) {
		if (!this.stopping)
			await new Promise<void>(resolve => {
				const finish = () => {
					clearTimeout(timer);
					this.waits.delete(finish);
					resolve();
				};
				const timer = setTimeout(finish, WINCRM_PROVIDER_REQUEUE_MS);
				this.waits.add(finish);
			});
		const channel = this.deliveries.get(message);
		if (!channel) return;
		try {
			channel.nack(message, false, true);
		} catch {
			/* Closing channel returns unacked messages to the broker. */
		}
		this.deliveries.delete(message);
	}

	async onApplicationShutdown() {
		this.stopping = true;
		for (const finish of this.waits) finish();
		if (this.consumerTag && this.consumerChannel) {
			await this.consumerChannel
				.cancel(this.consumerTag)
				.catch(() => undefined);
		}
		this.consumerTag = null;
		await this.channel?.close().catch(() => undefined);
		await this.connection?.close().catch(() => undefined);
	}
}
