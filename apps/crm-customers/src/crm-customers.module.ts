import { Module } from '@nestjs/common';
import { CustomersExportController } from './exports/export.controller';
import { CustomersExportService } from './exports/export.service';
import { ConfigModule } from '@nestjs/config';
import { CrmCustomersHealthController } from './health/crm-customers-health.controller';
import { CrmCustomersHealthService } from './health/crm-customers-health.service';
import { CrmCustomersPrismaModule } from './prisma/crm-customers-prisma.module';
import { CustomersAuthorizationClient } from './access/customers-authorization.client';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { ContactIntakeOperationService } from './intake-operations/intake-operation.service';
import {
	ContactIntakeOperationController,
	ContactIntakeOperationGuard
} from './intake-operations/intake-operation.controller';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmCustomersPrismaModule
	],
	controllers: [
		CrmCustomersHealthController,
		CustomersController,
		CustomersExportController,
		ContactIntakeOperationController
	],
	providers: [
		CrmCustomersHealthService,
		CustomersAuthorizationClient,
		CustomersService,
		CustomersExportService,
		ContactIntakeOperationService,
		ContactIntakeOperationGuard
	]
})
export class CrmCustomersModule {}
