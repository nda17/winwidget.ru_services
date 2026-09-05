import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	type CrmInvitationIntent,
	type CrmTeamDelivery,
	type CrmTeam,
	type CrmWorkspaceMember
} from '@prisma/crm-access-client';
import { randomUUID } from 'node:crypto';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { BillingEntitlementClient } from '../internal/billing-entitlement.client';
import { IdentityInvitationClient } from '../internal/identity-invitation.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import type {
	ChangeRoleDto,
	CreateInvitationDto,
	CreateTeamDto,
	SetMemberTeamsDto,
	TeamQueryDto,
	UpdateTeamDto,
	VersionedTeamCommandDto
} from './team.dto';
import {
	auditTeam,
	command,
	emitTeamEvent,
	queueTeamDelivery,
	type TeamAuthority
} from './team.util';
import { parseTeamEvent, teamRoute } from './team-messaging.contract';
import type { TeamConsumer } from './team.util';

const teamsInclude = {
	teams: {
		where: { team: { archivedAt: null } },
		select: { teamId: true },
		orderBy: { teamId: 'asc' as const }
	}
};
export const deliveryDto = (item: CrmTeamDelivery) => ({
	id: item.id,
	workspaceId: item.workspaceId,
	eventId: item.eventId,
	consumer: item.consumer,
	status: item.status,
	version: item.version,
	retryAttempt: item.retryAttempt,
	manualRetryCycle: item.manualRetryCycle,
	lastError: item.lastError,
	createdAt: item.createdAt.toISOString(),
	updatedAt: item.updatedAt.toISOString()
});
type MemberWithTeams = CrmWorkspaceMember & {
	teams: { teamId: string }[];
};

