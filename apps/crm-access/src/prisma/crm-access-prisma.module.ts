import { Global, Module } from '@nestjs/common';
import { CrmAccessPrismaService } from './crm-access-prisma.service';

@Global()
@Module({
	providers: [CrmAccessPrismaService],
	exports: [CrmAccessPrismaService]
})
export class CrmAccessPrismaModule {}
