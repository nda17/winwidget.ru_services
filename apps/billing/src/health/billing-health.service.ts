import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BillingOutboxPublisherService } from '../messaging/billing-outbox-publisher.service';
import { BillingRabbitMqService } from '../messaging/billing-rabbitmq.service';
import { BillingWorkerService } from '../messaging/billing-worker.service';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingProviderWorkerService } from '../provider/billing-provider-worker.service';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { BillingSchedulerService } from '../scheduler/billing-scheduler.service';

@Injectable()
export class BillingHealthService {
	constructor(
		private readonly prisma: BillingPrismaService,
		private readonly runtime: BillingRuntimeService,
		private readonly rabbit: BillingRabbitMqService,
		private readonly worker: BillingWorkerService,
		private readonly providerWorker: BillingProviderWorkerService,
		private readonly publisher: BillingOutboxPublisherService,
		private readonly scheduler: BillingSchedulerService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: { serviceName: true }
			});
			if (identity?.serviceName !== 'billing-service') throw new Error();
		} catch {
			throw new ServiceUnavailableException(
				'Billing database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (
			this.runtime.workerEnabled &&
			(!this.worker.isReady() || !this.providerWorker.isReady())
		) {
			throw new ServiceUnavailableException('Billing worker is not ready');
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Billing Outbox publisher is not ready'
			);
		}
		if (this.runtime.schedulerEnabled && !this.scheduler.isReady()) {
			throw new ServiceUnavailableException(
				'Billing scheduler is not ready'
			);
		}
		return this.status('ready');
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'billing',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
