import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CrmAccessController } from './access/crm-access.controller';
import { CrmAccessService } from './access/crm-access.service';
import { CrmAccessHealthController } from './health/crm-access-health.controller';
import { CrmAccessHealthService } from './health/crm-access-health.service';
import { BillingEntitlementClient } from './internal/billing-entitlement.client';
import { IdentityAuthContextClient } from './internal/identity-auth-context.client';
import { CrmAccessPrismaModule } from './prisma/crm-access-prisma.module';
import { CrmAccessPrismaService } from './prisma/crm-access-prisma.service';
import { CrmAccessRuntimeModule } from './runtime/crm-access-runtime.module';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmAccessRuntimeModule,
		CrmAccessPrismaModule
	],
	controllers: [CrmAccessHealthController, CrmAccessController],
	providers: [
		IdentityAuthContextClient,
		BillingEntitlementClient,
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
