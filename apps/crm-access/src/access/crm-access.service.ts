import {
	ConflictException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAccessLifecycle } from '@prisma/crm-access-client';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import {
	BillingEntitlementClient,
	type CrmEntitlementDetails,
	type CrmEntitlementResponse,
	type CrmEntitlementStatus
} from '../internal/billing-entitlement.client';
import {
	IdentityAuthContextClient,
	type CrmIdentityAuthContext,
	type CrmWorkspaceMembership
} from '../internal/identity-auth-context.client';
import {
	CrmSalesPipelineClient,
	type CrmSalesPipelineInstallation
} from '../internal/crm-sales-pipeline.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import type {
	ActivateCrmTrialDto,
	InstallCrmPipelineTemplateDto
} from './crm-access.dto';

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

const CRM_ACCESS_PROFILE_SELECT = {
	lifecycle: true,
	billingEntitlementId: true,
	provisioningCommandId: true,
	provisioningCommandType: true,
	activatedBySubject: true,
	onboardingCommandId: true,
	onboardingTemplateKey: true,
	onboardingTemplateVersion: true,
	onboardingTemplateFingerprint: true,
	onboardingPipelineId: true,
	onboardingCompletedAt: true
} as const;

interface CrmAccessProfile {
	lifecycle: CrmAccessLifecycle;
	billingEntitlementId: string;
	provisioningCommandId: string;
	provisioningCommandType: string;
	activatedBySubject: string;
	onboardingCommandId: string | null;
	onboardingTemplateKey: string | null;
	onboardingTemplateVersion: number | null;
	onboardingTemplateFingerprint: string | null;
	onboardingPipelineId: string | null;
	onboardingCompletedAt: Date | null;
}

@Injectable()
export class CrmAccessService {
	constructor(
		private readonly identity: IdentityAuthContextClient,
		private readonly billing: BillingEntitlementClient,
		private readonly sales: CrmSalesPipelineClient,
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

		const [entitlement, storedAccess] = await Promise.all([
			this.billing.get(selection.workspaceId, correlationId),
			this.prisma.crmWorkspaceAccess.findUnique({
				where: { workspaceId: selection.workspaceId },
				select: CRM_ACCESS_PROFILE_SELECT
			})
		]);
		const access =
			entitlement.status === 'ACTIVE'
				? await this.reconcileAccessProfile(
						selection.workspaceId,
						entitlement.entitlement,
						storedAccess
					)
				: storedAccess;
		if (
			entitlement.status === 'ACTIVE' &&
			access?.lifecycle === CrmAccessLifecycle.ONBOARDING
		) {
			const installed = await this.sales.getInstallation(
				selection.workspaceId,
				correlationId
			);
			if (installed) {
				const confirmedEntitlement = await this.billing.get(
					selection.workspaceId,
					correlationId
				);
				if (confirmedEntitlement.status !== 'ACTIVE') {
					return this.bootstrapResponse(
						context,
						selection,
						confirmedEntitlement,
						access.lifecycle
					);
				}
				await this.reconcileAccessProfile(
					selection.workspaceId,
					confirmedEntitlement.entitlement,
					access
				);
				const reconciledLifecycle = await this.completeOnboarding(
					selection.workspaceId,
					installed.installation
				);
				return this.bootstrapResponse(
					context,
					selection,
					confirmedEntitlement,
					reconciledLifecycle
				);
			}
		}
		return this.bootstrapResponse(
			context,
			selection,
			entitlement,
			access?.lifecycle || null
		);
	}

	async installTemplate(
		authorization: string | undefined,
		dto: InstallCrmPipelineTemplateDto
	) {
		const correlationId = getCrmAccessCorrelationId();
		const context = await this.identity.authContext(
			authorization,
			correlationId
		);
		const membership = this.requireMembership(context, dto.workspaceId);
		if (membership.role !== 'OWNER') {
			throw new ForbiddenException(
				'Only the workspace owner can complete WinCRM onboarding'
			);
		}

		const [entitlement, storedAccess] = await Promise.all([
			this.billing.get(dto.workspaceId, correlationId),
			this.prisma.crmWorkspaceAccess.findUnique({
				where: { workspaceId: dto.workspaceId },
				select: CRM_ACCESS_PROFILE_SELECT
			})
		]);
		if (entitlement.status !== 'ACTIVE') {
			throw new ForbiddenException(
				'An active WinCRM entitlement is required'
			);
		}
		const currentAccess = await this.reconcileAccessProfile(
			dto.workspaceId,
			entitlement.entitlement,
			storedAccess
		);
		if (
			currentAccess.lifecycle !== CrmAccessLifecycle.ONBOARDING &&
			currentAccess.lifecycle !== CrmAccessLifecycle.ACTIVE
		) {
			throw new ForbiddenException(
				'WinCRM workspace is not writable in its current state'
			);
		}
		if (
			currentAccess.lifecycle === CrmAccessLifecycle.ACTIVE &&
			(currentAccess.onboardingTemplateKey !== dto.templateKey ||
				currentAccess.onboardingTemplateVersion !== dto.templateVersion)
		) {
			throw new ConflictException(
				'WinCRM onboarding is already completed'
			);
		}

		const installed = await this.sales.installTemplate(
			{
				schemaVersion: 1,
				commandId: dto.commandId,
				workspaceId: dto.workspaceId,
				templateKey: dto.templateKey,
				templateVersion: dto.templateVersion,
				installedBySubject: context.subject
			},
			correlationId
		);
		const confirmedEntitlement = await this.billing.get(
			dto.workspaceId,
			correlationId
		);
		if (confirmedEntitlement.status !== 'ACTIVE') {
			throw new ForbiddenException(
				'WinCRM entitlement changed during onboarding'
			);
		}
		await this.reconcileAccessProfile(
			dto.workspaceId,
			confirmedEntitlement.entitlement,
			currentAccess
		);
		const completedLifecycle = await this.completeOnboarding(
			dto.workspaceId,
			installed.installation
		);
		if (completedLifecycle !== CrmAccessLifecycle.ACTIVE) {
			throw new ConflictException(
				'WinCRM access state changed while onboarding was completing'
			);
		}

		return {
			schemaVersion: 1 as const,
			installation: {
				commandId: dto.commandId,
				workspaceId: installed.installation.workspaceId,
				pipelineId: installed.installation.pipelineId,
				templateKey: installed.installation.templateKey,
				templateVersion: installed.installation.templateVersion,
				templateFingerprint: installed.installation.templateFingerprint
			},
			access: this.bootstrapResponse(
				context,
				membership,
				confirmedEntitlement,
				CrmAccessLifecycle.ACTIVE
			)
		};
	}

