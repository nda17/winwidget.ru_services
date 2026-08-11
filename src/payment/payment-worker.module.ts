import { AffiliateService } from '@/affiliate/affiliate.service';
import { BillingBoundaryModule } from '@/billing-boundary/billing-boundary.module';
import { AutoRenewalService } from '@/payment/auto-renewal.service';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentMethodCryptoService } from '@/payment/payment-method-crypto.service';
import { PaymentReceiptService } from '@/payment/payment-receipt.service';
import { PaymentService } from '@/payment/payment.service';
import { YookassaService } from '@/payment/yookassa.service';
import { SubscriptionService } from '@/subscription/subscription.service';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [BillingBoundaryModule],
	providers: [
		PaymentService,
		YookassaService,
		PaymentCleanupService,
		PaymentMethodCryptoService,
		PaymentReceiptService,
		AutoRenewalService,
		SubscriptionService,
		TariffPricesService,
		AffiliateService
	],
	exports: [PaymentService]
})
export class PaymentWorkerModule {}
