import { AuthModule } from '@/auth/auth.module';
import { PrismaService } from '@/prisma.service';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
import { SubscriptionController } from '@/subscription/subscription.controller';
import { SubscriptionService } from '@/subscription/subscription.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule],
	controllers: [SubscriptionController],
	providers: [
		SubscriptionService,
		SubscriptionExpiryService,
		PrismaService
	],
	exports: [SubscriptionService]
})
export class SubscriptionModule {}
