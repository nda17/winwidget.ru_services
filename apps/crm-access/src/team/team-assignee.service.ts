import {
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { Prisma } from '@prisma/crm-access-client';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import {
	IdentityInvitationClient,
	type IdentityAssigneeEntry
} from '../internal/identity-invitation.client';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import type {
	AssigneeQueryDto,
	AuthorizeAssigneeDto
} from './team-assignee.dto';
import { employeeDisplayName } from './team-profile.dto';
type AssigneeActor = Awaited<
	ReturnType<CrmAuthorizationService['authorize']>
>;

const candidateSelect = {
	id: true,
	subject: true,
	membershipId: true,
	role: true,
	version: true,
	teams: {
		where: { team: { archivedAt: null } },
		select: { teamId: true },
		orderBy: { teamId: 'asc' as const }
	}
} as const;
const fingerprint = (actor: AssigneeActor) =>
	JSON.stringify({
		workspaceId: actor.workspaceId,
		subject: actor.subject,
		role: actor.role,
		dataScope: actor.dataScope,
		teamIds: [...actor.teamIds].sort(),
		permissions: [...actor.permissions].sort(),
		state: actor.state
	});
const fail = (): never => {
	throw new NotFoundException('Assignable CRM employee is unavailable');
};

@Injectable()
export class CrmAssigneeService {
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly auth: CrmAuthorizationService,
		private readonly identity: IdentityInvitationClient
	) {}

	async options(token: string | undefined, query: AssigneeQueryDto) {
		const actor = await this.auth.authorize(
			token,
			query.workspaceId,
			'crm-sales'
		);
		this.permission(actor, false, query.teamId);
		const where = this.candidateScope(actor, query.teamId);
		const candidates = await this.prisma.crmWorkspaceMember.findMany({
			where,
			select: candidateSelect,
			orderBy: { id: 'asc' },
			take: 10001
		});
		if (candidates.length > 10000)
			throw new ServiceUnavailableException(
				'CRM assignee directory exceeds the seat contract'
			);
		const includeOwner = actor.dataScope === 'ALL';
		const verified: IdentityAssigneeEntry[] = [];
		const directoryDeadline = AbortSignal.timeout(10_000);
		// Bounded service-to-service batches; no full directory reaches the browser.
		// Two simultaneous requests at most, including empty-owner-only workspaces.
		for (
			let offset = 0;
			offset < Math.max(1, candidates.length);
			offset += 2000
		) {
			const batches = [offset, offset + 1000].filter(
				index => index < candidates.length || index === 0
			);
			const results = await Promise.all(
				batches.map(index =>
					this.identity.assignees(
						actor.workspaceId,
						candidates.slice(index, index + 1000),
						includeOwner && index === 0,
						directoryDeadline
					)
				)
			);
			verified.push(...results.flat());
		}
		const fresh = await this.auth.authorize(
			token,
			query.workspaceId,
			'crm-sales'
		);
		this.permission(fresh, false, query.teamId);
		if (fingerprint(fresh) !== fingerprint(actor))
			throw new ForbiddenException('CRM directory authority changed');
		return this.prisma.$transaction(
			async tx => {
				const current = await tx.crmWorkspaceMember.findMany({
					where,
					select: candidateSelect,
					orderBy: { id: 'asc' },
					take: 10001
				});
				if (JSON.stringify(current) !== JSON.stringify(candidates))
					throw new ConflictException('CRM directory membership changed');
				const byBinding = new Map(
					current.map(item => [item.membershipId, item])
				);
				const unique = new Map<string, IdentityAssigneeEntry>();
				for (const item of verified) {
					const prior = unique.get(item.membershipId);
					if (
						prior &&
						(prior.subject !== item.subject ||
							prior.workspaceRole !== 'OWNER' ||
							item.workspaceRole !== 'OWNER' ||
							!includeOwner)
					)
						throw new ServiceUnavailableException(
							'CRM directory bindings are ambiguous'
						);
					unique.set(item.membershipId, item);
				}
				const eligible = [...unique.values()].filter(item =>
					item.workspaceRole === 'OWNER'
						? includeOwner
						: byBinding.get(item.membershipId)?.subject === item.subject
				);
				if (
					new Set(eligible.map(item => item.subject)).size !==
						eligible.length ||
					eligible.filter(item => item.workspaceRole === 'OWNER').length >
						1
				)
					throw new ServiceUnavailableException(
						'CRM directory bindings are ambiguous'
					);
				const profiles = new Map(
					(
						await tx.crmEmployeeProfile.findMany({
							where: {
								workspaceId: actor.workspaceId,
								subject: { in: eligible.map(item => item.subject) }
							}
						})
					).map(profile => [profile.subject, employeeDisplayName(profile)])
				);
				const entries = eligible.map(item => ({
					subject: item.subject,
					membershipId: item.membershipId,
					displayName: profiles.get(item.subject) ?? item.displayName,
					verifiedEmail: item.verifiedEmail,
					role:
						item.workspaceRole === 'OWNER'
							? ('OWNER' as const)
							: byBinding.get(item.membershipId)!.role
				}));
				const tokens = (query.search ?? '')
					.normalize('NFC')
					.trim()
					.toLocaleLowerCase('ru')
					.split(/\s+/u)
					.filter(Boolean);
				const matches = entries.filter(item =>
					tokens.every(token =>
						`${item.displayName ?? ''} ${item.verifiedEmail ?? ''}`
							.normalize('NFC')
							.toLocaleLowerCase('ru')
							.includes(token)
					)
				);
				matches.sort(
					(a, b) =>
						(a.displayName ?? a.verifiedEmail ?? a.subject).localeCompare(
							b.displayName ?? b.verifiedEmail ?? b.subject,
							'ru'
						) || a.membershipId.localeCompare(b.membershipId)
				);
				return {
					schemaVersion: 1 as const,
					workspaceId: actor.workspaceId,
					subject: actor.subject,
					page: query.page,
					pageSize: query.pageSize,
					total: matches.length,
					items: matches.slice(
						(query.page - 1) * query.pageSize,
						query.page * query.pageSize
					),
					selected:
						entries.find(item => item.subject === query.selectedSubject) ??
						null
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}

	async authorize(token: string | undefined, dto: AuthorizeAssigneeDto) {
		const actor = await this.auth.authorize(
			token,
			dto.workspaceId,
			'crm-sales'
		);
		this.permission(actor, true, dto.teamId);
		if (
			dto.purpose !== 'SALES_ASSIGNMENT' ||
			(actor.dataScope === 'OWN' && actor.subject !== dto.subject)
		)
			fail();
		let target: Awaited<
			ReturnType<CrmAuthorizationService['assignmentSubject']>
		>;
		try {
			target = await this.auth.assignmentSubject(
				dto.workspaceId,
				dto.subject
			);
		} catch (error) {
			if (error instanceof ForbiddenException) fail();
			throw error;
		}
		if (
			target.membershipId !== dto.membershipId ||
			target.subject !== dto.subject ||
			target.workspaceId !== actor.workspaceId ||
			target.role === 'ANALYST'
		)
			fail();
		if (
			target.state === 'READ_ONLY' ||
			!target.permissions.includes('sales:write')
		)
			throw new ForbiddenException('CRM assignment is read-only');
		const fresh = await this.auth.authorize(
			token,
			dto.workspaceId,
			'crm-sales'
		);
		this.permission(fresh, true, dto.teamId);
		if (fresh.subject !== actor.subject)
			throw new ForbiddenException('CRM assignment actor changed');
		if (fresh.dataScope === 'OWN' && fresh.subject !== target.subject)
			fail();
		if (target.role === 'OWNER') {
			if (fresh.dataScope !== 'ALL') fail();
		} else if (
			!(await this.prisma.crmWorkspaceMember.findFirst({
				where: {
					AND: [
						this.candidateScope(fresh, dto.teamId),
						{
							subject: target.subject,
							membershipId: target.membershipId,
							role: target.role
						}
					]
				},
				select: { id: true }
			}))
		)
			fail();
		if (
			dto.teamId &&
			target.dataScope !== 'ALL' &&
			!target.teamIds.includes(dto.teamId)
		)
			fail();
		return {
			schemaVersion: 1 as const,
			workspaceId: fresh.workspaceId,
			subject: fresh.subject,
			assignee: {
				subject: target.subject,
				membershipId: target.membershipId,
				role: target.role,
				dataScope: target.dataScope,
				teamIds: target.teamIds
			}
		};
	}

	private permission(
		actor: AssigneeActor,
		write: boolean,
		teamId?: string
	) {
		if (
			actor.role === 'ANALYST' ||
			!actor.permissions.includes(write ? 'sales:write' : 'sales:read') ||
			(write && actor.state === 'READ_ONLY') ||
			(teamId && !actor.teamIds.includes(teamId))
		)
			throw new ForbiddenException('CRM assignee access is not permitted');
	}
	private candidateScope(
		actor: AssigneeActor,
		teamId?: string
	): Prisma.CrmWorkspaceMemberWhereInput {
		return {
			workspaceId: actor.workspaceId,
			disabledAt: null,
			role: { not: 'ANALYST' },
			AND: [
				actor.dataScope === 'OWN'
					? { subject: actor.subject }
					: actor.dataScope === 'TEAM'
						? {
								OR: [
									{ subject: actor.subject },
									{
										teams: {
											some: {
												teamId: { in: actor.teamIds },
												team: { archivedAt: null }
											}
										}
									}
								]
							}
						: {},
				teamId
					? {
							OR: [
								{ role: 'CRM_ADMIN' },
								{ teams: { some: { teamId, team: { archivedAt: null } } } }
							]
						}
					: {}
			]
		};
	}
}
