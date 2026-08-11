import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { HealthController } from '@/health/health.controller';
import { HealthService } from '@/health/health.service';
import { NotificationDeliveryClientModule } from '@/messaging/notification-delivery-client.module';
import { BillingMessagingClientService } from '@/messaging/billing-messaging-client.service';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { WidgetsDeliveryFailuresClientService } from '@/messaging/widgets-delivery-failures-client.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		BillingBoundaryModule,
		NotificationDeliveryClientModule,
		RabbitMqManagementModule
	],
	controllers: [HealthController],
	providers: [
		HealthService,
		WidgetsDeliveryFailuresClientService,
		BillingMessagingClientService
	],
	exports: [HealthService]
})
export class HealthModule {}
