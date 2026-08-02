import { DailySummarySchedulerService } from '../daily-summary/daily-summary-scheduler.service';
import { ReportingOutboxPublisherService } from '../messaging/reporting-outbox-publisher.service';
import { ReportingRabbitMqService } from '../messaging/reporting-rabbitmq.service';
import { ReportingWorkerService } from '../messaging/reporting-worker.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class ReportingHealthService {
	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly runtime: ReportingRuntimeService,
		private readonly rabbitMq: ReportingRabbitMqService,
		private readonly worker: ReportingWorkerService,
		private readonly outbox: ReportingOutboxPublisherService,
		private readonly scheduler: DailySummarySchedulerService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
		} catch {
			throw new ServiceUnavailableException('Database is not ready');
		}
		if (!this.rabbitMq.isConnected()) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (!this.rabbitMq.isTopologyReady()) {
			throw new ServiceUnavailableException(
				'RabbitMQ topology is not ready'
			);
		}
		if (!this.rabbitMq.areConsumersReady()) {
			throw new ServiceUnavailableException(
				'Reporting consumers are not ready'
			);
		}
		if (!this.worker.isReady()) {
			throw new ServiceUnavailableException(
				'Reporting worker is not ready'
			);
		}
		if (!this.outbox.isReady()) {
			throw new ServiceUnavailableException(
				'Reporting Outbox publisher is not ready'
			);
		}
		if (!this.scheduler.isReady()) {
			throw new ServiceUnavailableException(
				'Reporting scheduler is not ready'
			);
		}
		return this.status('ready');
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'reporting',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown',
			schedulerEnabled: this.runtime.schedulerEnabled
		};
	}
}
