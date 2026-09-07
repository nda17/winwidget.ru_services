import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { IdentityInvitationClient } from '../internal/identity-invitation.client';
import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';

export interface ReminderRecipientBinding {
	subject: string;
	membershipId: string | null;
}
export interface TaskReminderRecipientsRequest {
	schemaVersion: 1;
	workspaceId: string;
	ruleOwnerBinding: ReminderRecipientBinding;
	scope: 'WORKSPACE' | 'PERSONAL';
	task: {
		id: string;
		assignedToSubject: string;
		assignedToMembershipId: string | null;
		teamId: string | null;
		deal: { assignedToSubject: string; teamId: string | null } | null;
	};
	recipients:
		| { kind: 'SELF' | 'ASSIGNEE' | 'TEAM_LEADS' | 'WORKSPACE' }
		| { kind: 'SELECTED'; bindings: ReminderRecipientBinding[] };
	recipientBinding: ReminderRecipientBinding | null;
	cursor: string | null;
}
const subject = (value: unknown): value is string =>
	typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
const nullableId = (value: unknown) => value === null || isUuidV4(value);
const binding = (value: unknown): value is ReminderRecipientBinding =>
	isRecord(value) &&
	hasExactKeys(value, ['subject', 'membershipId']) &&
	subject(value.subject) &&
	nullableId(value.membershipId);
const equal = (a: ReminderRecipientBinding, b: ReminderRecipientBinding) =>
	a.subject === b.subject && a.membershipId === b.membershipId;
export function parseTaskReminderRecipients(
	value: unknown
): TaskReminderRecipientsRequest {
	const fail = () => {
		throw new BadRequestException('Invalid task reminder request');
	};
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'workspaceId',
			'ruleOwnerBinding',
			'scope',
			'task',
			'recipients',
			'recipientBinding',
			'cursor'
		]) ||
		value.schemaVersion !== 1 ||
		!isUuidV4(value.workspaceId) ||
		!binding(value.ruleOwnerBinding) ||
		!['WORKSPACE', 'PERSONAL'].includes(String(value.scope)) ||
		!nullableId(value.cursor) ||
		!(
			value.recipientBinding === null || binding(value.recipientBinding)
		) ||
		(value.recipientBinding !== null && value.cursor !== null)
	)
		return fail();
	const task = value.task,
		recipients = value.recipients;
	if (
		!isRecord(task) ||
		!hasExactKeys(task, [
			'id',
			'assignedToSubject',
			'assignedToMembershipId',
			'teamId',
			'deal'
		]) ||
		!isUuidV4(task.id) ||
		!subject(task.assignedToSubject) ||
		!nullableId(task.assignedToMembershipId) ||
		!nullableId(task.teamId) ||
		!(
			task.deal === null ||
			(isRecord(task.deal) &&
				hasExactKeys(task.deal, ['assignedToSubject', 'teamId']) &&
				subject(task.deal.assignedToSubject) &&
				nullableId(task.deal.teamId))
		)
	)
		return fail();
	if (!isRecord(recipients)) return fail();
	if (recipients.kind === 'SELECTED') {
		if (
			!hasExactKeys(recipients, ['kind', 'bindings']) ||
			!Array.isArray(recipients.bindings) ||
			recipients.bindings.length < 1 ||
			recipients.bindings.length > 100 ||
			!recipients.bindings.every(binding) ||
			new Set(
				recipients.bindings.map(item =>
					JSON.stringify([item.subject, item.membershipId])
				)
			).size !== recipients.bindings.length
		)
			return fail();
	} else if (
		!hasExactKeys(recipients, ['kind']) ||
		!['SELF', 'ASSIGNEE', 'TEAM_LEADS', 'WORKSPACE'].includes(
			String(recipients.kind)
		)
	)
		return fail();
	if ((value.scope === 'PERSONAL') !== (recipients.kind === 'SELF'))
		return fail();
	return value as unknown as TaskReminderRecipientsRequest;
}
const memberInclude = {
	teams: {
		where: { team: { archivedAt: null } },
		select: { teamId: true },
		orderBy: { teamId: 'asc' as const }
	}
};

