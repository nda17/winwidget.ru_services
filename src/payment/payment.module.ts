import { AuthModule } from '@/auth/auth.module';
import { PaymentCleanupService } from '@/payment/payment-cleanup.service';
import { PaymentController } from '@/payment/payment.controller';
import { PaymentService } from '@/payment/payment.service';
import { YookassaService } from '@/payment/yookassa.service';
import { PrismaService } from '@/prisma.service';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [AuthModule, SubscriptionModule],
	controllers: [PaymentController],
	providers: [
		PaymentService,
		YookassaService,
		PrismaService,
		PaymentCleanupService
	]
})
export class PaymentModule {}
