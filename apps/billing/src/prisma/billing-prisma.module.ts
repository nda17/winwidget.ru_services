import { Global, Module } from '@nestjs/common';
import { BillingPrismaService } from './billing-prisma.service';

@Global()
@Module({
	providers: [BillingPrismaService],
	exports: [BillingPrismaService]
})
export class BillingPrismaModule {}
