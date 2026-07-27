import { RabbitMqService } from '../messaging/rabbitmq.service';
import { NotificationDeliveryOutboxPublisherService } from './notification-delivery-outbox-publisher.service';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const DEFAULT_NOTIFICATION_DELIVERY_HEALTH_PORT = 4401;
const NOTIFICATION_DELIVERY_SERVICE_NAME = 'notification-delivery-worker';

export function parseNotificationDeliveryHealthPort(
	value?: string
): number {
	if (value === undefined) {
		return DEFAULT_NOTIFICATION_DELIVERY_HEALTH_PORT;
	}

	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) {
		throw new Error(
			'NOTIFICATION_DELIVERY_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}

	const port = Number(normalized);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			'NOTIFICATION_DELIVERY_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}
	return port;
}

@Injectable()
export class NotificationDeliveryHealthService {
	constructor(
		private readonly worker: NotificationDeliveryWorkerService,
		private readonly outbox: NotificationDeliveryOutboxPublisherService,
		private readonly rabbitMq: RabbitMqService,
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	getLivenessHealth() {
		return {
			status: 'ok',
			service: NOTIFICATION_DELIVERY_SERVICE_NAME,
			revision: this.getRevision()
		};
	}

	async getReadinessHealth() {
		this.assertWorkerAndRabbitReady();
		try {
			await this.prisma.$queryRaw`SELECT 1`;
		} catch {
			throw new ServiceUnavailableException('Database is not ready');
		}
		this.assertWorkerAndRabbitReady();

		return {
			status: 'ready',
			service: NOTIFICATION_DELIVERY_SERVICE_NAME,
			revision: this.getRevision()
		};
	}

	private assertWorkerAndRabbitReady(): void {
		if (!this.worker.isReady()) {
			throw new ServiceUnavailableException(
				'Notification delivery worker is not ready'
			);
		}
		if (!this.outbox.isReady()) {
			throw new ServiceUnavailableException(
				'Notification delivery outbox is not ready'
			);
		}
		if (!this.rabbitMq.isConnected()) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (!this.rabbitMq.areConsumersReady()) {
			throw new ServiceUnavailableException(
				'RabbitMQ consumers are not ready'
			);
		}
	}

	private getRevision(): string {
		return process.env.APP_REVISION || 'unknown';
	}
}
