import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmAccessController } from './access/crm-access.controller';
import { CrmAccessService } from './access/crm-access.service';
import { CrmAccessHealthController } from './health/crm-access-health.controller';
import { CrmAccessHealthService } from './health/crm-access-health.service';
import { BillingEntitlementClient } from './internal/billing-entitlement.client';
import { IdentityAuthContextClient } from './internal/identity-auth-context.client';
import { CrmSalesPipelineClient } from './internal/crm-sales-pipeline.client';
import { CrmAccessPrismaModule } from './prisma/crm-access-prisma.module';
import { CrmAccessPrismaService } from './prisma/crm-access-prisma.service';
import { CrmAccessRuntimeModule } from './runtime/crm-access-runtime.module';
import {
	CrmAuthorizationController,
	CrmPermissionsController
} from './authorization/crm-authorization.controller';
import { CrmAuthorizationService } from './authorization/crm-authorization.service';
import { CrmInternalGuard } from './authorization/crm-internal.guard';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmAccessRuntimeModule,
		CrmAccessPrismaModule
	],
	controllers: [
		CrmAccessHealthController,
		CrmAccessController,
		CrmPermissionsController,
		CrmAuthorizationController
	],
	providers: [
		CrmAuthorizationService,
		CrmInternalGuard,
		IdentityAuthContextClient,
		BillingEntitlementClient,
		CrmSalesPipelineClient,
		CrmAccessService,
		CrmAccessHealthService
	]
})
export class CrmAccessModule implements OnApplicationShutdown {
	constructor(private readonly prisma: CrmAccessPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
