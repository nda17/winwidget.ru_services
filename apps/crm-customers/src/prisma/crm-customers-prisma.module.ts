import { Global, Module } from '@nestjs/common';
import { CrmCustomersPrismaService } from './crm-customers-prisma.service';

@Global()
@Module({
	providers: [CrmCustomersPrismaService],
	exports: [CrmCustomersPrismaService]
})
export class CrmCustomersPrismaModule {}
