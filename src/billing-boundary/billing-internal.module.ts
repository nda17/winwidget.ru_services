import { AuthModule } from '@/auth/auth.module';
import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { Module } from '@nestjs/common';
import { BillingAuthIntrospectionService } from './billing-auth-introspection.service';
import { BillingIdentityDirectoryService } from './billing-identity-directory.service';
import { BillingInternalController } from './billing-internal.controller';
import { BillingInternalTokenGuard } from './billing-internal-token.guard';
import { BillingLifecycleCompletionService } from './billing-lifecycle-completion.service';
import { BillingSourceRepairService } from './billing-source-repair.service';

@Module({
	imports: [AuthModule, AdminEventLogModule],
	controllers: [BillingInternalController],
	providers: [
		BillingInternalTokenGuard,
		BillingAuthIntrospectionService,
		BillingIdentityDirectoryService,
		BillingLifecycleCompletionService,
		BillingSourceRepairService
	]
})
export class BillingInternalModule {}
