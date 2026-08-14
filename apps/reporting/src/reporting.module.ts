import {
	ReportingAdminGuard,
	ReportingApiGuard
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
import { CoreInternalClient } from './internal/core-internal.client';
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
		ReportingMetricsController
	],
	providers: [
		CoreInternalClient,
		ReportingApiGuard,
		ReportingAdminGuard,
		ProjectionService,
		ReportingAnalyticsService,
		DailySummarySettingsService,
		ReportingDeliveryFailuresService,
		DailySummaryReportService,
		DailySummaryRunService,
		DailySummarySchedulerService,
		ReportingWorkerService,
		ReportingOutboxPublisherService,
		ReportingHeartbeatService,
		ReportingHealthService
	]
})
export class ReportingModule implements NestModule, OnApplicationShutdown {
	constructor(private readonly prisma: ReportingPrismaService) {}

	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(reportingContextMiddleware).forRoutes('*');
	}

	async onApplicationShutdown(): Promise<void> {
		await waitForReportingShutdown(this.prisma.disconnect(), 5_000);
	}
}
