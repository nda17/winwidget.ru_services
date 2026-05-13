import { HealthModule } from '@/health/health.module';
import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

@Module({
	imports: [HealthModule],
	controllers: [AdminAlertsController],
	providers: [AdminAlertsService, PrismaService]
})
export class AdminAlertsModule {}
