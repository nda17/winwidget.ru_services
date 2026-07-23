import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [RabbitMqManagementService],
	exports: [RabbitMqManagementService]
})
export class RabbitMqManagementModule {}
