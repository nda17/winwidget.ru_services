import { RabbitMqService } from './rabbitmq.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [RabbitMqService],
	exports: [RabbitMqService]
})
export class RabbitMqModule {}
