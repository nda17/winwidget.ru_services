import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { IdentityIntrospectionClient } from './auth/identity-introspection.client';
import { PlatformAuthGuard } from './auth/platform-auth.guard';
import { PlatformInternalGuard } from './auth/platform-internal.guard';
import { PlatformHealthController } from './health/platform-health.controller';
import { PlatformHealthService } from './health/platform-health.service';
import { PlatformHomePageContentController } from './home-page-content/home-page-content.controller';
import { PlatformHomePageContentService } from './home-page-content/home-page-content.service';
import { PlatformLegalPagesController } from './legal-pages/legal-pages.controller';
import { PlatformLegalPagesService } from './legal-pages/legal-pages.service';
import { PlatformOutboxPublisherService } from './messaging/platform-outbox-publisher.service';
import { PlatformOutboxRetentionService } from './messaging/platform-outbox-retention.service';
import { PlatformInternalController } from './messaging/platform-internal.controller';
import { PlatformMessagingAdminService } from './messaging/platform-messaging-admin.service';
import { PlatformRabbitMqService } from './messaging/platform-rabbitmq.service';
import {
	PlatformOwnershipGuard,
	PlatformOwnershipService
} from './ownership/platform-ownership.service';
import { PlatformPrismaModule } from './prisma/platform-prisma.module';
import { PlatformPrismaService } from './prisma/platform-prisma.service';
import { PlatformRuntimeModule } from './runtime/platform-runtime.module';
import { parsePlatformProcessRole } from './runtime/platform-runtime.service';
import { PlatformSiteSettingsController } from './site-settings/site-settings.controller';
import { PlatformSiteSettingsService } from './site-settings/site-settings.service';

const PLATFORM_PROCESS_ROLE = parsePlatformProcessRole(
	process.env.PLATFORM_PROCESS_ROLE
);

const API_CONTROLLERS =
	PLATFORM_PROCESS_ROLE === 'api'
		? [
				PlatformInternalController,
				PlatformSiteSettingsController,
				PlatformLegalPagesController,
				PlatformHomePageContentController
			]
		: [];

const API_PROVIDERS =
	PLATFORM_PROCESS_ROLE === 'api'
		? [
				PlatformAuthGuard,
				PlatformInternalGuard,
				PlatformMessagingAdminService
			]
		: [];

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		PlatformRuntimeModule,
		PlatformPrismaModule
	],
	controllers: [PlatformHealthController, ...API_CONTROLLERS],
	providers: [
		...API_PROVIDERS,
		IdentityIntrospectionClient,
		PlatformSiteSettingsService,
		PlatformLegalPagesService,
		PlatformHomePageContentService,
		PlatformRabbitMqService,
		PlatformOutboxPublisherService,
		PlatformOutboxRetentionService,
		PlatformHealthService,
		PlatformOwnershipService,
		{
			provide: APP_GUARD,
			useClass: PlatformOwnershipGuard
		}
	]
})
export class PlatformModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PlatformPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
