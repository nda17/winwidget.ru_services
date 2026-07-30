import { CampaignsRabbitMqService } from './campaigns-rabbitmq.service';
import { Module } from '@nestjs/common';

@Module({
	providers: [CampaignsRabbitMqService],
	exports: [CampaignsRabbitMqService]
})
export class CampaignsRabbitMqModule {}