@Injectable()
export class CrmTeamService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly auth: CrmAuthorizationService,
		private readonly billing: BillingEntitlementClient,
		private readonly identity: IdentityInvitationClient
	) {}

	async members(authorization: string | undefined, query: TeamQueryDto) {
		const actor = await this.authority(
			authorization,
			query.workspaceId,
			'read'
		);
		const billing = await this.billing.get(
			query.workspaceId,
			getCrmAccessCorrelationId()
		);
		const limit = billing.entitlement?.seatLimit;
		if (
			!Number.isSafeInteger(limit) ||
			Number(limit) < 2 ||
			Number(limit) > 10000
		)
			throw new ServiceUnavailableException(
				'CRM seat policy is not available'
			);
		const where = { workspaceId: query.workspaceId };
		const [items, total, enabled, waiting, workspace] =
			await this.prisma.$transaction([
				this.prisma.crmWorkspaceMember.findMany({
					where,
					include: teamsInclude,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
				}),
				this.prisma.crmWorkspaceMember.count({ where }),
				this.prisma.crmWorkspaceMember.count({
					where: { ...where, disabledAt: null }
				}),
				this.prisma.crmAdmission.count({
					where: { ...where, status: 'WAITING' }
				}),
				this.prisma.crmWorkspaceAccess.findUniqueOrThrow({
					where: { workspaceId: actor.workspaceId }
				})
			]);
		const directory = await this.identity.directory(
			query.workspaceId,
			items
		);
		const profiles = new Map(
			directory.map(item => [item.membershipId, item])
		);
		return {
			schemaVersion: 1,
			workspaceId: actor.workspaceId,
			ownerSubject: workspace.activatedBySubject,
			quota: {
				seatLimit: limit,
				usedSeats: 1 + enabled,
				waitingCount: waiting
			},
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: items.map(item => ({
				...memberDto(item),
				displayName: profiles.get(item.membershipId)!.displayName,
				verifiedEmail: profiles.get(item.membershipId)!.verifiedEmail
			}))
		};
	}

	async teams(authorization: string | undefined, query: TeamQueryDto) {
		await this.authority(authorization, query.workspaceId, 'read');
		const where = { workspaceId: query.workspaceId, archivedAt: null };
		const [items, total] = await this.prisma.$transaction([
			this.prisma.crmTeam.findMany({
				where,
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
				orderBy: [{ name: 'asc' }, { id: 'asc' }]
			}),
			this.prisma.crmTeam.count({ where })
		]);
		return {
			schemaVersion: 1,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: items.map(teamDto)
		};
	}
	async deliveries(
		authorization: string | undefined,
		query: TeamQueryDto
	) {
		await this.authority(authorization, query.workspaceId, 'read');
		const where = {
			workspaceId: query.workspaceId,
			status: { in: ['RETRY_SCHEDULED', 'DEAD_LETTERED'] }
		};
		const [items, total] = await this.prisma.$transaction([
			this.prisma.crmTeamDelivery.findMany({
				where,
				orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize
			}),
			this.prisma.crmTeamDelivery.count({ where })
		]);
		return {
			schemaVersion: 1,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: items.map(deliveryDto)
		};
	}
	async retryDelivery(
		authorization: string | undefined,
		id: string,
		dto: VersionedTeamCommandDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'delivery.retry',
			{ id, ...dto },
			async tx => {
				const receipt = await tx.crmTeamDelivery.findFirst({
					where: { id, workspaceId: dto.workspaceId }
				});
				if (!receipt)
					throw new NotFoundException('Team delivery not found');
				if (
					receipt.version !== dto.expectedVersion ||
					receipt.status !== 'DEAD_LETTERED'
				)
					throw new ConflictException(
						'Team delivery version or status changed'
					);
				try {
					parseTeamEvent(
						receipt.payload,
						receipt.consumer as TeamConsumer
					);
				} catch {
					throw new ConflictException(
						'Invalid envelope cannot be retried'
					);
				}
				const token = randomUUID();
				const updated = await tx.crmTeamDelivery.update({
					where: { id },
					data: {
						status: 'RETRY_SCHEDULED',
						leaseToken: token,
						leaseExpiresAt: null,
						retryAttempt: 0,
						manualRetryCycle: { increment: 1 },
						version: { increment: 1 },
						lastError: null
					}
				});
				await queueTeamDelivery(tx, updated, {
					deduplicationKey: `manual:${dto.commandId}`,
					exchange: 'winwidget.manual-retry',
					routingKey: teamRoute(updated.consumer as TeamConsumer),
					token
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'DELIVERY_RETRY_REQUESTED',
					id,
					{ status: receipt.status },
					{ status: updated.status }
				);
				return { schemaVersion: 1, delivery: deliveryDto(updated) };
			}
		);
	}

	async invitations(
		authorization: string | undefined,
		query: TeamQueryDto
	) {
		await this.authority(authorization, query.workspaceId, 'read');
		const where = { workspaceId: query.workspaceId };
		const [items, total] = await this.prisma.$transaction([
			this.prisma.crmInvitationIntent.findMany({
				where,
				skip: (query.page - 1) * query.pageSize,
				take: query.pageSize,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
			}),
			this.prisma.crmInvitationIntent.count({ where })
		]);
		return {
			schemaVersion: 1,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: items.map(invitationDto)
		};
	}

	async createTeam(authorization: string | undefined, dto: CreateTeamDto) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		const name = this.name(dto.name);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'team.create',
			{ ...dto, name },
			async tx => {
				await this.uniqueTeamName(tx, dto.workspaceId, name);
				const team = await tx.crmTeam.create({
					data: { workspaceId: dto.workspaceId, name }
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'TEAM_CREATED',
					team.id,
					null,
					{ name }
				);
				return { schemaVersion: 1, team: teamDto(team) };
			}
		);
	}

	async updateTeam(
		authorization: string | undefined,
		id: string,
		dto: UpdateTeamDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		const name = this.name(dto.name);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'team.rename',
			{ id, ...dto, name },
			async tx => {
				const current = await this.team(tx, id, dto.workspaceId);
				if (current.version !== dto.expectedVersion)
					throw new ConflictException('Team version conflict');
				await this.uniqueTeamName(tx, dto.workspaceId, name, id);
				const updated = await tx.crmTeam.update({
					where: { id },
					data: { name, version: { increment: 1 } }
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'TEAM_RENAMED',
					id,
					{ name: current.name },
					{ name }
				);
				return { schemaVersion: 1, team: teamDto(updated) };
			}
		);
	}

	async archiveTeam(
		authorization: string | undefined,
		id: string,
		dto: VersionedTeamCommandDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'team.archive',
			{ id, ...dto },
			async tx => {
				const current = await this.team(tx, id, dto.workspaceId);
				if (current.version !== dto.expectedVersion)
					throw new ConflictException('Team version conflict');
				if (
					await tx.crmMemberTeam.count({
						where: { teamId: id, workspaceId: dto.workspaceId }
					})
				)
					throw new ConflictException(
						'Remove member assignments before archiving a team'
					);
				const updated = await tx.crmTeam.update({
					where: { id },
					data: { archivedAt: new Date(), version: { increment: 1 } }
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'TEAM_ARCHIVED',
					id,
					{ archived: false },
					{ archived: true }
				);
				return { schemaVersion: 1, team: teamDto(updated) };
			}
		);
	}

	async invite(
		authorization: string | undefined,
		dto: CreateInvitationDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		this.manageRole(actor, dto.role);
		const email = dto.email.trim().toLowerCase();
		const teamIds = [...dto.teamIds].sort();
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'invitation.create',
			{ ...dto, email, teamIds },
			async tx => {
				await this.requireTeams(tx, dto.workspaceId, teamIds);
				const now = new Date();
				await tx.crmInvitationIntent.updateMany({
					where: {
						workspaceId: dto.workspaceId,
						email,
						status: { in: ['REGISTERING', 'INVITED'] },
						expiresAt: { lte: now }
					},
					data: { status: 'EXPIRED', version: { increment: 1 } }
				});
				if (
					await tx.crmInvitationIntent.findFirst({
						where: {
							workspaceId: dto.workspaceId,
							email,
							status: { in: ['REGISTERING', 'INVITED'] }
						}
					})
				)
					throw new ConflictException(
						'An active invitation for this email already exists'
					);
				const invitation = await tx.crmInvitationIntent.create({
					data: {
						workspaceId: dto.workspaceId,
						email,
						role: dto.role,
						teamIds,
						inviterSubject: actor.subject,
						expiresAt: new Date(now.getTime() + dto.ttlDays * 86400000),
						createdAt: now,
						provisioningCommandId: randomUUID()
					}
				});
				await emitTeamEvent(
					tx,
					'provision',
					dto.workspaceId,
					dto.commandId,
					invitation.id
				);
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'INVITATION_CREATED',
					invitation.id,
					null,
					{ role: dto.role, teamIds }
				);
				return { schemaVersion: 1, invitation: invitationDto(invitation) };
			}
		);
	}

	async revokeInvitation(
		authorization: string | undefined,
		id: string,
		dto: VersionedTeamCommandDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'revoke'
		);
		const preview = await this.prisma.crmInvitationIntent.findFirst({
			where: { id, workspaceId: dto.workspaceId }
		});
		if (!preview) throw new NotFoundException('Invitation not found');
		this.manageRole(actor, preview.role);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'invitation.revoke',
			{ id, ...dto },
			async tx => {
				const current = await tx.crmInvitationIntent.findFirstOrThrow({
					where: { id, workspaceId: dto.workspaceId }
				});
				this.manageRole(actor, current.role);
				if (current.version !== dto.expectedVersion)
					throw new ConflictException('Invitation version conflict');
				const admission = await tx.crmAdmission.findUnique({
					where: { intentId: id }
				});
				if (admission?.status === 'ACTIVE')
					throw new ConflictException(
						'Disable the active CRM member instead'
					);
				if (current.status === 'REVOKED')
					throw new ConflictException('Invitation is already revoked');
				const updated = await tx.crmInvitationIntent.update({
					where: { id },
					data: {
						status: 'REVOKED',
						revokedAt: new Date(),
						revokeCommandId: randomUUID(),
						version: { increment: 1 }
					}
				});
				await tx.crmAdmission.updateMany({
					where: { intentId: id, status: 'WAITING' },
					data: {
						status: 'CANCELLED',
						cancellationCode: 'INVITATION_REVOKED'
					}
				});
				await emitTeamEvent(
					tx,
					'provision',
					dto.workspaceId,
					dto.commandId,
					id
				);
				await emitTeamEvent(
					tx,
					'admission',
					dto.workspaceId,
					dto.commandId
				);
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'INVITATION_REVOKED',
					id,
					{ status: current.status },
					{ status: 'REVOKED' }
				);
				return { schemaVersion: 1, invitation: invitationDto(updated) };
			}
		);
	}

	async changeRole(
		authorization: string | undefined,
		id: string,
		dto: ChangeRoleDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		this.manageRole(actor, dto.role);
		await this.target(this.prisma, actor, id);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'member.role',
			{ id, ...dto },
			async tx => {
				const current = await this.target(
					tx,
					actor,
					id,
					dto.expectedVersion
				);
				const updated = await tx.crmWorkspaceMember.update({
					where: { id },
					data: { role: dto.role, version: { increment: 1 } },
					include: teamsInclude
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'MEMBER_ROLE_CHANGED',
					id,
					{ role: current.role },
					{ role: dto.role }
				);
				return { schemaVersion: 1, member: memberDto(updated) };
			}
		);
	}

	async setTeams(
		authorization: string | undefined,
		id: string,
		dto: SetMemberTeamsDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		await this.target(this.prisma, actor, id);
		const teamIds = [...dto.teamIds].sort();
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'member.teams',
			{ id, ...dto, teamIds },
			async tx => {
				const current = await this.target(
					tx,
					actor,
					id,
					dto.expectedVersion
				);
				await this.requireTeams(tx, dto.workspaceId, teamIds);
				await tx.crmMemberTeam.deleteMany({
					where: { memberId: id, workspaceId: dto.workspaceId }
				});
				if (teamIds.length)
					await tx.crmMemberTeam.createMany({
						data: teamIds.map(teamId => ({
							memberId: id,
							workspaceId: dto.workspaceId,
							teamId
						}))
					});
				const updated = await tx.crmWorkspaceMember.update({
					where: { id },
					data: { version: { increment: 1 } },
					include: teamsInclude
				});
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'MEMBER_TEAMS_CHANGED',
					id,
					{ teamIds: current.teams.map(item => item.teamId) },
					{ teamIds }
				);
				return { schemaVersion: 1, member: memberDto(updated) };
			}
		);
	}

	async disable(
		authorization: string | undefined,
		id: string,
		dto: VersionedTeamCommandDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'revoke'
		);
		await this.target(this.prisma, actor, id);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'member.disable',
			{ id, ...dto },
			async tx => {
				const current = await this.target(
					tx,
					actor,
					id,
					dto.expectedVersion
				);
				const updated = await tx.crmWorkspaceMember.update({
					where: { id },
					data: { disabledAt: new Date(), version: { increment: 1 } },
					include: teamsInclude
				});
				await tx.crmAdmission.updateMany({
					where: {
						workspaceId: dto.workspaceId,
						subject: current.subject,
						status: 'WAITING'
					},
					data: {
						status: 'CANCELLED',
						cancellationCode: 'MEMBER_DISABLED'
					}
				});
				await emitTeamEvent(
					tx,
					'admission',
					dto.workspaceId,
					dto.commandId
				);
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'MEMBER_DISABLED',
					id,
					{ disabled: !!current.disabledAt },
					{ disabled: true }
				);
				return { schemaVersion: 1, member: memberDto(updated) };
			}
		);
	}

	async enable(
		authorization: string | undefined,
		id: string,
		dto: VersionedTeamCommandDto
	) {
		const actor = await this.authority(
			authorization,
			dto.workspaceId,
			'manage'
		);
		await this.target(this.prisma, actor, id);
		return command(
			this.prisma,
			actor,
			dto.commandId,
			'member.enable',
			{ id, ...dto },
			async tx => {
				const current = await this.target(
					tx,
					actor,
					id,
					dto.expectedVersion
				);
				if (!current.disabledAt)
					throw new ConflictException('CRM member is already enabled');
				if (
					await tx.crmAdmission.findFirst({
						where: {
							workspaceId: dto.workspaceId,
							subject: current.subject,
							status: 'WAITING'
						}
					})
				)
					throw new ConflictException('An admission is already waiting');
				const admission = await tx.crmAdmission.create({
					data: {
						workspaceId: dto.workspaceId,
						memberId: id,
						expectedMemberVersion: current.version,
						subject: current.subject,
						membershipId: current.membershipId,
						requestedBySubject: actor.subject
					}
				});
				await emitTeamEvent(
					tx,
					'admission',
					dto.workspaceId,
					dto.commandId
				);
				await auditTeam(
					tx,
					actor,
					dto.commandId,
					'MEMBER_ENABLE_REQUESTED',
					id,
					{ disabled: true },
					{ admissionId: admission.id, status: 'WAITING' }
				);
				return {
					schemaVersion: 1,
					admission: {
						id: admission.id,
						workspaceId: admission.workspaceId,
						memberId: id,
						status: admission.status,
						createdAt: admission.createdAt.toISOString()
					}
				};
			}
		);
	}

	async authority(
		authorization: string | undefined,
		workspaceId: string,
		mode: 'read' | 'manage' | 'revoke'
	): Promise<TeamAuthority> {
		const actor = await this.auth.authorize(authorization, workspaceId);
		const permission =
			mode === 'read'
				? 'access:read-team'
				: mode === 'revoke'
					? 'access:revoke-access'
					: 'access:manage-team';
		if (
			!['OWNER', 'CRM_ADMIN'].includes(actor.role) ||
			!actor.permissions.includes(permission) ||
			(mode !== 'read' && actor.state === 'READ_ONLY')
		)
			throw new ForbiddenException('CRM team action is not permitted');
		return actor;
	}
	manageRole(actor: TeamAuthority, role: string) {
		if (
			role === 'OWNER' ||
			(actor.role !== 'OWNER' && role === 'CRM_ADMIN')
		)
			throw new ForbiddenException(
				'Only the owner can manage CRM administrators'
			);
	}
	async requireTeams(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		teamIds: string[]
	) {
		if (
			new Set(teamIds).size !== teamIds.length ||
			teamIds.length > 1000 ||
			(await tx.crmTeam.count({
				where: { id: { in: teamIds }, workspaceId, archivedAt: null }
			})) !== teamIds.length
		)
			throw new BadRequestException(
				'Team assignments must belong to the active workspace'
			);
	}
	private async target(
		tx: Prisma.TransactionClient,
		actor: TeamAuthority,
		id: string,
		expectedVersion?: number
	) {
		const member = await tx.crmWorkspaceMember.findFirst({
			where: { id, workspaceId: actor.workspaceId },
			include: teamsInclude
		});
		if (!member) throw new NotFoundException('CRM member not found');
		const workspace = await tx.crmWorkspaceAccess.findUniqueOrThrow({
			where: { workspaceId: actor.workspaceId }
		});
		if (
			member.subject === workspace.activatedBySubject ||
			member.subject === actor.subject
		)
			throw new ForbiddenException(
				'The owner and current actor cannot be modified through this action'
			);
		this.manageRole(actor, member.role);
		if (
			expectedVersion !== undefined &&
			member.version !== expectedVersion
		)
			throw new ConflictException('CRM member version conflict');
		return member;
	}
	private name(value: string) {
		const name = value.trim();
		if (!name || name.length > 100)
			throw new BadRequestException('Invalid team name');
		return name;
	}
	private async uniqueTeamName(
		tx: Prisma.TransactionClient,
		workspaceId: string,
		name: string,
		id?: string
	) {
		if (
			await tx.crmTeam.findFirst({
				where: {
					workspaceId,
					name: { equals: name, mode: 'insensitive' },
					archivedAt: null,
					...(id ? { id: { not: id } } : {})
				}
			})
		)
			throw new ConflictException(
				'An active team with this name already exists'
			);
	}
	private async team(
		tx: Prisma.TransactionClient,
		id: string,
		workspaceId: string
	) {
		const team = await tx.crmTeam.findFirst({
			where: { id, workspaceId, archivedAt: null }
		});
		if (!team) throw new NotFoundException('Team not found');
		return team;
	}
}

