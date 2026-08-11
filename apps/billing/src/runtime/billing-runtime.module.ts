import { Global, Module } from '@nestjs/common';
import { BillingRuntimeService } from './billing-runtime.service';

@Global()
@Module({
	providers: [BillingRuntimeService],
	exports: [BillingRuntimeService]
})
export class BillingRuntimeModule {}
