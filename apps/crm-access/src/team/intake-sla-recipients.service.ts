import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { IdentityInvitationClient } from '../internal/identity-invitation.client';
import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';
import { IntakeSlaAuthorityService } from './intake-sla-authority.service';

interface Binding {
	subject: string;
	membershipId: string | null;
}
export interface IntakeSlaRecipientsRequest {
	schemaVersion: 1;
	purpose: 'INTAKE_SLA';
	workspaceId: string;
	ruleOwnerBinding: Binding;
	entry: { id: string; createdBySubject: string; teamId: string | null };
	responsibleBinding: Binding | null;
	notifyManagers: boolean;
	recipientBinding: Binding | null;
	cursor: string | null;
}
const same = (a: Binding, b: Binding) =>
	a.subject === b.subject && a.membershipId === b.membershipId;
export function parseIntakeSlaRecipients(
	value: unknown
): IntakeSlaRecipientsRequest {
	const nullable = (item: unknown) => item === null || isUuidV4(item);
	const subject = (item: unknown) =>
		typeof item === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(item);
	const binding = (item: unknown) =>
		isRecord(item) &&
		hasExactKeys(item, ['subject', 'membershipId']) &&
		subject(item.subject) &&
		nullable(item.membershipId);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'purpose',
			'workspaceId',
			'ruleOwnerBinding',
			'entry',
			'responsibleBinding',
			'notifyManagers',
			'recipientBinding',
			'cursor'
		]) ||
		value.schemaVersion !== 1 ||
		value.purpose !== 'INTAKE_SLA' ||
		!isUuidV4(value.workspaceId) ||
		!binding(value.ruleOwnerBinding) ||
		!isRecord(value.entry) ||
		!hasExactKeys(value.entry, ['id', 'createdBySubject', 'teamId']) ||
		!isUuidV4(value.entry.id) ||
		!subject(value.entry.createdBySubject) ||
		!nullable(value.entry.teamId) ||
		!(
			value.responsibleBinding === null ||
			binding(value.responsibleBinding)
		) ||
		typeof value.notifyManagers !== 'boolean' ||
		!(
			value.recipientBinding === null || binding(value.recipientBinding)
		) ||
		!nullable(value.cursor) ||
		(value.recipientBinding !== null && value.cursor !== null)
	)
		throw new BadRequestException('Invalid Intake SLA recipient request');
	return value as unknown as IntakeSlaRecipientsRequest;
}
const include = {
	teams: {
		where: { team: { archivedAt: null } },
		select: { teamId: true },
		orderBy: { teamId: 'asc' as const }
	}
};

@Injectable()
export class IntakeSlaRecipientsService {
	constructor(
		private readonly authority: IntakeSlaAuthorityService,
		private readonly prisma: CrmAccessPrismaService,
		private readonly identity: IdentityInvitationClient
	) {}
	async recipients(input: IntakeSlaRecipientsRequest) {
		const denied = () => ({
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			allowed: false,
			items: [],
			nextCursor: null
		});
		const ownerRequest = {
			schemaVersion: 1 as const,
			purpose: 'INTAKE_SLA' as const,
			workspaceId: input.workspaceId,
			actorSubject: input.ruleOwnerBinding.subject,
			expectedBinding: input.ruleOwnerBinding
		};
		const owner = await this.authority.authorize(ownerRequest);
		if (!owner.allowed) return denied();
		const selected = input.recipientBinding
			? [input.recipientBinding]
			: !input.notifyManagers && input.responsibleBinding
				? [input.responsibleBinding]
				: null;
		if (!input.notifyManagers && input.responsibleBinding === null)
			return { ...denied(), allowed: true };
		const includeOwner =
			input.cursor === null &&
			(!selected || selected.some(item => item.membershipId === null));
		const limit = includeOwner ? 99 : 100;
		const rows = await this.prisma.crmWorkspaceMember.findMany({
			where: {
				workspaceId: input.workspaceId,
				disabledAt: null,
				...(input.cursor ? { id: { gt: input.cursor } } : {}),
				...(selected
					? {
							OR: selected
								.filter(item => item.membershipId !== null)
								.map(item => ({
									subject: item.subject,
									membershipId: item.membershipId!
								}))
						}
					: {})
			},
			include,
			orderBy: { id: 'asc' },
			take: limit + 1
		});
		const page = rows.slice(0, limit),
			expected = page.map(item => ({
				subject: item.subject,
				membershipId: item.membershipId
			}));
		const directory = await this.identity.reminderDirectory(
			input.workspaceId,
			expected,
			includeOwner
		);
		const local = new Map(page.map(item => [item.subject, item]));
		const items = directory.flatMap(item => {
			const member = local.get(item.subject),
				isOwner = item.workspaceRole === 'OWNER';
			if (
				!isOwner &&
				(!member || member.membershipId !== item.membershipId)
			)
				return [];
			const current = {
				subject: item.subject,
				membershipId: isOwner ? null : item.membershipId
			};
			if (selected && !selected.some(item => same(item, current)))
				return [];
			const role = isOwner ? 'OWNER' : member!.role,
				teams = member?.teams.map(item => item.teamId) ?? [];
			const all = role === 'OWNER' || role === 'CRM_ADMIN';
			const teamLead =
				role === 'TEAM_LEAD' &&
				input.entry.teamId !== null &&
				teams.includes(input.entry.teamId);
			// Preserve actual Inbox visibility: assignee metadata grants no extra access.
			if (
				role === 'ANALYST' ||
				!(
					all ||
					teamLead ||
					input.entry.createdBySubject === current.subject
				)
			)
				return [];
			if (
				!(
					input.responsibleBinding &&
					same(input.responsibleBinding, current)
				) &&
				!(input.notifyManagers && (all || teamLead))
			)
				return [];
			return [
				{
					binding: current,
					email: item.email,
					telegramChatId: item.telegramChatId
				}
			];
		});
		const freshOwner = await this.authority.authorize(ownerRequest);
		if (!freshOwner.allowed) return denied();
		const fresh = await this.prisma.crmWorkspaceMember.findMany({
			where: {
				workspaceId: input.workspaceId,
				disabledAt: null,
				id: { in: page.map(item => item.id) }
			},
			include,
			orderBy: { id: 'asc' }
		});
		const freshDirectory = await this.identity.reminderDirectory(
			input.workspaceId,
			expected,
			includeOwner
		);
		if (
			!isDeepStrictEqual(owner, freshOwner) ||
			!isDeepStrictEqual(page, fresh) ||
			!isDeepStrictEqual(directory, freshDirectory)
		)
			throw new ServiceUnavailableException(
				'Intake SLA recipient authority changed; retry'
			);
		return {
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			allowed: true,
			items,
			nextCursor: rows.length > limit ? page[page.length - 1].id : null
		};
	}
}
