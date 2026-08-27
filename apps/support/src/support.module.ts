import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IdentityIntrospectionClient } from './auth/identity-introspection.client';
import { SupportAuthGuard } from './auth/support-auth.guard';
import { SupportInternalGuard } from './auth/support-internal.guard';
import { SupportConfigService } from './config/support-config.service';
import { SupportHealthController } from './health/support-health.controller';
import { SupportHealthService } from './health/support-health.service';
import { SupportMessagingHeartbeatService } from './health/support-messaging-heartbeat.service';
import { SupportInternalController } from './messaging/support-internal.controller';
import { SupportMessagingAdminController } from './messaging/support-messaging-admin.controller';
import { SupportMessagingAdminService } from './messaging/support-messaging-admin.service';
import { SupportOutboxPublisherService } from './messaging/support-outbox-publisher.service';
import { SupportRabbitMqService } from './messaging/support-rabbitmq.service';
import { SupportWebhookWorkerService } from './messaging/support-webhook-worker.service';
import { SupportPrismaModule } from './prisma/support-prisma.module';
import { SupportPrismaService } from './prisma/support-prisma.service';
import { SupportRuntimeModule } from './runtime/support-runtime.module';
import { parseSupportProcessRole } from './runtime/support-runtime.service';
import { SupportSettingsController } from './settings/support-settings.controller';
import { SupportSettingsService } from './settings/support-settings.service';
import { SupportTelegramTransport } from './telegram/support-telegram.transport';
import { SupportTelegramOutboundService } from './telegram/support-telegram-outbound.service';
import { SupportWebhookAdminController } from './telegram/support-webhook-admin.controller';
import { SupportWebhookAdminService } from './telegram/support-webhook-admin.service';
import { SupportWebhookController } from './telegram/support-webhook.controller';
import { SupportWebhookService } from './telegram/support-webhook.service';

const PROCESS_ROLE = parseSupportProcessRole(
	process.env.SUPPORT_PROCESS_ROLE
);

const API_CONTROLLERS =
	PROCESS_ROLE === 'api'
		? [
				SupportWebhookController,
				SupportWebhookAdminController,
				SupportSettingsController,
				SupportMessagingAdminController,
				SupportInternalController
			]
		: [];

const API_PROVIDERS =
	PROCESS_ROLE === 'api'
		? [
				IdentityIntrospectionClient,
				SupportAuthGuard,
				SupportInternalGuard,
				SupportWebhookService,
				SupportWebhookAdminService,
				SupportMessagingAdminService
			]
		: [SupportMessagingAdminService];

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		SupportRuntimeModule,
		SupportPrismaModule
	],
	controllers: [SupportHealthController, ...API_CONTROLLERS],
	providers: [
		...API_PROVIDERS,
		SupportConfigService,
		SupportSettingsService,
		SupportTelegramTransport,
		SupportTelegramOutboundService,
		SupportRabbitMqService,
		SupportWebhookWorkerService,
		SupportOutboxPublisherService,
		SupportHealthService,
		SupportMessagingHeartbeatService
	]
})
export class SupportModule implements OnApplicationShutdown {
	constructor(private readonly prisma: SupportPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
