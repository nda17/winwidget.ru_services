import { HealthController } from '@/health/health.controller';
import { HealthService } from '@/health/health.service';
import { RabbitMqManagementModule } from '@/messaging/rabbitmq-management.module';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [RabbitMqManagementModule],
	controllers: [HealthController],
	providers: [HealthService, PrismaService],
	exports: [HealthService]
})
export class HealthModule {}
