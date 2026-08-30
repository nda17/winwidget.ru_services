import {
	CampaignsApiGuard,
	CampaignsAuthGuard,
	CampaignsMessagingInternalGuard
} from './auth/campaigns-auth.guard';
import { AudienceExportReaderService } from './campaigns/audience-export-reader.service';
import { AudienceSnapshotImportCoordinatorService } from './campaigns/audience-snapshot-import-coordinator.service';
import { AudienceSnapshotService } from './campaigns/audience-snapshot.service';
import { CampaignDispatchPreparationService } from './campaigns/campaign-dispatch-preparation.service';
import { CampaignsController } from './campaigns/campaigns.controller';
import { CampaignsService } from './campaigns/campaigns.service';
import { CampaignsHealthController } from './health/campaigns-health.controller';
import { CampaignsHealthService } from './health/campaigns-health.service';
import { CampaignsHeartbeatService } from './health/campaigns-heartbeat.service';
import { CampaignsDependenciesClient } from './internal/campaigns-dependencies.client';
import { CampaignsMessagingOverviewController } from './internal/campaigns-messaging-overview.controller';
import { CampaignsDispatchCoordinatorService } from './messaging/campaigns-dispatch-coordinator.service';
import { CampaignsMessagingOverviewService } from './messaging/campaigns-messaging-overview.service';
import { CampaignsOutboxPublisherService } from './messaging/campaigns-outbox-publisher.service';
import { CampaignsRabbitMqModule } from './messaging/campaigns-rabbitmq.module';
import { CampaignsWorkerService } from './messaging/campaigns-worker.service';
import { CampaignsPrismaModule } from './prisma/campaigns-prisma.module';
import { CampaignsPrismaService } from './prisma/campaigns-prisma.service';
import { CampaignsRuntimeModule } from './runtime/campaigns-runtime.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CampaignsRuntimeModule,
		CampaignsPrismaModule,
		CampaignsRabbitMqModule
	],
	controllers: [
		CampaignsController,
		CampaignsHealthController,
		CampaignsMessagingOverviewController
	],
	providers: [
		CampaignsDependenciesClient,
		CampaignsApiGuard,
		CampaignsAuthGuard,
		CampaignsMessagingInternalGuard,
		CampaignsService,
		AudienceExportReaderService,
		AudienceSnapshotImportCoordinatorService,
		CampaignDispatchPreparationService,
		AudienceSnapshotService,
		CampaignsWorkerService,
		CampaignsDispatchCoordinatorService,
		CampaignsOutboxPublisherService,
		CampaignsMessagingOverviewService,
		CampaignsHeartbeatService,
		CampaignsHealthService
	]
})
export class CampaignsModule implements OnApplicationShutdown {
	constructor(private readonly prisma: CampaignsPrismaService) {}

	onApplicationShutdown(): Promise<void> {
		return this.prisma.disconnect();
	}
}