export const memberDto = (member: MemberWithTeams) => ({
	id: member.id,
	workspaceId: member.workspaceId,
	subject: member.subject,
	membershipId: member.membershipId,
	role: member.role,
	teamIds: member.teams.map(item => item.teamId),
	disabledAt: member.disabledAt?.toISOString() ?? null,
	version: member.version,
	createdAt: member.createdAt.toISOString(),
	updatedAt: member.updatedAt.toISOString()
});
export const teamDto = (team: CrmTeam) => ({
	id: team.id,
	workspaceId: team.workspaceId,
	name: team.name,
	version: team.version,
	archivedAt: team.archivedAt?.toISOString() ?? null,
	createdAt: team.createdAt.toISOString(),
	updatedAt: team.updatedAt.toISOString()
});
export const invitationDto = (invitation: CrmInvitationIntent) => ({
	id: invitation.id,
	workspaceId: invitation.workspaceId,
	email: invitation.email,
	role: invitation.role,
	teamIds: invitation.teamIds,
	status:
		['REGISTERING', 'INVITED'].includes(invitation.status) &&
		invitation.expiresAt <= new Date()
			? 'EXPIRED'
			: invitation.status,
	version: invitation.version,
	expiresAt: invitation.expiresAt.toISOString(),
	createdAt: invitation.createdAt.toISOString(),
	updatedAt: invitation.updatedAt.toISOString()
});
