import { EmailModule } from '@/email/email.module';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { DailySummaryDeliveryService } from '@/reports/daily-summary-delivery.service';
import { DailySummaryReportService } from '@/reports/daily-summary-report.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { ScheduledJobsModule } from '@/scheduled-jobs/scheduled-jobs.module';
import { TelegramInfoTransportModule } from '@/telegram-bot/telegram-info-transport.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		PrismaModule,
		RabbitMqModule,
		EmailModule,
		SafeOutboundHttpModule,
		ScheduledJobsModule,
		TelegramInfoTransportModule
	],
	providers: [
		MessagingHeartbeatService,
		DailySummaryReportService,
		DailySummaryDeliveryService,
		LeadIntegrationDestinationService,
		IntegrationDeliveryService,
		IntegrationWorkerService
	]
})
export class IntegrationWorkerModule implements OnApplicationShutdown {
	constructor(private readonly prisma: PrismaService) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}
