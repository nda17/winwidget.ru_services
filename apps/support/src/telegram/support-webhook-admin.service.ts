import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import { SupportConfigService } from '../config/support-config.service';
import { enqueueSupportAdminAudit } from '../domain/support-admin-audit';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportTelegramTransport } from './support-telegram.transport';

@Injectable()
export class SupportWebhookAdminService {
	constructor(
		private readonly config: SupportConfigService,
		private readonly telegram: SupportTelegramTransport,
		private readonly prisma: SupportPrismaService
	) {}

	async status() {
		const [bot, webhook] = await Promise.all([
			this.telegram.getMe(),
			this.telegram.getWebhookInfo()
		]);
		return {
			schemaVersion: 1,
			bot: 'support',
			configuredUsername: this.config.botUsername,
			actualUsername: bot.username,
			usernameMatchesConfigured: bot.username === this.config.botUsername,
			expectedWebhookUrl: this.config.webhookPublicUrl,
			webhookUrl: webhook.url,
			webhookMatchesExpected: webhook.url === this.config.webhookPublicUrl,
			pendingUpdateCount: webhook.pendingUpdateCount,
			lastErrorMessage: webhook.lastErrorMessage,
			secretConfigured: true
		};
	}

	async reinstall(actor: SupportActor, request: Request) {
		await this.telegram.setWebhook(false);
		const status = await this.status();
		if (
			!status.webhookMatchesExpected ||
			!status.usernameMatchesConfigured
		) {
			throw new ServiceUnavailableException(
				'Support webhook verification failed'
			);
		}
		await this.prisma.$transaction(transaction =>
			enqueueSupportAdminAudit(transaction, {
				actor,
				action: 'SUPPORT_WEBHOOK_REINSTALL',
				description: 'Переустановлен webhook Support_bot',
				entityType: 'support_webhook',
				entityId: 'support',
				entityLabel: 'Support_bot',
				metadata: {
					webhookMatchesExpected: true,
					usernameMatchesConfigured: true,
					dropPendingUpdates: false
				},
				request
			})
		);
		return status;
	}
}
