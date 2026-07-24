import { AuthModule } from '@/auth/auth.module';
import { CalculatorApiController } from '@/calculator/calculator-api.controller';
import { CalculatorPublicController } from '@/calculator/calculator-public.controller';
import { CalculatorController } from '@/calculator/calculator.controller';
import { CalculatorService } from '@/calculator/calculator.service';
import { FileModule } from '@/file/file.module';
import { SafeOutboundHttpModule } from '@/safe-outbound-http/safe-outbound-http.module';
import { SubscriptionModule } from '@/subscription/subscription.module';
import { Module } from '@nestjs/common';

@Module({
	imports: [
		AuthModule,
		SubscriptionModule,
		FileModule,
		SafeOutboundHttpModule
	],
	controllers: [
		CalculatorController,
		CalculatorPublicController,
		CalculatorApiController
	],
	providers: [CalculatorService],
	exports: [CalculatorService]
})
export class CalculatorModule {}
