import { HealthModule } from '@/health/health.module';
import { Module } from '@nestjs/common';
import { AdminAlertsController } from './admin-alerts.controller';
import { AdminAlertsService } from './admin-alerts.service';

@Module({
	imports: [HealthModule],
	controllers: [AdminAlertsController],
	providers: [AdminAlertsService]
})
export class AdminAlertsModule {}
