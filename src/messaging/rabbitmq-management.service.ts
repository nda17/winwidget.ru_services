import {
	EVENTS_EXCHANGE,
	INTEGRATION_QUEUE_NAMES,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind
} from '@/messaging/messaging.constants';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface RabbitQueueInfo {
	name: string;
	messages: number;
	messages_ready: number;
	messages_unacknowledged: number;
	consumers: number;
	state?: string;
}

@Injectable()
export class RabbitMqManagementService {
	constructor(private readonly configService: ConfigService) {}

	async getMessagingQueues(): Promise<RabbitQueueInfo[]> {
		const queues = await this.request<RabbitQueueInfo[]>(
			`/api/queues/${this.getEncodedVhost()}`
		);
		return queues
			.filter(queue =>
				queue.name.startsWith('winwidget.lead-integration.')
			)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	async checkConnection(): Promise<string> {
		const overview = await this.request<{
			rabbitmq_version?: string;
			cluster_name?: string;
		}>('/api/overview');
		return `RabbitMQ ${overview.rabbitmq_version || 'доступен'}`;
	}

	async publishIntegrationEvent(input: {
		kind: IntegrationKind;
		eventId: string;
		payload: unknown;
	}): Promise<void> {
		const response = await this.request<{ routed?: boolean }>(
			`/api/exchanges/${this.getEncodedVhost()}/${encodeURIComponent(EVENTS_EXCHANGE)}/publish`,
			{
				method: 'POST',
				body: JSON.stringify({
					properties: {
						content_type: 'application/json',
						delivery_mode: 2,
						message_id: input.eventId,
						type: 'lead.integration.requested.v1',
						headers: {
							'x-manual-retry': true
						}
					},
					routing_key: INTEGRATION_ROUTING_KEYS[input.kind],
					payload: JSON.stringify(input.payload),
					payload_encoding: 'string'
				})
			}
		);

		if (!response.routed) {
			throw new Error('RabbitMQ не смог маршрутизировать сообщение');
		}
	}

	getMainQueueName(kind: IntegrationKind): string {
		return INTEGRATION_QUEUE_NAMES[kind];
	}

	private async request<T>(
		path: string,
		init: RequestInit = {}
	): Promise<T> {
		const baseUrl =
			this.configService
				.get<string>('RABBITMQ_MANAGEMENT_URL')
				?.replace(/\/$/, '') || 'http://127.0.0.1:15672';
		const user = this.configService.get<string>('RABBITMQ_USER');
		const password = this.configService.get<string>('RABBITMQ_PASSWORD');
		if (!user || !password) {
			throw new Error('Не настроены RABBITMQ_USER или RABBITMQ_PASSWORD');
		}

		const response = await fetch(`${baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
				'Content-Type': 'application/json',
				...(init.headers || {})
			},
			signal: AbortSignal.timeout(4000)
		});

		if (!response.ok) {
			throw new Error(`RabbitMQ Management API: HTTP ${response.status}`);
		}
		return (await response.json()) as T;
	}

	private getEncodedVhost(): string {
		return encodeURIComponent(
			this.configService.get<string>('RABBITMQ_VHOST') || 'winwidget'
		);
	}
}
