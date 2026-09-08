import {
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/crm-sales-client';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { ReminderActorClient } from '../reminders/reminder-actor.client';
import {
	SalesAccessClient,
	type SalesAccess
} from '../sales/sales-access';
import type {
	TaskNotificationReadDto,
	TaskNotificationsQuery
} from './task-notifications.dto';

const fingerprint = (access: SalesAccess) =>
	JSON.stringify([
		access.workspaceId,
		access.subject,
		access.role,
		access.state,
		access.dataScope,
		[...access.teamIds].sort(),
		[...access.permissions].sort()
	]);
/** Even ALL users read only their own exact recipient binding. The linked deal
 * uses the same ALL / TEAM / OWN semantics as workdayScope, not just task owner. */
export function taskNotificationVisibility(
	access: SalesAccess,
	membershipId: string | null,
	now: Date
) {
	const dealScope =
		access.dataScope === 'ALL'
			? Prisma.sql`TRUE`
			: access.dataScope === 'TEAM' && access.teamIds.length
				? Prisma.sql`(d.assigned_to_subject=${access.subject} OR d.team_id IN (${Prisma.join(access.teamIds.map(id => Prisma.sql`${id}::uuid`))}))`
				: Prisma.sql`d.assigned_to_subject=${access.subject}`;
	return Prisma.sql`n.workspace_id=${access.workspaceId}::uuid
	 AND n.recipient_subject=${access.subject}
	 AND n.recipient_membership_id IS NOT DISTINCT FROM ${membershipId}::uuid
	 AND n.cancelled_at IS NULL AND n.available_at <= ${now}
	 AND t.workspace_id=n.workspace_id AND t.id=n.task_id
	 AND t.assigned_to_subject=n.recipient_subject
	 AND t.assigned_to_membership_id IS NOT DISTINCT FROM n.recipient_membership_id
	 AND t.assignment_version=n.assignment_version AND t.status IN ('OPEN','IN_PROGRESS')
	 AND (t.deal_id IS NULL OR (d.id=t.deal_id AND d.workspace_id=n.workspace_id
	   AND d.archived_at IS NULL AND ${dealScope}))`;
}
const joins = Prisma.sql`FROM crm_sales.task_notifications n
 JOIN crm_sales.tasks t ON t.id=n.task_id AND t.workspace_id=n.workspace_id
 LEFT JOIN crm_sales.deals d ON d.id=t.deal_id AND d.workspace_id=t.workspace_id`;
type Row = {
	id: string;
	kind: string;
	taskId: string;
	title: string;
	dueAt: Date;
	createdAt: Date;
	readAt: Date | null;
};

@Injectable()
export class TaskNotificationsService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly accessClient: SalesAccessClient,
		private readonly actors: ReminderActorClient
	) {}
	private async authority(
		initial: SalesAccess,
		workspaceId: string,
		membershipId: string | null,
		token: string
	) {
		if (
			initial.workspaceId !== workspaceId ||
			initial.role === 'ANALYST' ||
			!initial.permissions.includes('sales:read')
		)
			throw new ForbiddenException();
		const current = await this.accessClient.authorize(token, workspaceId);
		if (fingerprint(current) !== fingerprint(initial))
			throw new ForbiddenException('CRM notification authority changed');
		const binding = await this.actors.verify(token, current, membershipId);
		if (
			binding.subject !== initial.subject ||
			binding.membershipId !== membershipId
		)
			throw new ForbiddenException();
		return current;
	}
	async list(
		initial: SalesAccess,
		query: TaskNotificationsQuery,
		token: string
	) {
		const membershipId = query.actorMembershipId ?? null;
		const access = await this.authority(
			initial,
			query.workspaceId,
			membershipId,
			token
		);
		const where = taskNotificationVisibility(
			access,
			membershipId,
			new Date()
		);
		const unread =
			query.unreadOnly === 'true'
				? Prisma.sql`AND n.read_at IS NULL`
				: Prisma.empty;
		const result = await this.prisma.$transaction(
			async tx => {
				const [counts] = await tx.$queryRaw<
					{ total: bigint; unread: bigint }[]
				>`SELECT count(*) AS total,count(*) FILTER (WHERE n.read_at IS NULL) AS unread ${joins} WHERE ${where}`;
				const rows = await tx.$queryRaw<
					Row[]
				>`SELECT n.id,n.kind,n.task_id AS "taskId",t.title,t.due_at AS "dueAt",n.created_at AS "createdAt",n.read_at AS "readAt" ${joins} WHERE ${where} ${unread} ORDER BY n.available_at DESC,n.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
				return { counts, rows };
			},
			{ isolationLevel: 'RepeatableRead' }
		);
		await this.authority(access, query.workspaceId, membershipId, token);
		return {
			schemaVersion: 1,
			workspaceId: query.workspaceId,
			page: query.page,
			pageSize: query.pageSize,
			total: Number(
				query.unreadOnly === 'true'
					? result.counts.unread
					: result.counts.total
			),
			unreadCount: Number(result.counts.unread),
			items: result.rows.map(row => ({
				...row,
				dueAt: row.dueAt.toISOString(),
				createdAt: row.createdAt.toISOString(),
				readAt: row.readAt?.toISOString() ?? null,
				href: `/planner?task=${row.taskId}`
			}))
		};
	}
	async setRead(
		initial: SalesAccess,
		id: string,
		dto: TaskNotificationReadDto,
		token: string
	) {
		const access = await this.authority(
			initial,
			dto.workspaceId,
			dto.actorMembershipId,
			token
		);
		const now = new Date();
		const where = taskNotificationVisibility(
			access,
			dto.actorMembershipId,
			now
		);
		const rows = await this.prisma.$queryRaw<
			{ id: string; readAt: Date | null }[]
		>`UPDATE crm_sales.task_notifications AS n
		 SET read_at=CASE WHEN ${dto.read} THEN coalesce(n.read_at,${now}) ELSE NULL END
		 FROM crm_sales.tasks t LEFT JOIN crm_sales.deals d ON d.id=t.deal_id AND d.workspace_id=t.workspace_id
		 WHERE n.id=${id}::uuid AND ${where} RETURNING n.id,n.read_at AS "readAt"`;
		if (rows.length !== 1)
			throw new NotFoundException('CRM notification is unavailable');
		return {
			schemaVersion: 1,
			workspaceId: dto.workspaceId,
			id,
			readAt: rows[0].readAt?.toISOString() ?? null
		};
	}
}
