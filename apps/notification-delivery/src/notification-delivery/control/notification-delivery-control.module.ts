import { Module } from '@nestjs/common';
import { NotificationDeliveryControlController } from './notification-delivery-control.controller';
import { NotificationDeliveryControlService } from './notification-delivery-control.service';
import { NotificationDeliveryInternalTokenGuard } from './notification-delivery-internal-token.guard';

@Module({
	controllers: [NotificationDeliveryControlController],
	providers: [
		NotificationDeliveryControlService,
		NotificationDeliveryInternalTokenGuard
	],
	exports: [NotificationDeliveryControlService]
})
export class NotificationDeliveryControlModule {}
