import { EmailModule } from '@/email/email.module';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { IntegrationWorkerService } from '@/messaging/integration-worker.service';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqModule } from '@/messaging/rabbitmq.module';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true
		}),
		RabbitMqModule,
		EmailModule,
		SafeOutboundHttpModule
	],
	providers: [
		PrismaService,
		MessagingHeartbeatService,
		IntegrationDeliveryService,
		IntegrationWorkerService
	]
})
export class IntegrationWorkerModule {}
