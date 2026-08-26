import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OperationsRabbitQueueView {
	name: string;
	messages: number;
	ready: number;
	unacknowledged: number;
	consumers: number;
	state: string | null;
}

interface RabbitQueueResponse {
	name?: unknown;
	messages?: unknown;
	messages_ready?: unknown;
	messages_unacknowledged?: unknown;
	consumers?: unknown;
	state?: unknown;
}

@Injectable()
export class RabbitMqManagementClient {
	constructor(private readonly config: ConfigService) {}

	async getMessagingQueues(): Promise<OperationsRabbitQueueView[]> {
		const baseUrl = this.baseUrl();
		const user = this.required('RABBITMQ_MONITOR_USER');
		const password = this.required('RABBITMQ_MONITOR_PASSWORD');
		const vhost = encodeURIComponent(
			this.config.get<string>('RABBITMQ_VHOST')?.trim() || 'winwidget'
		);
		const response = await fetch(`${baseUrl}/api/queues/${vhost}`, {
			headers: {
				authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
				accept: 'application/json'
			},
			redirect: 'error',
			signal: AbortSignal.timeout(4_000)
		});
		if (!response.ok) {
			throw new Error(
				`RabbitMQ Management API returned HTTP ${response.status}`
			);
		}
		const value = (await response.json()) as unknown;
		if (!Array.isArray(value) || value.length > 10_000) {
			throw new Error('RabbitMQ Management API response is invalid');
		}
		return value
			.map(item => this.queue(item))
			.filter((item): item is OperationsRabbitQueueView => Boolean(item))
			.filter(item => item.name.startsWith('winwidget.'))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	private queue(value: unknown): OperationsRabbitQueueView | null {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return null;
		const row = value as RabbitQueueResponse;
		if (
			typeof row.name !== 'string' ||
			!row.name ||
			row.name.length > 500
		) {
			return null;
		}
		return {
			name: row.name,
			messages: this.nonNegative(row.messages),
			ready: this.nonNegative(row.messages_ready),
			unacknowledged: this.nonNegative(row.messages_unacknowledged),
			consumers: this.nonNegative(row.consumers),
			state: typeof row.state === 'string' ? row.state.slice(0, 100) : null
		};
	}

	private baseUrl(): string {
		const raw =
			this.config.get<string>('RABBITMQ_MANAGEMENT_URL')?.trim() ||
			'http://127.0.0.1:15672';
		const url = new URL(raw);
		if (
			url.protocol !== 'http:' ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'RABBITMQ_MANAGEMENT_URL must be an exact private HTTP origin'
			);
		}
		return url.origin;
	}

	private required(name: string): string {
		const value = this.config.get<string>(name)?.trim();
		if (!value) throw new Error(`${name} is required`);
		return value;
	}

	private nonNegative(value: unknown): number {
		return Number.isSafeInteger(value) && Number(value) >= 0
			? Number(value)
			: 0;
	}
}
