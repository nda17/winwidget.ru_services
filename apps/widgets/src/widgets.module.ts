import {
	MiddlewareConsumer,
	Module,
	NestModule,
	OnApplicationShutdown
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
	WidgetsApiGuard,
	WidgetsAuthGuard
} from './auth/widgets-auth.guard';
import { widgetsContextMiddleware } from './common/widgets-context';
import { waitForWidgetsShutdown } from './common/widgets-shutdown';
import { WidgetsDomainRepository } from './domain/widgets-domain.repository';
import { WidgetsAccessService } from './domain/widgets-access.service';
import { WidgetsConfigurationService } from './domain/widgets-configuration.service';
import { WidgetsDeliveryFailuresController } from './delivery-failures/widgets-delivery-failures.controller';
import { WidgetsDeliveryFailuresService } from './delivery-failures/widgets-delivery-failures.service';
import { WidgetsDomainService } from './domain/widgets-domain.service';
import { WidgetsImageLifecycleService } from './domain/widgets-image-lifecycle.service';
import { WidgetsImageService } from './domain/widgets-image.service';
import { WidgetsLeadQueryService } from './domain/widgets-lead-query.service';
import { WidgetsLifecycleService } from './domain/widgets-lifecycle.service';
import { WidgetsPublicService } from './domain/widgets-public.service';
import { WidgetsReportingService } from './domain/widgets-reporting.service';
import { WidgetsTypeRegistryService } from './domain/widgets-type-registry.service';
import { WidgetsHealthController } from './health/widgets-health.controller';
import { WidgetsHealthService } from './health/widgets-health.service';
import { WidgetsHeartbeatService } from './health/widgets-heartbeat.service';
import { WidgetsAdminController } from './http/widgets-admin.controller';
import { WidgetsManagementController } from './http/widgets-management.controller';
import { WidgetsPublicController } from './http/widgets-public.controller';
import { WidgetsSettingsController } from './http/widgets-settings.controller';
import { WidgetsTelemetryController } from './http/widgets-telemetry.controller';
import { WidgetsIntegrationDeliveryService } from './integrations/widgets-integration-delivery.service';
import { WidgetsIntegrationWorkerService } from './integrations/widgets-integration-worker.service';
import { WidgetsSafeHttpService } from './integrations/widgets-safe-http.service';
import { CoreInternalClient } from './internal/core-internal.client';
import { WidgetsInternalController } from './internal/widgets-internal.controller';
import { WidgetsInternalGuard } from './internal/widgets-internal.guard';
import { WidgetsDomainEventsService } from './messaging/widgets-domain-events.service';
import { WidgetsMessagingOverviewService } from './messaging/widgets-messaging-overview.service';
import { WidgetsOutboxPublisherService } from './messaging/widgets-outbox-publisher.service';
import { WidgetsProjectionWorkerService } from './messaging/widgets-projection-worker.service';
import { WidgetsRabbitMqModule } from './messaging/widgets-rabbitmq.module';
import { WidgetsAdminMonitoringService } from './monitoring/widgets-admin-monitoring.service';
import { WidgetsPrismaModule } from './prisma/widgets-prisma.module';
import { WidgetsPrismaService } from './prisma/widgets-prisma.service';
import { WidgetsProjectionService } from './projections/widgets-projection.service';
import { WidgetsQuotaService } from './quota/widgets-quota.service';
import { WidgetsReportingSequenceService } from './reporting/widgets-reporting-sequence.service';
import { WidgetsRetentionService } from './retention/widgets-retention.service';
import { WidgetsRuntimeModule } from './runtime/widgets-runtime.module';
import { WidgetsTelemetryService } from './telemetry/widgets-telemetry.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		WidgetsRuntimeModule,
		WidgetsPrismaModule,
		WidgetsRabbitMqModule
	],
	controllers: [
		WidgetsHealthController,
		WidgetsInternalController,
		WidgetsDeliveryFailuresController,
		WidgetsManagementController,
		WidgetsSettingsController,
		WidgetsAdminController,
		WidgetsPublicController,
		WidgetsTelemetryController
	],
	providers: [
		CoreInternalClient,
		WidgetsInternalGuard,
		WidgetsApiGuard,
		WidgetsAuthGuard,
		WidgetsDomainRepository,
		WidgetsAccessService,
		WidgetsConfigurationService,
		WidgetsDeliveryFailuresService,
		WidgetsDomainService,
		WidgetsImageLifecycleService,
		WidgetsImageService,
		WidgetsLeadQueryService,
		WidgetsLifecycleService,
		WidgetsPublicService,
		WidgetsReportingService,
		WidgetsTypeRegistryService,
		WidgetsQuotaService,
		WidgetsReportingSequenceService,
		WidgetsDomainEventsService,
		WidgetsMessagingOverviewService,
		WidgetsProjectionService,
		WidgetsProjectionWorkerService,
		WidgetsOutboxPublisherService,
		WidgetsSafeHttpService,
		WidgetsIntegrationDeliveryService,
		WidgetsIntegrationWorkerService,
		WidgetsAdminMonitoringService,
		WidgetsTelemetryService,
		WidgetsHeartbeatService,
		WidgetsRetentionService,
		WidgetsHealthService
	]
})
export class WidgetsModule implements NestModule, OnApplicationShutdown {
	constructor(private readonly prisma: WidgetsPrismaService) {}

	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(widgetsContextMiddleware).forRoutes('*');
	}

	async onApplicationShutdown(): Promise<void> {
		await waitForWidgetsShutdown(this.prisma.disconnect(), 5_000);
	}
}
