import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthModule } from '@/auth/auth.module';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
import { SubscriptionController } from '@/subscription/subscription.controller';
import { SubscriptionService } from '@/subscription/subscription.service';
import { WidgetsAdminOverviewClient } from '@/widgets-internal/widgets-admin-overview.client';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, AdminEventLogModule],
	controllers: [SubscriptionController],
	providers: [
		SubscriptionService,
		SubscriptionExpiryService,
		WidgetsAdminOverviewClient
	],
	exports: [SubscriptionService]
})
export class SubscriptionModule {}
