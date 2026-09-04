import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmCustomersHealthController } from './health/crm-customers-health.controller';
import { CrmCustomersHealthService } from './health/crm-customers-health.service';
import { CrmCustomersPrismaModule } from './prisma/crm-customers-prisma.module';
import { CustomersAuthorizationClient } from './access/customers-authorization.client';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmCustomersPrismaModule
	],
	controllers: [CrmCustomersHealthController, CustomersController],
	providers: [
		CrmCustomersHealthService,
		CustomersAuthorizationClient,
		CustomersService
	]
})
export class CrmCustomersModule {}
