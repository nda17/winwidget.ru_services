import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DestinationUnavailableWorkerService } from '../messaging/destination-worker.service';
import { IdentityOutboxPublisherService } from '../messaging/outbox-publisher.service';
import { IdentityRabbitMqService } from '../messaging/rabbitmq.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityHeartbeatService } from '../runtime/identity-heartbeat.service';
import { IdentityHousekeepingService } from '../runtime/identity-housekeeping.service';
import { IdentityOwnershipService } from '../runtime/identity-ownership.service';
import { IdentityRuntimeService } from '../runtime/identity-runtime.service';

@Injectable()
export class IdentityHealthService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService,
		private readonly rabbit: IdentityRabbitMqService,
		private readonly worker: DestinationUnavailableWorkerService,
		private readonly publisher: IdentityOutboxPublisherService,
		private readonly heartbeat: IdentityHeartbeatService,
		private readonly housekeeping: IdentityHousekeepingService,
		private readonly ownershipService: IdentityOwnershipService
	) {}

	liveness() {
		return this.status('ok');
	}

	revision() {
		return {
			service: 'identity',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}

	async ownership(requireActive = false) {
		const identity = await this.ownershipService.state();
		if (requireActive) await this.ownershipService.assertActive();
		return {
			serviceName: identity.serviceName,
			databaseId: identity.databaseId,
			phase: identity.phase,
			ownershipGeneration: identity.ownershipGeneration.toString(),
			importedAt: identity.importedAt?.toISOString() || null,
			activatedAt: identity.activatedAt?.toISOString() || null
		};
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			await this.ownership(false);
		} catch (error) {
			if (error instanceof ServiceUnavailableException) throw error;
			throw new ServiceUnavailableException(
				'Identity database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		const active = await this.ownershipService.isActive();
		if (active && this.runtime.workerEnabled && !this.worker.isReady()) {
			throw new ServiceUnavailableException(
				'Identity worker is not ready'
			);
		}
		if (
			active &&
			this.runtime.workerEnabled &&
			!this.housekeeping.isReady()
		) {
			throw new ServiceUnavailableException(
				'Identity housekeeping is not ready'
			);
		}
		if (
			active &&
			this.runtime.outboxPublisherEnabled &&
			!this.publisher.isReady()
		) {
			throw new ServiceUnavailableException(
				'Identity Outbox publisher is not ready'
			);
		}
		if (!this.heartbeat.isReady()) {
			throw new ServiceUnavailableException(
				'Identity heartbeat is not ready'
			);
		}
		return {
			...this.status('ready'),
			ownership: await this.ownership(false)
		};
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'identity',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
