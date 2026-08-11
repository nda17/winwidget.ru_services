import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AffiliateModule } from '@/affiliate/affiliate.module';
import { AuthModule } from '@/auth/auth.module';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { AutoRenewalService } from '@/payment/auto-renewal.service';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentController } from '@/payment/payment.controller';
import { PaymentMethodCryptoService } from '@/payment/payment-method-crypto.service';
import { PaymentReceiptService } from '@/payment/payment-receipt.service';
import { PaymentService } from '@/payment/payment.service';
import { YookassaService } from '@/payment/yookassa.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { TariffPricesModule } from '@/tariff-prices/tariff-prices.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		BillingBoundaryModule,
		SubscriptionModule,
		TariffPricesModule,
		AffiliateModule,
		AdminEventLogModule
	],
	controllers: [PaymentController],
	providers: [
		PaymentService,
		YookassaService,
		PaymentCleanupService,
		PaymentMethodCryptoService,
		PaymentReceiptService,
		AutoRenewalService
	],
	exports: [PaymentService, AutoRenewalService]
})
export class PaymentModule {}
