import { HealthController } from '@/health/health.controller';
import { HealthService } from '@/health/health.service';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [HealthController],
	providers: [HealthService, PrismaService]
})
export class HealthModule {}
