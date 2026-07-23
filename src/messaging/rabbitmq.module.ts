import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [RabbitMqService],
	exports: [RabbitMqService]
})
export class RabbitMqModule {}
