import { PaymentModule } from '@/payment/payment.module';
import { AutoRenewalSchedulerService } from '@/payment/auto-renewal-scheduler.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [PaymentModule],
	providers: [AutoRenewalSchedulerService]
})
export class AutoRenewalSchedulerModule {}
