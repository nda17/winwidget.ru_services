import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SupportConfigService } from '../config/support-config.service';
import { SupportOutboxPublisherService } from '../messaging/support-outbox-publisher.service';
import { SupportRabbitMqService } from '../messaging/support-rabbitmq.service';
import { SupportWebhookWorkerService } from '../messaging/support-webhook-worker.service';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class SupportHealthService {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService,
		private readonly config: SupportConfigService,
		private readonly rabbit: SupportRabbitMqService,
		private readonly worker: SupportWebhookWorkerService,
		private readonly publisher: SupportOutboxPublisherService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		let database: {
			serviceName: string;
			databaseId: string;
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
					createdAt: true,
					updatedAt: true
				}
			});
			if (
				!identity ||
				identity.serviceName !== 'support-service' ||
				!UUID.test(identity.databaseId) ||
				identity.updatedAt < identity.createdAt
			) {
				throw new Error('Support database identity is invalid');
			}
			database = {
				serviceName: identity.serviceName,
				databaseId: identity.databaseId,
				createdAt: identity.createdAt.toISOString(),
				updatedAt: identity.updatedAt.toISOString()
			};
		} catch {
			throw new ServiceUnavailableException(
				'Support database is not ready'
			);
		}
		if (
			(this.runtime.apiEnabled &&
				(!this.config.botToken ||
					!this.config.botUsername ||
					!this.config.webhookSecret ||
					!this.config.webhookPublicUrl ||
					!this.config.telegramApiBaseUrl ||
					!this.config.telegramApiProxyIp)) ||
			(this.runtime.workerEnabled &&
				(!this.config.botToken ||
					!this.config.telegramApiBaseUrl ||
					!this.config.telegramApiProxyIp))
		) {
			throw new ServiceUnavailableException(
				'Support Telegram configuration is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		if (this.runtime.workerEnabled && !this.worker.isReady()) {
			throw new ServiceUnavailableException('Support worker is not ready');
		}
		if (this.runtime.outboxPublisherEnabled && !this.publisher.isReady()) {
			throw new ServiceUnavailableException(
				'Support Outbox publisher is not ready'
			);
		}
		return {
			...this.status('ready'),
			database,
			telegram: this.runtime.outboxPublisherEnabled
				? { enabled: false }
				: {
						enabled: true,
						apiBaseUrl: this.config.telegramApiBaseUrl,
						proxyPinned: true,
						botTokenConfigured: true,
						botUsernameConfigured: this.runtime.apiEnabled,
						webhookSecretConfigured: this.runtime.apiEnabled
					}
		};
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'support',
			role: this.runtime.role,
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
