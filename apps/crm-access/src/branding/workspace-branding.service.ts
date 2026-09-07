import {
	ConflictException,
	ForbiddenException,
	Injectable
} from '@nestjs/common';
import {
	Prisma,
	type CrmWorkspaceBranding
} from '@prisma/crm-access-client';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import {
	auditTeam,
	json,
	semanticHash,
	workspaceLock,
	type TeamAuthority
} from '../team/team.util';
import {
	normalizeWorkspaceDisplayName,
	type UpdateWorkspaceBrandingDto,
	type WorkspaceBrandingQueryDto
} from './workspace-branding.dto';

const COMMAND_TYPE = 'workspace.branding';
const versionConflict = () =>
	new ConflictException({
		code: 'crm_branding_version_conflict',
		message: 'Workspace branding version changed'
	});

@Injectable()
export class CrmWorkspaceBrandingService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly auth: CrmAuthorizationService
	) {}

	async get(token: string | undefined, query: WorkspaceBrandingQueryDto) {
		const actor = await this.auth.authorize(token, query.workspaceId);
		this.checkAuthority(actor, query.workspaceId);
		return this.prisma.$transaction(
			async tx => {
				await this.checkLocalAuthority(tx, actor, false);
				const row = await tx.crmWorkspaceBranding.findUnique({
					where: { workspaceId: actor.workspaceId }
				});
				return this.response(actor, row);
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
	}

	async update(
		token: string | undefined,
		dto: UpdateWorkspaceBrandingDto
	) {
		const displayName = normalizeWorkspaceDisplayName(dto.displayName);
		if (
			typeof dto.expectedActorSubject !== 'string' ||
			!dto.expectedActorSubject
		)
			throw new ForbiddenException(
				'Workspace branding actor binding is required'
			);
		const initial = await this.auth.authorize(token, dto.workspaceId);
		this.checkAuthority(
			initial,
			dto.workspaceId,
			dto.expectedActorSubject
		);
		const requestHash = semanticHash({
			actor: initial.subject,
			workspaceId: dto.workspaceId,
			commandType: COMMAND_TYPE,
			body: { ...dto, displayName }
		});
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
						await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team-command:${dto.commandId}`}, 0))`;
						await workspaceLock(tx, dto.workspaceId);
						// Revalidate after lock acquisition, including receipt replays. Reuse
						// this connection for local reads instead of nesting a pool checkout.
						const actor = await this.auth.authorize(
							token,
							dto.workspaceId,
							undefined,
							tx
						);
						this.checkAuthority(
							actor,
							dto.workspaceId,
							dto.expectedActorSubject
						);
						await this.checkLocalAuthority(tx, actor, true);
						const prior = await tx.crmTeamCommandReceipt.findUnique({
							where: { commandId: dto.commandId }
						});
						if (prior) {
							if (
								prior.workspaceId !== actor.workspaceId ||
								prior.actorSubject !== actor.subject ||
								prior.commandType !== COMMAND_TYPE ||
								prior.requestHash !== requestHash
							)
								throw new ConflictException({
									code: 'crm_branding_command_conflict',
									message: 'Workspace branding command conflict'
								});
							return prior.result as unknown as ReturnType<
								typeof this.commandResponse
							>;
						}
						const where = { workspaceId: actor.workspaceId };
						const current = await tx.crmWorkspaceBranding.findUnique({
							where
						});
						if (
							(current?.version ?? 0) !== dto.expectedVersion ||
							dto.expectedVersion >= 2147483647
						)
							throw versionConflict();
						const updated = current
							? await tx.crmWorkspaceBranding.update({
									where: { ...where, version: dto.expectedVersion },
									data: { displayName, version: { increment: 1 } }
								})
							: await tx.crmWorkspaceBranding.create({
									data: { ...where, displayName }
								});
						// Workspace-local append-only audit; no extra copy of the name,
						// and no claim of delivery to the platform Operations journal.
						await auditTeam(
							tx,
							actor,
							dto.commandId,
							'WORKSPACE_BRANDING_UPDATED',
							actor.workspaceId,
							{ version: current?.version ?? 0 },
							{
								version: updated.version,
								changed: (current?.displayName ?? null) !== displayName
							}
						);
						const result = this.commandResponse(
							actor,
							updated,
							dto.commandId
						);
						await tx.crmTeamCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								workspaceId: actor.workspaceId,
								actorSubject: actor.subject,
								commandType: COMMAND_TYPE,
								requestHash,
								result: json(result)
							}
						});
						return result;
					},
					{
						// Fresh statement snapshots after the workspace lock, plus explicit
						// SQL version CAS and shared command/workspace advisory locks.
						isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
						maxWait: 1000,
						timeout: 15000
					}
				);
			} catch (error) {
				if (error instanceof Prisma.PrismaClientKnownRequestError) {
					if (attempt < 2 && ['P2034', 'P2002'].includes(error.code))
						continue;
					if (['P2002', 'P2025', 'P2034'].includes(error.code))
						throw versionConflict();
				}
				throw error;
			}
		}
	}

	private checkAuthority(
		actor: TeamAuthority,
		workspaceId: string,
		expectedActorSubject?: string
	) {
		if (
			actor.workspaceId !== workspaceId ||
			!['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'].includes(
				actor.role
			) ||
			!['ACTIVE', 'GRACE', 'READ_ONLY'].includes(actor.state) ||
			(expectedActorSubject !== undefined &&
				(actor.subject !== expectedActorSubject ||
					!['OWNER', 'CRM_ADMIN'].includes(actor.role) ||
					actor.state === 'READ_ONLY' ||
					!actor.permissions.includes('access:manage-team')))
		)
			throw new ForbiddenException(
				'Workspace branding access is not permitted'
			);
	}

	private async checkLocalAuthority(
		tx: Prisma.TransactionClient,
		actor: TeamAuthority,
		write: boolean
	) {
		const workspace = await tx.crmWorkspaceAccess.findUnique({
			where: { workspaceId: actor.workspaceId }
		});
		if (
			!workspace?.onboardingCompletedAt ||
			!(write ? ['ACTIVE'] : ['ACTIVE', 'READ_ONLY']).includes(
				workspace.lifecycle
			)
		)
			throw new ForbiddenException('CRM workspace access has changed');
		if (actor.role === 'OWNER') return;
		const member = await tx.crmWorkspaceMember.findUnique({
			where: {
				workspaceId_subject: {
					workspaceId: actor.workspaceId,
					subject: actor.subject
				}
			}
		});
		if (!member || member.disabledAt || member.role !== actor.role)
			throw new ForbiddenException('CRM employee access has changed');
	}

	private response(
		actor: TeamAuthority,
		row: CrmWorkspaceBranding | null
	) {
		return {
			schemaVersion: 1 as const,
			workspaceId: actor.workspaceId,
			subject: actor.subject,
			branding: {
				displayName: row?.displayName ?? null,
				version: row?.version ?? 0,
				updatedAt: row?.updatedAt.toISOString() ?? null
			}
		};
	}

	private commandResponse(
		actor: TeamAuthority,
		row: CrmWorkspaceBranding,
		commandId: string
	) {
		return { ...this.response(actor, row), commandId };
	}
}