@Injectable()
export class TaskReminderRecipientsService {
	constructor(
		private readonly authorization: CrmAuthorizationService,
		private readonly prisma: CrmAccessPrismaService,
		private readonly identity: IdentityInvitationClient
	) {}
	async recipients(input: TaskReminderRecipientsRequest) {
		const denied = () => ({
			schemaVersion: 1 as const,
			workspaceId: input.workspaceId,
			allowed: false,
			items: [],
			nextCursor: null
		});
		const owner = await this.owner(input);
		if (!owner) return denied();
		const assignee = {
			subject: input.task.assignedToSubject,
			membershipId: input.task.assignedToMembershipId
		};
		if (
			input.scope === 'PERSONAL' &&
			!equal(input.ruleOwnerBinding, assignee)
		)
			return denied();
		const selected = input.recipientBinding
			? [input.recipientBinding]
			: input.recipients.kind === 'SELF'
				? [input.ruleOwnerBinding]
				: input.recipients.kind === 'ASSIGNEE'
					? [assignee]
					: input.recipients.kind === 'SELECTED'
						? input.recipients.bindings
						: null;
		const includeOwner =
			input.cursor === null &&
			(selected === null ||
				selected.some(item => item.membershipId === null));
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
			include: memberInclude,
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
			if (selected && !selected.some(item => equal(item, current)))
				return [];
			const role = isOwner ? 'OWNER' : member!.role,
				teams = member?.teams.map(item => item.teamId) ?? [];
			if (role === 'ANALYST') return [];
			const all = role === 'OWNER' || role === 'CRM_ADMIN';
			const taskTeam = input.task.deal
				? input.task.deal.teamId
				: input.task.teamId;
			const ownTask = input.task.deal
				? input.task.deal.assignedToSubject === current.subject
				: equal(current, assignee);
			if (
				!(
					all ||
					ownTask ||
					(role === 'TEAM_LEAD' &&
						taskTeam !== null &&
						teams.includes(taskTeam))
				)
			)
				return [];
			const recipientKind = input.recipients.kind;
			if (
				recipientKind === 'SELF' &&
				!equal(input.ruleOwnerBinding, current)
			)
				return [];
			if (recipientKind === 'ASSIGNEE' && !equal(assignee, current))
				return [];
			if (
				recipientKind === 'SELECTED' &&
				!input.recipients.bindings.some(item => equal(item, current))
			)
				return [];
			if (
				recipientKind === 'TEAM_LEADS' &&
				!(
					all ||
					(role === 'TEAM_LEAD' &&
						taskTeam !== null &&
						teams.includes(taskTeam))
				)
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
		// Re-read both owners of authority after I/O; revoked or replaced bindings
		// cannot become a successful empty response on a transport failure.
		const freshOwner = await this.owner(input);
		if (!freshOwner) return denied();
		const fresh = await this.prisma.crmWorkspaceMember.findMany({
			where: {
				workspaceId: input.workspaceId,
				disabledAt: null,
				id: { in: page.map(item => item.id) }
			},
			include: memberInclude,
			orderBy: { id: 'asc' }
		});
		const freshDirectory = await this.identity.reminderDirectory(
			input.workspaceId,
			expected,
			includeOwner
		);
		if (
			JSON.stringify(owner) !== JSON.stringify(freshOwner) ||
			JSON.stringify(page) !== JSON.stringify(fresh) ||
			JSON.stringify(directory) !== JSON.stringify(freshDirectory)
		)
			throw new ServiceUnavailableException(
				'Reminder authority changed; retry with current state'
			);
		return {
			schemaVersion: 1 as const,
			workspaceId: input.workspaceId,
			allowed: true,
			items,
			nextCursor: rows.length > limit ? page[page.length - 1].id : null
		};
	}
	private async owner(input: TaskReminderRecipientsRequest) {
		try {
			const access = await this.authorization.assignmentSubject(
				input.workspaceId,
				input.ruleOwnerBinding.subject
			);
			const current = {
				subject: access.subject,
				membershipId: access.role === 'OWNER' ? null : access.membershipId
			};
			if (
				!equal(current, input.ruleOwnerBinding) ||
				!['ACTIVE', 'GRACE'].includes(access.state) ||
				access.role === 'ANALYST' ||
				!access.permissions.includes('sales:read') ||
				(input.scope === 'WORKSPACE' &&
					!['OWNER', 'CRM_ADMIN'].includes(access.role))
			)
				return null;
			return access;
		} catch (error) {
			if (error instanceof ForbiddenException) return null;
			throw error;
		}
	}
}
