import { Global, Module } from '@nestjs/common';
import { CrmSalesPrismaService } from './crm-sales-prisma.service';

@Global()
@Module({
	providers: [CrmSalesPrismaService],
	exports: [CrmSalesPrismaService]
})
export class CrmSalesPrismaModule {}
