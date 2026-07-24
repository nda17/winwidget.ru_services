import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AffiliateModule } from '@/affiliate/affiliate.module';
import { AuthModule } from '@/auth/auth.module';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentController } from '@/payment/payment.controller';
import { PaymentService } from '@/payment/payment.service';
import { YookassaService } from '@/payment/yookassa.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { TariffPricesModule } from '@/tariff-prices/tariff-prices.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		TariffPricesModule,
		AffiliateModule,
		AdminEventLogModule
	],
	controllers: [PaymentController],
	providers: [PaymentService, YookassaService, PaymentCleanupService]
})
export class PaymentModule {}
