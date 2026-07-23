import { CountdownTimerApiController } from '@/countdown-timer/countdown-timer-api.controller';
import { CountdownTimerPublicController } from '@/countdown-timer/countdown-timer-public.controller';
import { CountdownTimerController } from '@/countdown-timer/countdown-timer.controller';
import { CountdownTimerService } from '@/countdown-timer/countdown-timer.service';
import { FileModule } from '@/file/file.module';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionService } from '@/subscription/subscription.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [FileModule, SafeOutboundHttpModule],
	controllers: [
		CountdownTimerController,
		CountdownTimerPublicController,
		CountdownTimerApiController
	],
	providers: [CountdownTimerService, PrismaService, SubscriptionService],
	exports: [CountdownTimerService]
})
export class CountdownTimerModule {}
