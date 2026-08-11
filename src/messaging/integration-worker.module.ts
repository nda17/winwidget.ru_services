import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { PaymentWorkerModule } from '@/payment/payment-worker.module';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaModule } from '@/prisma.module';
import { PrismaService } from '@/prisma.service';
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
		BillingBoundaryModule,
		RabbitMqModule,
		PaymentWorkerModule,
		ScheduledJobsModule
	],
	providers: [
		MessagingHeartbeatService,
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
