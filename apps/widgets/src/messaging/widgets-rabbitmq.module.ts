import { Global, Module } from '@nestjs/common';
import { WidgetsRabbitMqService } from './widgets-rabbitmq.service';

@Global()
@Module({
	providers: [WidgetsRabbitMqService],
	exports: [WidgetsRabbitMqService]
})
export class WidgetsRabbitMqModule {}
