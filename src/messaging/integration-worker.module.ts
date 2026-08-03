import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { PaymentWorkerModule } from '@/payment/payment-worker.module';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { ScheduledJobsModule } from '@/scheduled-jobs/scheduled-jobs.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		PrismaModule,
		AdminEventLogModule,
		RabbitMqModule,
		PaymentWorkerModule,
		SafeOutboundHttpModule,
		ScheduledJobsModule
	],
	providers: [
		MessagingHeartbeatService,
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
