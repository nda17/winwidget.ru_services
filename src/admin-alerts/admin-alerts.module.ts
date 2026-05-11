import { PrismaService } from '@/prisma.service';
import { Module } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

@Module({
	controllers: [AdminAlertsController],
	providers: [AdminAlertsService, PrismaService]
})
export class AdminAlertsModule {}
