import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AdminAuditConsumerService } from '../messaging/admin-audit-consumer.service';
import { OperationsOutboxPublisherService } from '../messaging/operations-outbox-publisher.service';
import { OperationsRabbitMqService } from '../messaging/operations-rabbitmq.service';
import { OperationsOwnershipService } from '../ownership/operations-ownership.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';

@Injectable()
export class OperationsHealthService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly runtime: OperationsRuntimeService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly consumer: AdminAuditConsumerService,
		private readonly publisher: OperationsOutboxPublisherService,
		private readonly ownership: OperationsOwnershipService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			await this.ownership.isActive();
		} catch {
			throw new ServiceUnavailableException(
				'Operations database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (this.runtime.workerEnabled && !this.consumer.isReady()) {
			throw new ServiceUnavailableException(
				'Operations audit consumer is not ready'
			);
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Operations Outbox publisher is not ready'
			);
		}
		return this.status('ready');
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'operations',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
