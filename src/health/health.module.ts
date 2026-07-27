import { HealthController } from '@/health/health.controller';
import { HealthService } from '@/health/health.service';
import { NotificationDeliveryClientModule } from '@/messaging/notification-delivery-client.module';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [NotificationDeliveryClientModule, RabbitMqManagementModule],
	controllers: [HealthController],
	providers: [HealthService],
	exports: [HealthService]
})
export class HealthModule {}
