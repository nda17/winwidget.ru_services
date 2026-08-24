import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SupportConfigService } from '../config/support-config.service';
import { SupportOutboxPublisherService } from '../messaging/support-outbox-publisher.service';
import { SupportRabbitMqService } from '../messaging/support-rabbitmq.service';
import { SupportWebhookWorkerService } from '../messaging/support-webhook-worker.service';
import { SupportOwnershipService } from '../ownership/support-ownership.service';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';

@Injectable()
export class SupportHealthService {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService,
		private readonly config: SupportConfigService,
		private readonly rabbit: SupportRabbitMqService,
		private readonly worker: SupportWebhookWorkerService,
		private readonly publisher: SupportOutboxPublisherService,
		private readonly ownership: SupportOwnershipService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			await this.ownership.state();
			if (
				(this.runtime.apiEnabled &&
					(!this.config.botToken || !this.config.webhookSecret)) ||
				(this.runtime.workerEnabled && !this.config.botToken)
			) {
				throw new Error('Support Telegram configuration is unavailable');
			}
		} catch (error) {
			if (error instanceof ServiceUnavailableException) throw error;
			throw new ServiceUnavailableException(
				'Support database is not ready'
			);
		}
		if (
			this.runtime.rabbitEnabled &&
			(!this.rabbit.isConnected() || !this.rabbit.isTopologyReady())
		) {
			throw new ServiceUnavailableException('RabbitMQ is not ready');
		}
		const active = await this.ownership.isActive();
		if (active && this.runtime.workerEnabled && !this.worker.isReady()) {
			throw new ServiceUnavailableException('Support worker is not ready');
		}
		if (
			active &&
			this.runtime.outboxPublisherEnabled &&
			!this.publisher.isReady()
		) {
			throw new ServiceUnavailableException(
				'Support Outbox publisher is not ready'
			);
		}
		return {
			...this.status('ready'),
			ownership: await this.ownership.state(),
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
