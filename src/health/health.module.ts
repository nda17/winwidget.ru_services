import { HealthController } from '@/health/health.controller';
import { HealthService } from '@/health/health.service';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [RabbitMqManagementModule],
	controllers: [HealthController],
	providers: [HealthService],
	exports: [HealthService]
})
export class HealthModule {}
