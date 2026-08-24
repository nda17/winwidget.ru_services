import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PlatformOutboxPublisherService } from '../messaging/platform-outbox-publisher.service';
import { PlatformRabbitMqService } from '../messaging/platform-rabbitmq.service';
import { PlatformOwnershipService } from '../ownership/platform-ownership.service';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformRuntimeService } from '../runtime/platform-runtime.service';

@Injectable()
export class PlatformHealthService {
	constructor(
		private readonly prisma: PlatformPrismaService,
		private readonly runtime: PlatformRuntimeService,
		private readonly rabbit: PlatformRabbitMqService,
		private readonly publisher: PlatformOutboxPublisherService,
		private readonly ownership: PlatformOwnershipService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
		} catch {
			throw new ServiceUnavailableException(
				'Platform database is not ready'
			);
		}
		if (
			this.runtime.outboxPublisherEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Platform Outbox publisher is not ready'
			);
		}
		return {
			...this.status('ready'),
			ownership: await this.ownership.state()
		};
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'platform',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
