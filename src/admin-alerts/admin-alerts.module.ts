import { HealthModule } from '@/health/health.module';
import { WidgetsAdminOverviewClient } from '@/widgets-internal/widgets-admin-overview.client';
import { Module } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

@Module({
	imports: [HealthModule],
	controllers: [AdminAlertsController],
	providers: [AdminAlertsService, WidgetsAdminOverviewClient]
})
export class AdminAlertsModule {}
