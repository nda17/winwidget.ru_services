import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { CrmAuthorizationService } from '../authorization/crm-authorization.service';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';

interface TaskSeriesBinding {
	subject: string;
	membershipId: string | null;
}
export interface TaskSeriesAuthorityRequest {
	schemaVersion: 1;
	workspaceId: string;
	seriesId: string;
	creatorBinding: TaskSeriesBinding;
	assigneeBinding: TaskSeriesBinding;
	template: {
		teamId: string | null;
		deal: {
			id: string;
			assignedToSubject: string;
			teamId: string | null;
		} | null;
	};
}
type Reason =
	| 'READ_ONLY'
	| 'CREATOR_REVOKED'
	| 'ASSIGNEE_REVOKED'
	| 'SCOPE_CHANGED';
type Authority = Awaited<
	ReturnType<CrmAuthorizationService['assignmentSubject']>
>;
const subject = (value: unknown): value is string =>
	typeof value === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
const nullableId = (value: unknown) => value === null || isUuidV4(value);
const binding = (value: unknown) =>
	isRecord(value) &&
	hasExactKeys(value, ['subject', 'membershipId']) &&
	subject(value.subject) &&
	nullableId(value.membershipId);

export function parseTaskSeriesAuthority(
	value: unknown
): TaskSeriesAuthorityRequest {
	const invalid = () => {
		throw new BadRequestException('Invalid task series authority request');
	};
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'workspaceId',
			'seriesId',
			'creatorBinding',
			'assigneeBinding',
			'template'
		]) ||
		value.schemaVersion !== 1 ||
		!isUuidV4(value.workspaceId) ||
		!isUuidV4(value.seriesId) ||
		!binding(value.creatorBinding) ||
		!binding(value.assigneeBinding)
	)
		return invalid();
	const template = value.template;
	if (
		!isRecord(template) ||
		!hasExactKeys(template, ['teamId', 'deal']) ||
		!nullableId(template.teamId) ||
		!(
			template.deal === null ||
			(isRecord(template.deal) &&
				hasExactKeys(template.deal, [
					'id',
					'assignedToSubject',
					'teamId'
				]) &&
				isUuidV4(template.deal.id) &&
				subject(template.deal.assignedToSubject) &&
				nullableId(template.deal.teamId))
		)
	)
		return invalid();
	return value as unknown as TaskSeriesAuthorityRequest;
}

@Injectable()
export class TaskSeriesAuthorityService {
	constructor(
		private readonly authorization: CrmAuthorizationService,
		private readonly prisma: CrmAccessPrismaService
	) {}

	async authorize(input: TaskSeriesAuthorityRequest) {
		const result = (reason: Reason | null) => ({
			schemaVersion: 1 as const,
			workspaceId: input.workspaceId,
			seriesId: input.seriesId,
			allowed: reason === null,
			reason
		});
		try {
			const before = await this.current(input);
			if (before.reason) return result(before.reason);
			// Identity, Billing and Access are read again after all authority I/O.
			// This endpoint grants no reusable lease and performs no business write.
			const fresh = await this.current(input);
			if (fresh.reason) return result(fresh.reason);
			if (!isDeepStrictEqual(before, fresh))
				return result('SCOPE_CHANGED');
			return result(null);
		} catch {
			// An unavailable owner is retryable, never a successful denial or an
			// error exposing provider/Prisma connection details to the caller.
			throw new ServiceUnavailableException(
				'Task series authority is temporarily unavailable'
			);
		}
	}

	private async current(input: TaskSeriesAuthorityRequest) {
		const [creator, assignee] = await Promise.all([
			this.bound(input.workspaceId, input.creatorBinding),
			this.bound(input.workspaceId, input.assigneeBinding)
		]);
		let reason: Reason | null = null;
		if (!creator) reason = 'CREATOR_REVOKED';
		else if (!assignee) reason = 'ASSIGNEE_REVOKED';
		else if (
			![creator.state, assignee.state].every(state =>
				['ACTIVE', 'GRACE'].includes(state)
			)
		)
			reason = 'READ_ONLY';
		else if (
			![creator, assignee].every(
				actor =>
					actor.role !== 'ANALYST' &&
					actor.permissions.includes('sales:write')
			) ||
			!(await this.scope(input, creator, assignee))
		)
			reason = 'SCOPE_CHANGED';
		return { reason, creator, assignee };
	}

	private async bound(workspaceId: string, binding: TaskSeriesBinding) {
		let access: Authority;
		try {
			access = await this.authorization.assignmentSubject(
				workspaceId,
				binding.subject
			);
		} catch (error) {
			if (error instanceof ForbiddenException) return null;
			throw error;
		}
		if (
			access.workspaceId !== workspaceId ||
			access.subject !== binding.subject ||
			(binding.membershipId === null
				? access.role !== 'OWNER'
				: access.membershipId !== binding.membershipId)
		)
			return null;
		return access;
	}

	private async scope(
		input: TaskSeriesAuthorityRequest,
		creator: Authority,
		assignee: Authority
	) {
		const { teamId, deal } = input.template;
		if (deal && teamId !== deal.teamId) return false;
		if (teamId && !creator.teamIds.includes(teamId)) return false;
		if (
			teamId &&
			assignee.dataScope !== 'ALL' &&
			!assignee.teamIds.includes(teamId)
		)
			return false;
		if (
			creator.dataScope === 'OWN' &&
			creator.subject !== assignee.subject
		)
			return false;
		if (assignee.role === 'OWNER' && creator.dataScope !== 'ALL')
			return false;
		if (
			creator.dataScope === 'TEAM' &&
			creator.subject !== assignee.subject
		) {
			if (!deal && (!teamId || !creator.teamIds.includes(teamId)))
				return false;
			// CRM_ADMIN's authorization teamIds includes every active workspace
			// team. Use its actual member-team rows for TEAM assignment authority.
			const member = await this.prisma.crmWorkspaceMember.findFirst({
				where: {
					workspaceId: input.workspaceId,
					subject: assignee.subject,
					membershipId: assignee.membershipId,
					role: assignee.role === 'OWNER' ? undefined : assignee.role,
					disabledAt: null,
					teams: {
						some: {
							teamId: { in: creator.teamIds },
							team: { archivedAt: null }
						}
					}
				},
				select: { id: true }
			});
			if (!member) return false;
		}
		if (deal) {
			return [creator, assignee].every(
				actor =>
					actor.dataScope === 'ALL' ||
					deal.assignedToSubject === actor.subject ||
					(actor.dataScope === 'TEAM' &&
						deal.teamId !== null &&
						actor.teamIds.includes(deal.teamId))
			);
		}
		return true;
	}
}
