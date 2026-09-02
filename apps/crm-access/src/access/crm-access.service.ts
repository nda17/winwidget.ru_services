import { ForbiddenException, Injectable } from '@nestjs/common';
import { CrmAccessLifecycle } from '@prisma/crm-access-client';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import {
	BillingEntitlementClient,
	type CrmEntitlementResponse,
	type CrmEntitlementStatus
} from '../internal/billing-entitlement.client';
import {
	IdentityAuthContextClient,
	type CrmIdentityAuthContext,
	type CrmWorkspaceMembership
} from '../internal/identity-auth-context.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import type { ActivateCrmTrialDto } from './crm-access.dto';

export type CrmBootstrapState =
	| 'WORKSPACE_SELECTION_REQUIRED'
	| 'NOT_ACTIVATED'
	| 'ONBOARDING'
	| 'ACTIVE'
	| 'GRACE'
	| 'READ_ONLY'
	| 'SUSPENDED'
	| 'EXPIRED'
	| 'CANCELLED';

@Injectable()
export class CrmAccessService {
	constructor(
		private readonly identity: IdentityAuthContextClient,
		private readonly billing: BillingEntitlementClient,
		private readonly prisma: CrmAccessPrismaService
	) {}

	async bootstrap(
		authorization: string | undefined,
		workspaceId?: string
	) {
		const correlationId = getCrmAccessCorrelationId();
		const context = await this.identity.authContext(
			authorization,
			correlationId
		);
		const selection = this.selectMembership(context, workspaceId);
		if (!selection) {
			return {
				schemaVersion: 1 as const,
				state: 'WORKSPACE_SELECTION_REQUIRED' as const,
				selectedWorkspaceId: null,
				workspaces: this.workspaceOptions(context)
			};
		}

		const [entitlement, access] = await Promise.all([
			this.billing.get(selection.workspaceId, correlationId),
			this.prisma.crmWorkspaceAccess.findUnique({
				where: { workspaceId: selection.workspaceId },
				select: { lifecycle: true }
			})
		]);
		return this.bootstrapResponse(
			context,
			selection,
			entitlement,
			access?.lifecycle || null
		);
	}

	async activateTrial(
		authorization: string | undefined,
		dto: ActivateCrmTrialDto
	) {
		const correlationId = getCrmAccessCorrelationId();
		const context = await this.identity.authContext(
			authorization,
			correlationId
		);
		const membership = this.requireMembership(context, dto.workspaceId);
		if (membership.role !== 'OWNER') {
			throw new ForbiddenException(
				'Only the workspace owner can activate WinCRM trial'
			);
		}

		const entitlement = await this.billing.activateTrial(
			{
				schemaVersion: 1,
				commandId: dto.commandId,
				workspaceId: dto.workspaceId,
				activatedByUserId: context.subject
			},
			correlationId
		);
		const access = await this.prisma.crmWorkspaceAccess.upsert({
			where: { workspaceId: dto.workspaceId },
			create: {
				workspaceId: dto.workspaceId,
				lifecycle: CrmAccessLifecycle.ONBOARDING,
				activatedBySubject: context.subject,
				trialActivationCommandId: dto.commandId
			},
			update: {},
			select: { lifecycle: true }
		});

		return {
			...this.bootstrapResponse(
				context,
				membership,
				entitlement,
				access.lifecycle
			),
			activated: entitlement.activated
		};
	}

	private selectMembership(
		context: CrmIdentityAuthContext,
		workspaceId?: string
	): CrmWorkspaceMembership | null {
		if (!context.memberships.length) {
			throw new ForbiddenException(
				'No active WinCRM workspace membership'
			);
		}
		if (workspaceId) return this.requireMembership(context, workspaceId);
		if (context.memberships.length === 1) return context.memberships[0];
		return null;
	}

	private requireMembership(
		context: CrmIdentityAuthContext,
		workspaceId: string
	): CrmWorkspaceMembership {
		const membership = context.memberships.find(
			item => item.workspaceId === workspaceId
		);
		if (!membership) {
			throw new ForbiddenException(
				'Workspace is not available to the current user'
			);
		}
		return membership;
	}

	private bootstrapResponse(
		context: CrmIdentityAuthContext,
		membership: CrmWorkspaceMembership,
		entitlement: CrmEntitlementResponse,
		lifecycle: CrmAccessLifecycle | null
	) {
		return {
			schemaVersion: 1 as const,
			state: this.state(entitlement.status, lifecycle),
			selectedWorkspaceId: membership.workspaceId,
			membership: {
				membershipId: membership.membershipId,
				role: membership.role
			},
			workspaces: this.workspaceOptions(context),
			entitlementStatus: entitlement.status,
			entitlement: entitlement.entitlement,
			access: lifecycle ? { lifecycle } : null
		};
	}

	private workspaceOptions(context: CrmIdentityAuthContext) {
		return context.memberships.map(membership => ({
			workspaceId: membership.workspaceId,
			membershipId: membership.membershipId,
			role: membership.role
		}));
	}

	private state(
		status: CrmEntitlementStatus,
		lifecycle: CrmAccessLifecycle | null
	): Exclude<CrmBootstrapState, 'WORKSPACE_SELECTION_REQUIRED'> {
		if (status === 'ACTIVE') {
			if (!lifecycle || lifecycle === CrmAccessLifecycle.ONBOARDING) {
				return 'ONBOARDING';
			}
			return lifecycle;
		}
		return status;
	}
}
