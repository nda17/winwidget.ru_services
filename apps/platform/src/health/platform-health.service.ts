import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PlatformOutboxPublisherService } from '../messaging/platform-outbox-publisher.service';
import { PlatformRabbitMqService } from '../messaging/platform-rabbitmq.service';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformRuntimeService } from '../runtime/platform-runtime.service';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class PlatformHealthService {
	constructor(
		private readonly prisma: PlatformPrismaService,
		private readonly runtime: PlatformRuntimeService,
		private readonly rabbit: PlatformRabbitMqService,
		private readonly publisher: PlatformOutboxPublisherService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		let database: {
			serviceName: string;
			databaseId: string;
			currentSemanticFingerprint: string;
			createdAt: string;
			updatedAt: string;
		};
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: {
					serviceName: true,
					databaseId: true,
					currentSemanticFingerprint: true,
					createdAt: true,
					updatedAt: true
				}
			});
			const fingerprints = await this.prisma.$queryRaw<
				{ fingerprint: string }[]
			>`SELECT platform.current_semantic_fingerprint() AS fingerprint`;
			const currentFingerprint = fingerprints[0]?.fingerprint;
			if (
				!identity ||
				identity.serviceName !== 'platform-service' ||
				!UUID.test(identity.databaseId) ||
				!/^[0-9a-f]{64}$/.test(identity.currentSemanticFingerprint) ||
				currentFingerprint !== identity.currentSemanticFingerprint ||
				identity.updatedAt < identity.createdAt
			) {
				throw new Error('Platform database identity is invalid');
			}
			database = {
				serviceName: identity.serviceName,
				databaseId: identity.databaseId,
				currentSemanticFingerprint: identity.currentSemanticFingerprint,
				createdAt: identity.createdAt.toISOString(),
				updatedAt: identity.updatedAt.toISOString()
			};
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
			database
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
