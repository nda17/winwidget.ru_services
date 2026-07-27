import { EmailModule } from '../email/email.module';
import { RabbitMqModule } from '../messaging/rabbitmq.module';
import { NotificationDeliveryControlModule } from './control/notification-delivery-control.module';
import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import { NotificationDeliveryHealthController } from './notification-delivery-health.controller';
import { NotificationDeliveryHealthService } from './notification-delivery-health.service';
import { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import { NotificationDeliveryOutboxPublisherService } from './notification-delivery-outbox-publisher.service';
import { NotificationDeliveryRetentionService } from './notification-delivery-retention.service';
import { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { NotificationDeliveryPrismaModule } from './prisma/notification-delivery-prisma.module';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import { TelegramInfoTransportModule } from '../telegram/telegram-info-transport.module';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		NotificationDeliveryPrismaModule,
		NotificationDeliveryControlModule,
		RabbitMqModule,
		EmailModule,
		TelegramInfoTransportModule
	],
	controllers: [NotificationDeliveryHealthController],
	providers: [
		NotificationDeliveryAdapterService,
		NotificationDeliveryHeartbeatService,
		NotificationDeliveryWorkerService,
		NotificationDeliveryOutboxPublisherService,
		NotificationDeliveryRetentionService,
		NotificationDeliveryHealthService
	]
})
export class NotificationDeliveryModule implements OnApplicationShutdown {
	constructor(
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	onApplicationShutdown() {
		return this.prisma.disconnect();
	}
}
