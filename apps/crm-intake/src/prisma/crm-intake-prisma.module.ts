import { Global, Module } from '@nestjs/common';
import { CrmIntakePrismaService } from './crm-intake-prisma.service';

@Global()
@Module({
	providers: [CrmIntakePrismaService],
	exports: [CrmIntakePrismaService]
})
export class CrmIntakePrismaModule {}
