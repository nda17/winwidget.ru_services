import {
	MESSAGING_QUEUE_NAMES,
	MessagingKind
} from '@/messaging/messaging.constants';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface RabbitQueueInfo {
	name: string;
	messages: number;
	messages_ready: number;
	messages_unacknowledged: number;
	consumers: number;
	state?: string;
}

export interface RabbitNodeInfo {
	name: string;
	running?: boolean;
	mem_alarm?: boolean;
	disk_free_alarm?: boolean;
	partitions?: string[];
}

export interface RabbitBrokerHealth {
	nodes: RabbitNodeInfo[];
	alarmNodes: string[];
	stoppedNodes: string[];
	partitionedNodes: string[];
}

@Injectable()
export class RabbitMqManagementService {
	constructor(private readonly configService: ConfigService) {}

	async getMessagingQueues(): Promise<RabbitQueueInfo[]> {
		const queues = await this.request<RabbitQueueInfo[]>(
			`/api/queues/${this.getEncodedVhost()}`
		);
		return queues
			.filter(
				queue =>
					queue.name.startsWith('winwidget.lead-integration.') ||
					queue.name.startsWith('winwidget.payment-notification.') ||
					queue.name.startsWith('winwidget.mailing.') ||
					queue.name.startsWith('winwidget.limit-notification.') ||
					queue.name.startsWith('winwidget.report.') ||
					queue.name.startsWith('winwidget.maintenance.')
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

	async getBrokerHealth(): Promise<RabbitBrokerHealth> {
		const nodes = await this.request<RabbitNodeInfo[]>('/api/nodes');
		return {
			nodes,
			alarmNodes: nodes
				.filter(node => node.mem_alarm || node.disk_free_alarm)
				.map(node => node.name),
			stoppedNodes: nodes
				.filter(node => node.running === false)
				.map(node => node.name),
			partitionedNodes: nodes
				.filter(node => (node.partitions?.length || 0) > 0)
				.map(node => node.name)
		};
	}

	getMainQueueName(kind: MessagingKind): string {
		return MESSAGING_QUEUE_NAMES[kind];
	}

	private async request<T>(
		path: string,
		init: RequestInit = {}
	): Promise<T> {
		const baseUrl =
			this.configService
				.get<string>('RABBITMQ_MANAGEMENT_URL')
				?.replace(/\/$/, '') || 'http://127.0.0.1:15672';
		const user = this.configService.get<string>('RABBITMQ_MONITOR_USER');
		const password = this.configService.get<string>(
			'RABBITMQ_MONITOR_PASSWORD'
		);
		if (!user || !password) {
			throw new Error(
				'Не настроены RABBITMQ_MONITOR_USER или RABBITMQ_MONITOR_PASSWORD'
			);
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
