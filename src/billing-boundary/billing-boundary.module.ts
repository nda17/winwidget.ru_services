import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { BillingCoreStateService } from './billing-core-state.service';
import { BillingInternalClient } from './billing-internal.client';
import { BillingReadProjectionService } from './billing-read-projection.service';
import { BillingSettingsCompositionService } from './billing-settings-composition.service';

@Module({
	imports: [AdminEventLogModule],
	providers: [
		BillingCoreStateService,
		BillingInternalClient,
		BillingReadProjectionService,
		BillingSettingsCompositionService
	],
	exports: [
		BillingCoreStateService,
		BillingInternalClient,
		BillingReadProjectionService,
		BillingSettingsCompositionService
	]
})
export class BillingBoundaryModule {}
