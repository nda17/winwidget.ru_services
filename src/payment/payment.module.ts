import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { AuthModule } from '@/auth/auth.module';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentController } from '@/payment/payment.controller';
import { PaymentService } from '@/payment/payment.service';
import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { TariffPricesModule } from '@/tariff-prices/tariff-prices.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		TariffPricesModule,
		AdminEventLogModule
	],
	controllers: [PaymentController],
	providers: [
		PaymentService,
		YookassaService,
		PrismaService,
		PaymentCleanupService
	]
})
export class PaymentModule {}
