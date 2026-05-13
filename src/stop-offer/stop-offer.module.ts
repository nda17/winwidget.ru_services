import { StopOfferApiController } from '@/stop-offer/stop-offer-api.controller';
import { StopOfferPublicController } from '@/stop-offer/stop-offer-public.controller';
import { StopOfferController } from '@/stop-offer/stop-offer.controller';
import { StopOfferService } from '@/stop-offer/stop-offer.service';
import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { SubscriptionService } from '@/subscription/subscription.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [
		StopOfferController,
		StopOfferPublicController,
		StopOfferApiController
	],
	providers: [
		StopOfferService,
		PrismaService,
		SubscriptionService,
		EmailService
	],
	exports: [StopOfferService]
})
export class StopOfferModule {}
