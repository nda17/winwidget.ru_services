import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { BillingCoreStateService } from './billing-core-state.service';
import { BillingInternalClient } from './billing-internal.client';
import { BillingReadProjectionService } from './billing-read-projection.service';
import { BillingRegistrationBoundaryService } from './billing-registration-boundary.service';
import { BillingSettingsCompositionService } from './billing-settings-composition.service';

@Module({
	imports: [AdminEventLogModule],
	providers: [
		BillingCoreStateService,
		BillingInternalClient,
		BillingReadProjectionService,
		BillingRegistrationBoundaryService,
		BillingSettingsCompositionService
	],
	exports: [
		BillingCoreStateService,
		BillingInternalClient,
		BillingReadProjectionService,
		BillingRegistrationBoundaryService,
		BillingSettingsCompositionService
	]
})
export class BillingBoundaryModule {}
