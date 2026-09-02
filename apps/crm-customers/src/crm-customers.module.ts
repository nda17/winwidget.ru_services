import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmCustomersHealthController } from './health/crm-customers-health.controller';
import { CrmCustomersHealthService } from './health/crm-customers-health.service';
import { CrmCustomersPrismaModule } from './prisma/crm-customers-prisma.module';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmCustomersPrismaModule
	],
	controllers: [CrmCustomersHealthController],
	providers: [CrmCustomersHealthService]
})
export class CrmCustomersModule {}
