import { NotificationDeliveryClientService } from '@/messaging/notification-delivery-client.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
	imports: [ConfigModule],
	providers: [NotificationDeliveryClientService],
	exports: [NotificationDeliveryClientService]
})
export class NotificationDeliveryClientModule {}
