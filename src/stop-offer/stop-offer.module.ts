import { StopOfferApiController } from '@/stop-offer/stop-offer-api.controller';
import { StopOfferPublicController } from '@/stop-offer/stop-offer-public.controller';
import { StopOfferController } from '@/stop-offer/stop-offer.controller';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionService } from '@/subscription/subscription.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [SafeOutboundHttpModule],
	controllers: [
		StopOfferController,
		StopOfferPublicController,
		StopOfferApiController
	],
	providers: [StopOfferService, PrismaService, SubscriptionService],
	exports: [StopOfferService]
})
export class StopOfferModule {}
