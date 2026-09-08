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
import { CrmTeamController } from './team/team.controller';
import { CrmTeamService } from './team/team.service';
import { CrmEmployeeProfileService } from './team/team-profile.service';
import { CrmEmployeeProfileController } from './team/team-profile.controller';
import {
	CrmAssigneeController,
	CrmAssigneeAuthorizationController
} from './team/team-assignee.controller';
import { CrmAssigneeService } from './team/team-assignee.service';
import { IdentityInvitationClient } from './internal/identity-invitation.client';
import { CrmTeamAdmissionService } from './team/team-admission.service';
import { CrmTeamRabbitService } from './team/team-rabbit.service';
import { CrmTeamOutboxService } from './team/team-outbox.service';
import { CrmTeamWorkerService } from './team/team-worker.service';
import { parseCrmAccessRole } from './runtime/crm-access-runtime.service';
import { CrmBillingController } from './billing/billing.controller';
import {
	BillingOperationController,
	BillingOperationGuard
} from './billing/billing-operation.controller';
import { CrmBillingService } from './billing/billing.service';
import { CrmBillingCapacityService } from './billing/billing-capacity.service';
import { BillingCommerceClient } from './billing/billing-commerce.client';
import { CrmBillingReconciliationService } from './billing/billing-reconciliation.service';
import { CrmWorkspaceBrandingController } from './branding/workspace-branding.controller';
import { CrmWorkspaceBrandingService } from './branding/workspace-branding.service';
import { TaskReminderRecipientsController } from './team/task-reminder-recipients.controller';
import { TaskReminderRecipientsService } from './team/task-reminder-recipients.service';
import { TaskSeriesAuthorityController } from './team/task-series-authority.controller';
import { TaskSeriesAuthorityService } from './team/task-series-authority.service';
import { IntakeSlaAuthorityController } from './team/intake-sla-authority.controller';
import { IntakeSlaAuthorityService } from './team/intake-sla-authority.service';
import { IntakeSlaRecipientsService } from './team/intake-sla-recipients.service';

const role = parseCrmAccessRole(process.env.CRM_ACCESS_PROCESS_ROLE);

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		CrmAccessRuntimeModule,
		CrmAccessPrismaModule
	],
	controllers: [
		CrmAccessHealthController,
		...(role === 'api'
			? [
					CrmAccessController,
					CrmPermissionsController,
					CrmAuthorizationController,
					CrmTeamController,
					CrmEmployeeProfileController,
					CrmWorkspaceBrandingController,
					CrmAssigneeController,
					CrmAssigneeAuthorizationController,
					TaskReminderRecipientsController,
					TaskSeriesAuthorityController,
					IntakeSlaAuthorityController,
					CrmBillingController,
					BillingOperationController
				]
			: [])
	],
	providers: [
		CrmAuthorizationService,
		CrmInternalGuard,
		IdentityAuthContextClient,
		BillingEntitlementClient,
		CrmSalesPipelineClient,
		CrmAccessService,
		CrmAccessHealthService,
		CrmTeamService,
		CrmEmployeeProfileService,
		CrmWorkspaceBrandingService,
		CrmAssigneeService,
		TaskReminderRecipientsService,
		TaskSeriesAuthorityService,
		IntakeSlaAuthorityService,
		IntakeSlaRecipientsService,
		IdentityInvitationClient,
		CrmTeamAdmissionService,
		CrmTeamRabbitService,
		CrmTeamOutboxService,
		CrmTeamWorkerService,
		CrmBillingService,
		CrmBillingCapacityService,
		BillingCommerceClient,
		BillingOperationGuard,
		CrmBillingReconciliationService
	]
})
export class CrmAccessModule implements OnApplicationShutdown {
	constructor(private readonly prisma: CrmAccessPrismaService) {}

	async onApplicationShutdown(): Promise<void> {
		await this.prisma.disconnect();
	}
}
