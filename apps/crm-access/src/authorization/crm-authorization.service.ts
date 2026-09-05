import { ForbiddenException, Injectable } from '@nestjs/common';
import { CrmAccessLifecycle } from '@prisma/crm-access-client';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import { BillingEntitlementClient } from '../internal/billing-entitlement.client';
import {
	IdentityAuthContextClient,
	type CrmWorkspaceMembership
} from '../internal/identity-auth-context.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';

export type CrmRole =
	| 'OWNER'
	| 'CRM_ADMIN'
	| 'TEAM_LEAD'
	| 'MANAGER'
	| 'ANALYST';
export type CrmCaller = 'crm-customers' | 'crm-sales' | 'crm-intake';

const READ_PERMISSIONS = [
	'customers:read',
	'sales:read',
	'intake:read',
	'sales:analytics'
] as const;
const WRITE_PERMISSIONS = [
	'customers:write',
	'sales:write',
	'intake:write'
] as const;
const ADMIN_PERMISSIONS = [
	'customers:merge',
	'sales:manage-pipelines',
	'intake:manage-sources',
	'access:manage-team'
] as const;
const OWNER_PERMISSIONS = [
	'customers:export',
	'sales:export',
	'intake:export'
] as const;

@Injectable()
export class CrmAuthorizationService {
	constructor(
		private readonly identity: IdentityAuthContextClient,
		private readonly billing: BillingEntitlementClient,
		private readonly prisma: CrmAccessPrismaService
	) {}

	async authorize(
		authorization: string | undefined,
		workspaceId: string,
		caller?: CrmCaller
	) {
		const correlationId = getCrmAccessCorrelationId();
		const identity = await this.identity.authContext(
			authorization,
			correlationId
		);
		const membership = identity.memberships.find(
			item => item.workspaceId === workspaceId
		);
		return this.resolve(
			workspaceId,
			identity.subject,
			membership,
			correlationId,
			caller
		);
	}

	async authorizeSource(workspaceId: string, subject: string) {
		const context = await this.authorizeSubject(
			workspaceId,
			subject,
			'crm-intake'
		);
		if (
			context.state === 'READ_ONLY' ||
			!['OWNER', 'CRM_ADMIN'].includes(context.role) ||
			!context.permissions.includes('intake:manage-sources')
		)
			throw new ForbiddenException('Source delegation is not active');
		return context;
	}

	async authorizeWidgetSource(workspaceId: string, subject: string) {
		const correlationId = getCrmAccessCorrelationId();
		const identity = await this.identity.widgetSourceContext(
			workspaceId,
			subject,
			correlationId
		);
		if (!identity.ownerSubject || !identity.membership)
			throw new ForbiddenException('Widget source owner is not available');
		const context = await this.resolve(
			workspaceId,
			subject,
			identity.membership,
			correlationId,
			'crm-intake'
		);
		if (
			context.state === 'READ_ONLY' ||
			!['OWNER', 'CRM_ADMIN'].includes(context.role) ||
			!context.permissions.includes('intake:manage-sources')
		)
			throw new ForbiddenException(
				'Widget source delegation is not active'
			);
		return { ...context, ownerSubject: identity.ownerSubject };
	}

	async authorizeSubject(
		workspaceId: string,
		subject: string,
		caller?: CrmCaller
	) {
		const correlationId = getCrmAccessCorrelationId();
		const identity = await this.identity.sourceContext(
			workspaceId,
			subject,
			correlationId
		);
		return this.resolve(
			workspaceId,
			identity.subject,
			identity.membership,
			correlationId,
			caller
		);
	}

	async authorizeWorkflow(
		workspaceId: string,
		subject: string,
		purpose: string,
		caller: CrmCaller
	) {
		const required = {
			'crm-intake': ['intake:write'],
			'crm-customers': ['customers:read', 'customers:write'],
			'crm-sales': ['sales:write']
		} as const;
		if (purpose !== 'INTAKE_ACCEPT' || !Object.hasOwn(required, caller))
			throw new ForbiddenException('Unsupported workflow authority');
		const context = await this.authorizeSubject(
			workspaceId,
			subject,
			caller
		);
		if (
			context.state === 'READ_ONLY' ||
			context.role === 'ANALYST' ||
			!required[caller].every(permission =>
				context.permissions.includes(permission)
			)
		)
			throw new ForbiddenException('Workflow execution is not permitted');
		return context;
	}

	private async resolve(
		workspaceId: string,
		subject: string,
		membership: CrmWorkspaceMembership | null | undefined,
		correlationId: string,
		caller?: CrmCaller
	) {
		if (!membership)
			throw new ForbiddenException('Workspace membership is required');
		const [billing, workspace, member] = await Promise.all([
			this.billing.get(workspaceId, correlationId),
			this.prisma.crmWorkspaceAccess.findUnique({
				where: { workspaceId }
			}),
			membership.role === 'OWNER'
				? null
				: this.prisma.crmWorkspaceMember.findUnique({
						where: {
							workspaceId_subject: {
								workspaceId,
								subject
							}
						},
						include: {
							teams: {
								where: { team: { archivedAt: null } },
								select: { teamId: true },
								orderBy: { teamId: 'asc' }
							}
						}
					})
		]);
		if (
			!workspace ||
			!billing.entitlement ||
			workspace.billingEntitlementId !== billing.entitlement.id ||
			!workspace.onboardingCompletedAt ||
			![CrmAccessLifecycle.ACTIVE, CrmAccessLifecycle.READ_ONLY].includes(
				workspace.lifecycle as 'ACTIVE' | 'READ_ONLY'
			) ||
			!['ACTIVE', 'GRACE', 'READ_ONLY'].includes(billing.status)
		) {
			throw new ForbiddenException('WinCRM workspace is not available');
		}
		if (
			membership.role !== 'OWNER' &&
			(!member ||
				member.disabledAt ||
				member.membershipId !== membership.membershipId)
		) {
			throw new ForbiddenException('An active CRM role is required');
		}
		const role: CrmRole =
			membership.role === 'OWNER' ? 'OWNER' : member!.role;
		const state =
			workspace.lifecycle === CrmAccessLifecycle.READ_ONLY ||
			billing.status === 'READ_ONLY'
				? 'READ_ONLY'
				: (billing.status as 'ACTIVE' | 'GRACE');
		const canWrite = state !== 'READ_ONLY' && role !== 'ANALYST';
		const permissions: string[] =
			role === 'ANALYST' ? ['sales:analytics'] : [...READ_PERMISSIONS];
		if (canWrite) permissions.push(...WRITE_PERMISSIONS);
		if (canWrite && (role === 'OWNER' || role === 'CRM_ADMIN'))
			permissions.push(...ADMIN_PERMISSIONS);
		if (role === 'OWNER' || role === 'CRM_ADMIN') {
			permissions.push('access:read-team');
			if (canWrite) permissions.push('access:revoke-access');
		}
		if (role === 'OWNER') permissions.push(...OWNER_PERMISSIONS);
		const namespace = caller?.replace('crm-', '');
		return {
			schemaVersion: 1 as const,
			workspaceId,
			subject,
			role,
			state,
			dataScope:
				role === 'MANAGER'
					? ('OWN' as const)
					: role === 'TEAM_LEAD'
						? ('TEAM' as const)
						: ('ALL' as const),
			teamIds: member?.teams.map(team => team.teamId) ?? [],
			permissions: namespace
				? permissions.filter(permission =>
						permission.startsWith(`${namespace}:`)
					)
				: permissions
		};
	}
}
