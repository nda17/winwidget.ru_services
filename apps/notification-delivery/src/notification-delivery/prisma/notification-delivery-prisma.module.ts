import { Global, Module } from '@nestjs/common';
import { NotificationDeliveryPrismaService } from './notification-delivery-prisma.service';

@Global()
@Module({
	providers: [NotificationDeliveryPrismaService],
	exports: [NotificationDeliveryPrismaService]
})
export class NotificationDeliveryPrismaModule {}
