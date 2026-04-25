import { AuthModule } from '@/auth/auth.module';
import { EmailModule } from '@/email/email.module';
import { PrismaService } from '@/prisma.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { CallbackApiController } from '@/callback/callback-api.controller';
import { CallbackPublicController } from '@/callback/callback-public.controller';
import { CallbackController } from '@/callback/callback.controller';
import { CallbackService } from '@/callback/callback.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, SubscriptionModule, EmailModule],
	controllers: [
		CallbackController,
		CallbackPublicController,
		CallbackApiController
	],
	providers: [CallbackService, PrismaService],
	exports: [CallbackService]
})
export class CallbackModule {}