	private async completeOnboarding(
		workspaceId: string,
		installation: CrmSalesPipelineInstallation
	): Promise<CrmAccessLifecycle> {
		const completion = {
			lifecycle: CrmAccessLifecycle.ACTIVE,
			onboardingCommandId: installation.initialCommandId,
			onboardingTemplateKey: installation.templateKey,
			onboardingTemplateVersion: installation.templateVersion,
			onboardingTemplateFingerprint: installation.templateFingerprint,
			onboardingPipelineId: installation.pipelineId,
			onboardingCompletedAt: new Date()
		};
		const updated = await this.prisma.crmWorkspaceAccess.updateMany({
			where: {
				workspaceId,
				lifecycle: CrmAccessLifecycle.ONBOARDING
			},
			data: completion
		});
		if (updated.count === 1) return CrmAccessLifecycle.ACTIVE;

		const current = await this.prisma.crmWorkspaceAccess.findUnique({
			where: { workspaceId },
			select: {
				lifecycle: true,
				onboardingCommandId: true,
				onboardingTemplateKey: true,
				onboardingTemplateVersion: true,
				onboardingTemplateFingerprint: true,
				onboardingPipelineId: true
			}
		});
		if (current?.lifecycle === CrmAccessLifecycle.ACTIVE) {
			if (
				current.onboardingCommandId === installation.initialCommandId &&
				current.onboardingTemplateKey === installation.templateKey &&
				current.onboardingTemplateVersion ===
					installation.templateVersion &&
				current.onboardingTemplateFingerprint ===
					installation.templateFingerprint &&
				current.onboardingPipelineId === installation.pipelineId
			) {
				return CrmAccessLifecycle.ACTIVE;
			}
			throw new ConflictException(
				'WinCRM access state conflicts with the installed pipeline'
			);
		}
		if (current) return current.lifecycle;
		throw new ConflictException(
			'WinCRM onboarding access profile is missing'
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
		const access = await this.reconcileAccessProfile(
			dto.workspaceId,
			entitlement.entitlement,
			null
		);

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

	private async reconcileAccessProfile(
		workspaceId: string,
		entitlement: CrmEntitlementDetails | null,
		storedAccess: CrmAccessProfile | null
	): Promise<CrmAccessProfile> {
		if (!entitlement || entitlement.workspaceId !== workspaceId) {
			throw new ServiceUnavailableException(
				'Billing service returned incomplete WinCRM provisioning data'
			);
		}

		let access = storedAccess;
		if (!access) {
			try {
				access = await this.prisma.crmWorkspaceAccess.upsert({
					where: { workspaceId },
					create: {
						workspaceId,
						lifecycle: CrmAccessLifecycle.ONBOARDING,
						billingEntitlementId: entitlement.id,
						provisioningCommandId: entitlement.provisioningCommandId,
						provisioningCommandType: entitlement.provisioningCommandType,
						activatedBySubject: entitlement.activatedByUserId
					},
					update: {},
					select: CRM_ACCESS_PROFILE_SELECT
				});
			} catch {
				try {
					access = await this.prisma.crmWorkspaceAccess.findUnique({
						where: { workspaceId },
						select: CRM_ACCESS_PROFILE_SELECT
					});
				} catch {
					throw new ServiceUnavailableException(
						'WinCRM access provisioning state is unavailable'
					);
				}
			}
		}

		if (!access) {
			throw new ServiceUnavailableException(
				'WinCRM access provisioning state is unavailable'
			);
		}
		if (
			access.billingEntitlementId !== entitlement.id ||
			access.provisioningCommandId !== entitlement.provisioningCommandId ||
			access.provisioningCommandType !==
				entitlement.provisioningCommandType ||
			access.activatedBySubject !== entitlement.activatedByUserId
		) {
			throw new ServiceUnavailableException(
				'WinCRM access provisioning state is inconsistent'
			);
		}
		return access;
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
			entitlement: this.publicEntitlement(entitlement.entitlement),
			access: lifecycle ? { lifecycle } : null
		};
	}

	private publicEntitlement(entitlement: CrmEntitlementDetails | null) {
		if (!entitlement) return null;
		return {
			id: entitlement.id,
			workspaceId: entitlement.workspaceId,
			planCode: entitlement.planCode,
			seatLimit: entitlement.seatLimit,
			trialStartedAt: entitlement.trialStartedAt,
			effectiveFrom: entitlement.effectiveFrom,
			effectiveUntil: entitlement.effectiveUntil,
			aggregateVersion: entitlement.aggregateVersion,
			sourceSequence: entitlement.sourceSequence
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
