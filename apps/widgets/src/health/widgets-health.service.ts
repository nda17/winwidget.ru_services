import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { WidgetsIntegrationWorkerService } from '../integrations/widgets-integration-worker.service';
import { WidgetsOutboxPublisherService } from '../messaging/widgets-outbox-publisher.service';
import { WidgetsProjectionWorkerService } from '../messaging/widgets-projection-worker.service';
import { WidgetsRabbitMqService } from '../messaging/widgets-rabbitmq.service';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsRetentionService } from '../retention/widgets-retention.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';

@Injectable()
export class WidgetsHealthService {
	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly runtime: WidgetsRuntimeService,
		private readonly rabbit: WidgetsRabbitMqService,
		private readonly projections: WidgetsProjectionWorkerService,
		private readonly integrations: WidgetsIntegrationWorkerService,
		private readonly outbox: WidgetsOutboxPublisherService,
		private readonly retention: WidgetsRetentionService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.widgetsServiceIdentity.findUnique(
				{
					where: { id: 'widgets-service' },
					select: { id: true, databaseId: true }
				}
			);
			if (!identity?.databaseId) {
				throw new Error('Widgets database identity is invalid');
			}
		} catch {
			throw new ServiceUnavailableException('Database is not ready');
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (this.runtime.workerEnabled && !this.rabbit.areConsumersReady()) {
			throw new ServiceUnavailableException(
				'Widgets consumers are not ready'
			);
		}
		if (
			this.runtime.workerEnabled &&
			(!this.projections.isReady() || !this.integrations.isReady())
		) {
			throw new ServiceUnavailableException(
				'Widgets workers are not ready'
			);
		}
		if (this.runtime.publisherEnabled && !this.outbox.isReady()) {
			throw new ServiceUnavailableException(
				'Widgets Outbox publisher is not ready'
			);
		}
		return this.status('ready');
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'widgets',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown',
			retention: this.retention.status()
		};
	}
}
