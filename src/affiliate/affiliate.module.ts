import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { Module } from '@nestjs/common';
import { AffiliateController } from './affiliate.controller';
import { AffiliateService } from './affiliate.service';

@Module({
	imports: [AdminEventLogModule, BillingBoundaryModule],
	controllers: [AffiliateController],
	providers: [AffiliateService],
	exports: [AffiliateService]
})
export class AffiliateModule {}
