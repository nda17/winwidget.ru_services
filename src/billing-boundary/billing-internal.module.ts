import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { BillingIdentityDirectoryService } from './billing-identity-directory.service';
import { BillingInternalController } from './billing-internal.controller';
import { BillingInternalTokenGuard } from './billing-internal-token.guard';
import { BillingLifecycleCompletionService } from './billing-lifecycle-completion.service';
import { BillingSourceRepairService } from './billing-source-repair.service';

@Module({
	imports: [AdminEventLogModule],
	controllers: [BillingInternalController],
	providers: [
		BillingInternalTokenGuard,
		BillingIdentityDirectoryService,
		BillingLifecycleCompletionService,
		BillingSourceRepairService
	]
})
export class BillingInternalModule {}
