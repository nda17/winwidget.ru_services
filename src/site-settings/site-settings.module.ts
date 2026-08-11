import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { SiteSettingsController } from '@/site-settings/site-settings.controller';
import { SiteSettingsService } from '@/site-settings/site-settings.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule, BillingBoundaryModule],
	controllers: [SiteSettingsController],
	providers: [SiteSettingsService],
	exports: [SiteSettingsService]
})
export class SiteSettingsModule {}
