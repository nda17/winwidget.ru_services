import {
	ReportingAdminGuard,
	ReportingApiGuard,
	ReportingMessagingInternalGuard
} from './auth/reporting-auth.guard';
import { ReportingAnalyticsController } from './analytics/reporting-analytics.controller';
import { ReportingAnalyticsService } from './analytics/reporting-analytics.service';
import { reportingContextMiddleware } from './common/reporting-context';
import { waitForReportingShutdown } from './common/reporting-shutdown';
import { DailySummaryReportService } from './daily-summary/daily-summary-report.service';
import { DailySummaryRunService } from './daily-summary/daily-summary-run.service';
import { DailySummarySchedulerService } from './daily-summary/daily-summary-scheduler.service';
import { ReportingDeliveryFailuresController } from './delivery-failures/reporting-delivery-failures.controller';
import { ReportingDeliveryFailuresService } from './delivery-failures/reporting-delivery-failures.service';
import { ReportingHealthController } from './health/reporting-health.controller';
import { ReportingHealthService } from './health/reporting-health.service';
import { ReportingHeartbeatService } from './health/reporting-heartbeat.service';
import { IdentityIntrospectionClient } from './internal/identity-introspection.client';
import { OperationsInternalClient } from './internal/operations-internal.client';
import { ReportingMessagingOverviewController } from './internal/reporting-messaging-overview.controller';
import { ReportingMessagingOverviewService } from './messaging/reporting-messaging-overview.service';
import { ReportingConsumerFailureFinalizerService } from './messaging/reporting-consumer-failure-finalizer.service';
import { ReportingConsumerReceiptService } from './messaging/reporting-consumer-receipt.service';
import { ReportingConsumerRouterService } from './messaging/reporting-consumer-router.service';
import { ReportingOutboxPublisherService } from './messaging/reporting-outbox-publisher.service';
import { ReportingRabbitMqModule } from './messaging/reporting-rabbitmq.module';
import { ReportingWorkerService } from './messaging/reporting-worker.service';
import { ReportingMetricsModule } from './metrics/reporting-metrics.module';
import { ReportingMetricsController } from './metrics/reporting-metrics.controller';
import { ReportingPrismaModule } from './prisma/reporting-prisma.module';
import { ReportingPrismaService } from './prisma/reporting-prisma.service';
import { ProjectionService } from './projections/projection.service';
import { ReportingRuntimeModule } from './runtime/reporting-runtime.module';
import { DailySummarySettingsController } from './settings/daily-summary-settings.controller';
import { DailySummarySettingsService } from './settings/daily-summary-settings.service';
import {
	MiddlewareConsumer,
	Module,
	NestModule,
	OnApplicationShutdown
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		ReportingRuntimeModule,
		ReportingPrismaModule,
		ReportingMetricsModule,
		ReportingRabbitMqModule
	],
	controllers: [
		ReportingAnalyticsController,
		DailySummarySettingsController,
		ReportingDeliveryFailuresController,
		ReportingHealthController,
		ReportingMetricsController,
		ReportingMessagingOverviewController
	],
	providers: [
		IdentityIntrospectionClient,
		OperationsInternalClient,
		ReportingApiGuard,
		ReportingAdminGuard,
		ReportingMessagingInternalGuard,
		ProjectionService,
		ReportingAnalyticsService,
		DailySummarySettingsService,
		ReportingDeliveryFailuresService,
		DailySummaryReportService,
		DailySummaryRunService,
		DailySummarySchedulerService,
		ReportingConsumerReceiptService,
		ReportingConsumerFailureFinalizerService,
		ReportingConsumerRouterService,
		ReportingWorkerService,
		ReportingOutboxPublisherService,
		ReportingMessagingOverviewService,
		ReportingHeartbeatService,
		ReportingHealthService
	]
})
export class ReportingModule implements NestModule, OnApplicationShutdown {
	constructor(private readonly prisma: ReportingPrismaService) {}

	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(reportingContextMiddleware).forRoutes('{*splat}');
	}

	async onApplicationShutdown(): Promise<void> {
		await waitForReportingShutdown(this.prisma.disconnect(), 5_000);
	}
}
