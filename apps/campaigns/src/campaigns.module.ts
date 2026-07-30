import {
	CampaignsApiGuard,
	CampaignsAuthGuard
} from './auth/campaigns-auth.guard';
import { AudienceSnapshotService } from './campaigns/audience-snapshot.service';
import { CampaignsController } from './campaigns/campaigns.controller';
import { CampaignsService } from './campaigns/campaigns.service';
import { CampaignsHealthController } from './health/campaigns-health.controller';
import { CampaignsHealthService } from './health/campaigns-health.service';
import { CampaignsHeartbeatService } from './health/campaigns-heartbeat.service';
import { CoreInternalClient } from './internal/core-internal.client';
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
	controllers: [CampaignsController, CampaignsHealthController],
	providers: [
		CoreInternalClient,
		CampaignsApiGuard,
		CampaignsAuthGuard,
		CampaignsService,
		AudienceSnapshotService,
		CampaignsWorkerService,
		CampaignsOutboxPublisherService,
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
