import { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const DEFAULT_MAINTENANCE_HEALTH_PORT = 4300;
const MAINTENANCE_SERVICE_NAME = 'maintenance-worker';

export function parseMaintenanceHealthPort(value?: string): number {
	if (value === undefined) {
		return DEFAULT_MAINTENANCE_HEALTH_PORT;
	}

	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) {
		throw new Error(
			'MAINTENANCE_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}

	const port = Number(normalized);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			'MAINTENANCE_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}

	return port;
}

@Injectable()
export class MaintenanceHealthService {
	constructor(
		private readonly maintenanceWorker: MaintenanceWorkerService,
		private readonly rabbitMq: RabbitMqService,
		private readonly prisma: PrismaService
	) {}

	getLivenessHealth() {
		return {
			status: 'ok',
			service: MAINTENANCE_SERVICE_NAME,
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
			service: MAINTENANCE_SERVICE_NAME,
			revision: this.getRevision()
		};
	}

	private assertWorkerAndRabbitReady(): void {
		if (!this.maintenanceWorker.isReady()) {
			throw new ServiceUnavailableException(
				'Maintenance worker is not ready'
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
