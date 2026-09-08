import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	type Deal,
	type SalesTask
} from '@prisma/crm-sales-client';
import { createHash, randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import {
	SalesAccessClient,
	type SalesAccess
} from '../sales/sales-access';
import { salesScope } from '../sales/sales.service';
import type { SalesListQuery } from '../sales/sales.dto';
import { SalesAssigneeClient } from './sales-assignee.client';
import type {
	AssignWorkdayTaskDto,
	CreateWorkdayTaskDto,
	EditWorkdayTaskDto,
	SetTaskStatusDto,
	TaskAssigneeDto,
	WorkdayQuery
} from './workday.dto';
import { workdayPeriod } from './workday-period';

const active = ['OPEN', 'IN_PROGRESS'] as const;
const isActive = (status: SalesTask['status']) =>
	active.some(value => value === status);
type TaskRow = SalesTask & { deal: Deal | null };
type Command =
	| CreateWorkdayTaskDto
	| EditWorkdayTaskDto
	| SetTaskStatusDto
	| AssignWorkdayTaskDto;

export function workdayScope(
	access: SalesAccess
): Prisma.SalesTaskWhereInput {
	const standalone: Prisma.SalesTaskWhereInput =
		access.dataScope === 'ALL'
			? {}
			: access.dataScope === 'TEAM'
				? {
						OR: [
							{ assignedToSubject: access.subject },
							{ teamId: { in: access.teamIds } }
						]
					}
				: { assignedToSubject: access.subject };
	return {
		workspaceId: access.workspaceId,
		OR: [
			{ dealId: null, ...standalone },
			{ deal: { is: { AND: [salesScope(access), { archivedAt: null }] } } }
		]
	};
}
export function taskDto(task: TaskRow) {
	return {
		id: task.id,
		workspaceId: task.workspaceId,
		dealId: task.dealId,
		version: task.version,
		title: task.title,
		dueAt: task.dueAt.toISOString(),
		status: task.status,
		assignedToSubject: task.assignedToSubject,
		assignedToMembershipId: task.assignedToMembershipId,
		teamId: task.deal ? task.deal.teamId : task.teamId,
		completedAt: task.completedAt?.toISOString() ?? null,
		createdAt: task.createdAt.toISOString(),
		updatedAt: task.updatedAt.toISOString()
	};
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(',')}}`;
	return JSON.stringify(value);
}
function permission(access: SalesAccess, write: boolean) {
	if (
		access.role === 'ANALYST' ||
		!access.permissions.includes(write ? 'sales:write' : 'sales:read') ||
		(write && access.state === 'READ_ONLY')
	)
		throw new ForbiddenException();
}
function conflict(code = 'crm_task_version_conflict'): never {
	throw new ConflictException({
		code,
		message: 'Задача изменилась. Обновите данные'
	});
}
function missing(): never {
	throw new NotFoundException({
		code: 'crm_task_not_found',
		message: 'Задача недоступна'
	});
}
function validDate(value: string) {
	const time = Date.parse(value);
	if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
		throw new BadRequestException('Некорректный срок задачи');
	return new Date(time);
}

@Injectable()
export class WorkdayService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly accessClient: SalesAccessClient,
		private readonly assignees: SalesAssigneeClient
	) {}

	async list(access: SalesAccess, query: WorkdayQuery) {
		permission(access, false);
		if (query.workspaceId !== access.workspaceId)
			throw new ForbiddenException();
		if (query.scope === 'ALL' && access.dataScope !== 'ALL')
			throw new ForbiddenException();
		if (query.scope === 'TEAM' && access.dataScope === 'OWN')
			throw new ForbiddenException();
		if (query.teamId && !access.teamIds.includes(query.teamId))
			throw new ForbiddenException();
		const now = new Date(),
			range = workdayPeriod(query, now);
		const teamIds = query.teamId ? [query.teamId] : access.teamIds;
		const base: Prisma.SalesTaskWhereInput = {
			AND: [
				workdayScope(access),
				{
					...(query.scope === 'MINE'
						? { assignedToSubject: access.subject }
						: {}),
					...(query.scope === 'TEAM' || query.teamId
						? {
								OR: [
									{ dealId: null, teamId: { in: teamIds } },
									{ deal: { is: { teamId: { in: teamIds } } } }
								]
							}
						: {}),
					...(query.search?.trim()
						? {
								title: {
									contains: query.search.trim(),
									mode: 'insensitive'
								}
							}
						: {})
				},
				...(query.assigneeSubject
					? [{ assignedToSubject: query.assigneeSubject }]
					: [])
			]
		};
		const overdue: Prisma.SalesTaskWhereInput = {
			AND: [base, { status: { in: [...active] }, dueAt: { lt: now } }]
		};
		const period: Prisma.SalesTaskWhereInput =
			query.period === 'OVERDUE'
				? overdue
				: { AND: [base, ...(range ? [{ dueAt: range }] : [])] };
		const where: Prisma.SalesTaskWhereInput = {
			AND: [period, ...(query.status ? [{ status: query.status }] : [])]
		};
		const grouped = this.prisma.salesTask.groupBy({
			by: ['status'],
			where: period,
			orderBy: { status: 'asc' },
			_count: { _all: true }
		});
		const [total, rows, groups, overdueCount] =
			await this.prisma.$transaction(
				[
					this.prisma.salesTask.count({ where }),
					this.prisma.salesTask.findMany({
						where,
						include: { deal: true },
						orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
						skip: (query.page - 1) * query.pageSize,
						take: query.pageSize
					}),
					grouped,
					this.prisma.salesTask.count({ where: overdue })
				],
				{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
			);
		const counts = { OPEN: 0, IN_PROGRESS: 0, COMPLETED: 0, CANCELLED: 0 };
		for (const group of groups) counts[group.status] = group._count._all;
		return {
			schemaVersion: 1 as const,
			workspaceId: access.workspaceId,
			subject: access.subject,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(taskDto),
			counts,
			overdueCount,
			asOf: now.toISOString(),
			timeZone: query.timeZone,
			range: range
				? { from: range.gte.toISOString(), until: range.lt.toISOString() }
				: null
		};
	}

	async detail(access: SalesAccess, id: string) {
		permission(access, false);
		return {
			schemaVersion: 1 as const,
			task: taskDto(await this.visible(this.prisma, access, id))
		};
	}

	async timeline(access: SalesAccess, id: string, query: SalesListQuery) {
		permission(access, false);
		await this.visible(this.prisma, access, id);
		const where = {
			workspaceId: access.workspaceId,
			taskId: id,
			task: { is: workdayScope(access) }
		};
		const [total, rows] = await this.prisma.$transaction(
			[
				this.prisma.taskTimeline.count({ where }),
				this.prisma.taskTimeline.findMany({
					where,
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				})
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1 as const,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(row => ({
				id: row.id,
				workspaceId: row.workspaceId,
				taskId: row.taskId,
				actorSubject: row.actorSubject,
				kind: row.kind,
				before: row.before,
				after: row.after,
				createdAt: row.createdAt.toISOString()
			}))
		};
	}

	create(access: SalesAccess, dto: CreateWorkdayTaskDto, token: string) {
		return this.command(access, dto, 'CREATED', null, token);
	}
	edit(
		access: SalesAccess,
		id: string,
		dto: EditWorkdayTaskDto,
		token: string
	) {
		return this.command(access, dto, 'EDITED', id, token);
	}
	status(
		access: SalesAccess,
		id: string,
		dto: SetTaskStatusDto,
		token: string
	) {
		return this.command(access, dto, 'STATUS_CHANGED', id, token);
	}
	assign(
		access: SalesAccess,
		id: string,
		dto: AssignWorkdayTaskDto,
		token: string
	) {
		return this.command(access, dto, 'ASSIGNED', id, token);
	}

	private async command(
		initial: SalesAccess,
		dto: Command,
		kind: string,
		id: string | null,
		token: string
	) {
		permission(initial, true);
		if (initial.workspaceId !== dto.workspaceId)
			throw new ForbiddenException();
		const hash = createHash('sha256')
			.update(canonical({ dto, kind, id, subject: initial.subject }))
			.digest('hex');
		for (let attempt = 0; attempt < 3; attempt++) {
			const access = await this.accessClient.authorize(
				token,
				dto.workspaceId
			);
			permission(access, true);
			if (
				access.subject !== initial.subject ||
				access.workspaceId !== initial.workspaceId
			)
				throw new ForbiddenException();
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-workday-command:${dto.commandId}`}, 0))`
						);
						const prior = await tx.taskCommandReceipt.findUnique({
							where: { commandId: dto.commandId }
						});
						if (prior) {
							if (
								prior.workspaceId !== access.workspaceId ||
								prior.actorSubject !== access.subject ||
								prior.requestHash !== hash ||
								prior.commandType !== kind
							)
								conflict('crm_task_command_conflict');
							await this.visible(tx, access, prior.taskId);
							return prior.result;
						}
						const previous = id
							? await this.visible(tx, access, id)
							: null;
						if (
							previous &&
							(!('expectedVersion' in dto) ||
								previous.version !== dto.expectedVersion)
						)
							conflict();
						const create =
							kind === 'CREATED' ? (dto as CreateWorkdayTaskDto) : null;
						let deal = previous?.deal ?? null;
						if (create?.dealId) {
							deal = await tx.deal.findFirst({
								where: {
									AND: [
										salesScope(access),
										{ id: create.dealId, archivedAt: null }
									]
								}
							});
							if (!deal) missing();
						}
						if (deal) {
							// A task may need more work after its deal was won/lost.
							// Status changes must not reopen or otherwise mutate that deal.
							if (
								deal.archivedAt ||
								(deal.status !== 'OPEN' && kind !== 'STATUS_CHANGED')
							)
								conflict('crm_task_deal_closed');
							await tx.$queryRaw(
								Prisma.sql`SELECT id FROM crm_sales.deals WHERE id=${deal.id}::uuid AND workspace_id=${access.workspaceId}::uuid FOR UPDATE`
							);
						}
						const teamId = deal
							? deal.teamId
							: (create?.teamId ?? previous?.teamId ?? null);
						if (
							create?.teamId &&
							((deal && deal.teamId !== create.teamId) ||
								!access.teamIds.includes(create.teamId))
						)
							throw new ForbiddenException();
						if ('assignee' in dto)
							await this.authorizeAssignee(
								tx,
								token,
								access,
								dto.assignee,
								teamId,
								deal
							);
						let task: TaskRow;
						if (create) {
							task = await tx.salesTask.create({
								data: {
									id: randomUUID(),
									workspaceId: access.workspaceId,
									dealId: deal?.id ?? null,
									title: create.title.trim(),
									dueAt: validDate(create.dueAt),
									assignedToSubject: create.assignee.subject,
									assignedToMembershipId: create.assignee.membershipId,
									teamId: deal ? null : teamId
								},
								include: { deal: true }
							});
						} else {
							if (!previous || !id) missing();
							let data: Prisma.SalesTaskUpdateManyMutationInput;
							if (kind === 'EDITED') {
								const edit = dto as EditWorkdayTaskDto;
								data = {
									title: edit.title.trim(),
									dueAt: validDate(edit.dueAt)
								};
							} else if (kind === 'STATUS_CHANGED') {
								const status = (dto as SetTaskStatusDto).status;
								data = {
									status,
									completedAt: isActive(status)
										? null
										: previous.status === status
											? previous.completedAt
											: new Date()
								};
							} else {
								const target = (dto as AssignWorkdayTaskDto).assignee;
								data = {
									assignedToSubject: target.subject,
									assignedToMembershipId: target.membershipId
								};
							}
							const updated = await tx.salesTask.updateMany({
								where: {
									AND: [
										workdayScope(access),
										{ id, version: previous.version }
									]
								},
								data: { ...data, version: { increment: 1 } }
							});
							if (updated.count !== 1) conflict();
							task = await this.visible(tx, access, id);
						}
						if (deal?.status === 'OPEN') {
							const selected = await tx.salesTask.findFirst({
								where: {
									workspaceId: access.workspaceId,
									dealId: deal.id,
									status: { in: [...active] },
									id: deal.nextTaskId ?? undefined
								},
								orderBy: [{ dueAt: 'asc' }, { id: 'asc' }]
							});
							const next =
								selected ??
								(await tx.salesTask.findFirst({
									where: {
										workspaceId: access.workspaceId,
										dealId: deal.id,
										status: { in: [...active] }
									},
									orderBy: [{ dueAt: 'asc' }, { id: 'asc' }]
								}));
							const updated = await tx.deal.updateMany({
								where: {
									id: deal.id,
									workspaceId: access.workspaceId,
									version: deal.version,
									status: 'OPEN',
									archivedAt: null
								},
								data: {
									nextTaskId: next?.id ?? null,
									version: { increment: 1 }
								}
							});
							if (updated.count !== 1) conflict();
						}
						const result = {
							schemaVersion: 1 as const,
							task: taskDto(task)
						};
						await tx.taskTimeline.create({
							data: {
								id: randomUUID(),
								workspaceId: access.workspaceId,
								taskId: task.id,
								commandId: dto.commandId,
								actorSubject: access.subject,
								kind,
								before: previous ? taskDto(previous) : Prisma.DbNull,
								after: result.task
							}
						});
						await tx.taskCommandReceipt.create({
							data: {
								commandId: dto.commandId,
								workspaceId: access.workspaceId,
								actorSubject: access.subject,
								commandType: kind,
								requestHash: hash,
								taskId: task.id,
								result
							}
						});
						await tx.$executeRaw(
							Prisma.sql`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`
						);
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						timeout: 15000,
						maxWait: 5000
					}
				);
			} catch (error) {
				if (
					attempt === 2 ||
					!error ||
					typeof error !== 'object' ||
					!('code' in error) ||
					error.code !== 'P2034'
				)
					throw error;
			}
		}
		conflict();
	}

	private async authorizeAssignee(
		tx: Prisma.TransactionClient,
		token: string,
		access: SalesAccess,
		assignee: TaskAssigneeDto,
		teamId: string | null,
		deal: Deal | null
	) {
		if (access.dataScope === 'OWN' && assignee.subject !== access.subject)
			throw new ForbiddenException();
		if (
			!deal &&
			access.dataScope === 'TEAM' &&
			assignee.subject !== access.subject &&
			(!teamId || !access.teamIds.includes(teamId))
		)
			throw new ForbiddenException();
		const target = await this.assignees.authorize(
			token,
			access,
			assignee,
			teamId ?? undefined
		);
		if (
			deal &&
			!(await tx.deal.findFirst({
				where: {
					AND: [
						salesScope({ ...access, ...target }),
						{ id: deal.id, archivedAt: null }
					]
				},
				select: { id: true }
			}))
		)
			throw new ForbiddenException(
				'Ответственному недоступна связанная сделка'
			);
		const fresh = await this.accessClient.authorize(
			token,
			access.workspaceId
		);
		permission(fresh, true);
		if (
			canonical({
				...fresh,
				teamIds: [...fresh.teamIds].sort(),
				permissions: [...fresh.permissions].sort()
			}) !==
			canonical({
				...access,
				teamIds: [...access.teamIds].sort(),
				permissions: [...access.permissions].sort()
			})
		)
			throw new ForbiddenException('Права назначения изменились');
	}
	private async visible(
		client: Pick<Prisma.TransactionClient, 'salesTask'>,
		access: SalesAccess,
		id: string
	): Promise<TaskRow> {
		const task = await client.salesTask.findFirst({
			where: { AND: [workdayScope(access), { id }] },
			include: { deal: true }
		});
		if (!task) missing();
		return task;
	}
}
