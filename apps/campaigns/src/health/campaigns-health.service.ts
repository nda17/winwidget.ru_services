import { CampaignsOutboxPublisherService } from '../messaging/campaigns-outbox-publisher.service';
import { CampaignsRabbitMqService } from '../messaging/campaigns-rabbitmq.service';
import { CampaignsWorkerService } from '../messaging/campaigns-worker.service';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

export function parseCampaignsPort(value?: string): number {
	if (value === undefined) return 4500;
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(
			'CAMPAIGNS_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			'CAMPAIGNS_HEALTH_PORT must be an integer between 1 and 65535'
		);
	}
	return port;
}

export function parseCampaignsListenHost(
	value?: string,
	nodeEnvironment?: string
): string {
	const host = value?.trim() || '127.0.0.1';
	if (host !== '0.0.0.0' && host !== '127.0.0.1') {
		throw new Error('CAMPAIGNS_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1');
	}
	if (nodeEnvironment?.trim() === 'production' && host !== '127.0.0.1') {
		throw new Error(
			'CAMPAIGNS_LISTEN_HOST must be 127.0.0.1 in production'
		);
	}
	return host;
}

@Injectable()
export class CampaignsHealthService {
	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly runtime: CampaignsRuntimeService,
		private readonly rabbitMq: CampaignsRabbitMqService,
		private readonly worker: CampaignsWorkerService,
		private readonly outbox: CampaignsOutboxPublisherService
	) {}

	liveness() {
		return {
			status: 'ok',
			service: 'campaigns',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
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
		if (!this.rabbitMq.areConsumersReady()) {
			throw new ServiceUnavailableException(
				'Campaigns consumers are not ready'
			);
		}
		if (!this.worker.isReady()) {
			throw new ServiceUnavailableException(
				'Campaigns worker is not ready'
			);
		}
		if (!this.outbox.isReady()) {
			throw new ServiceUnavailableException(
				'Campaigns outbox publisher is not ready'
			);
		}
		return {
			status: 'ready',
			service: 'campaigns',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
