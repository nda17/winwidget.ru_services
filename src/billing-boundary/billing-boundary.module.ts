import { Module } from '@nestjs/common';
import { BillingCoreStateService } from './billing-core-state.service';
import { BillingReadProjectionService } from './billing-read-projection.service';

@Module({
	providers: [BillingCoreStateService, BillingReadProjectionService],
	exports: [BillingCoreStateService, BillingReadProjectionService]
})
export class BillingBoundaryModule {}
