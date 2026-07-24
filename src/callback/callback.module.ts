import { AuthModule } from '@/auth/auth.module';
import { FileModule } from '@/file/file.module';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { CallbackApiController } from '@/callback/callback-api.controller';
import { CallbackPublicController } from '@/callback/callback-public.controller';
import { CallbackController } from '@/callback/callback.controller';
import { CallbackService } from '@/callback/callback.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		FileModule,
		SafeOutboundHttpModule
	],
	controllers: [
		CallbackController,
		CallbackPublicController,
		CallbackApiController
	],
	providers: [CallbackService],
	exports: [CallbackService]
})
export class CallbackModule {}
