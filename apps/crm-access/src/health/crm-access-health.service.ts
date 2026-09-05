import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmTeamRabbitService } from '../team/team-rabbit.service';
import { CrmTeamOutboxService } from '../team/team-outbox.service';

@Injectable()
export class CrmAccessHealthService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly rabbit: CrmTeamRabbitService,
		private readonly outbox: CrmTeamOutboxService
	) {}

	liveness() {
		return this.status('ok');
	}

	async readiness() {
		try {
			await this.prisma.$queryRaw`SELECT 1`;
			const identity = await this.prisma.serviceIdentity.findUnique({
				where: { id: 'singleton' },
				select: {
					serviceName: true,
					databaseId: true,
					createdAt: true,
					updatedAt: true
				}
			});
			if (
				identity?.serviceName !== 'crm-access-service' ||
				!identity.databaseId
			) {
				throw new Error('Invalid database identity');
			}
			await this.prisma.crmWorkspaceAccess.findFirst({
				select: {
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
				}
			});
			await this.prisma.crmWorkspaceMember.findFirst({
				select: {
					workspaceId: true,
					membershipId: true,
					role: true,
					teams: { select: { teamId: true } },
					disabledAt: true,
					version: true
				}
			});
			await this.prisma
				.$queryRaw`SELECT t.version, i.identity_version, a.position, r.request_hash, h.command_id, o.lease_token, d.version FROM crm_access.crm_teams t FULL JOIN crm_access.crm_invitation_intents i ON false FULL JOIN crm_access.crm_admissions a ON false FULL JOIN crm_access.crm_team_command_receipts r ON false FULL JOIN crm_access.crm_team_audit h ON false FULL JOIN crm_access.crm_team_outbox o ON false FULL JOIN crm_access.crm_team_deliveries d ON false LIMIT 0`;
			if (!this.rabbit.isReady() || !this.outbox.isReady())
				throw new Error('CRM team runtime is not ready');
			return {
				...this.status('ready'),
				database: {
					serviceName: identity.serviceName,
					databaseId: identity.databaseId,
					createdAt: identity.createdAt.toISOString(),
					updatedAt: identity.updatedAt.toISOString()
				}
			};
		} catch {
			throw new ServiceUnavailableException(
				'CRM Access database is not ready'
			);
		}
	}

	private status(status: 'ok' | 'ready') {
		return {
			status,
			service: 'crm-access',
			revision: process.env.APP_REVISION || 'unknown'
		};
	}
}
