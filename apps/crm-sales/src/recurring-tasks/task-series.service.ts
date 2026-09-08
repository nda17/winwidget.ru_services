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
	type TaskSeries
} from '@prisma/crm-sales-client';
import { createHash, randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import {
	SalesAccessClient,
	type SalesAccess
} from '../sales/sales-access';
import { salesScope } from '../sales/sales.service';
import { ReminderActorClient } from '../reminders/reminder-actor.client';
import { enqueueReminderJob } from '../reminders/reminder-delivery.service';
import {
	recurrenceOccurrence,
	validateRecurrenceSchedule,
	type RecurrenceSchedule
} from './recurrence-time';
import {
	TaskSeriesAuthorityClient,
	type SeriesAuthorityRequest
} from './task-series-authority.client';
import type {
	CreateTaskSeriesDto,
	EditTaskSeriesDto,
	SetTaskSeriesStatusDto,
	TaskSeriesQuery
} from './task-series.dto';

export const SERIES_SCAN_PREFIX = 'task-series-scan:';
type SeriesRow = TaskSeries & { deal: Deal | null };
type Command =
	| CreateTaskSeriesDto
	| EditTaskSeriesDto
	| SetTaskSeriesStatusDto;
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
function conflict(code = 'crm_task_series_version_conflict'): never {
	throw new ConflictException({
		code,
		message: 'Серия задач изменилась. Обновите данные'
	});
}
export function seriesSchedule(row: TaskSeries): RecurrenceSchedule {
	const schedule = {
		frequency: row.frequency as RecurrenceSchedule['frequency'],
		startDate: row.startDate,
		localTime: row.localTime,
		timeZone: row.timeZone
	};
	validateRecurrenceSchedule(schedule);
	return schedule;
}
export function seriesAuthority(row: SeriesRow): SeriesAuthorityRequest {
	return {
		schemaVersion: 1,
		workspaceId: row.workspaceId,
		seriesId: row.id,
		creatorBinding: {
			subject: row.creatorSubject,
			membershipId: row.creatorMembershipId
		},
		assigneeBinding: {
			subject: row.assignedToSubject,
			membershipId: row.assignedToMembershipId
		},
		template: {
			teamId: row.deal ? row.deal.teamId : row.teamId,
			deal: row.deal
				? {
						id: row.deal.id,
						assignedToSubject: row.deal.assignedToSubject,
						teamId: row.deal.teamId
					}
				: null
		}
	};
}
export function seriesDto(row: TaskSeries) {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		version: row.version,
		title: row.title,
		dealId: row.dealId,
		teamId: row.teamId,
		assignee: {
			subject: row.assignedToSubject,
			membershipId: row.assignedToMembershipId
		},
		frequency: row.frequency,
		startDate: row.startDate,
		localTime: row.localTime,
		timeZone: row.timeZone,
		status: row.status,
		nextRunAt: row.nextRunAt.toISOString(),
		blockedReason: row.blockedReason,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}
function scope(access: SalesAccess): Prisma.TaskSeriesWhereInput {
	const standalone =
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
export async function enqueueSeriesScan(
	tx: Prisma.TransactionClient,
	key: string,
	workspaceId?: string
) {
	const id = randomUUID();
	const created = await tx.reminderJob.createMany({
		data: [{ id, periodKey: `${SERIES_SCAN_PREFIX}${key}`, workspaceId }],
		skipDuplicates: true
	});
	if (created.count) await enqueueReminderJob(tx, id);
}
@Injectable()
export class TaskSeriesService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly accessClient: SalesAccessClient,
		private readonly actors: ReminderActorClient,
		private readonly authority: TaskSeriesAuthorityClient
	) {}
	async list(access: SalesAccess, query: TaskSeriesQuery) {
		permission(access, false);
		if (query.workspaceId !== access.workspaceId)
			throw new ForbiddenException();
		const where: Prisma.TaskSeriesWhereInput = {
			AND: [
				scope(access),
				...(query.status === 'ALL' ? [] : [{ status: query.status }]),
				...(query.search?.trim()
					? [
							{
								title: {
									contains: query.search.trim(),
									mode: 'insensitive' as const
								}
							}
						]
					: [])
			]
		};
		const [total, rows] = await this.prisma.$transaction(
			[
				this.prisma.taskSeries.count({ where }),
				this.prisma.taskSeries.findMany({
					where,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
					skip: (query.page - 1) * query.pageSize,
					take: query.pageSize
				})
			],
			{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
		);
		return {
			schemaVersion: 1,
			workspaceId: access.workspaceId,
			page: query.page,
			pageSize: query.pageSize,
			total,
			items: rows.map(seriesDto)
		};
	}
	create(access: SalesAccess, dto: CreateTaskSeriesDto, token: string) {
		return this.command(access, dto, 'CREATE', null, token);
	}
	edit(
		access: SalesAccess,
		id: string,
		dto: EditTaskSeriesDto,
		token: string
	) {
		return this.command(access, dto, 'EDIT', id, token);
	}
	status(
		access: SalesAccess,
		id: string,
		dto: SetTaskSeriesStatusDto,
		token: string
	) {
		return this.command(access, dto, 'STATUS', id, token);
	}
	private async visible(
		tx: Pick<Prisma.TransactionClient, 'taskSeries'>,
		access: SalesAccess,
		id: string
	) {
		const row = await tx.taskSeries.findFirst({
			where: { AND: [scope(access), { id }] },
			include: { deal: true }
		});
		if (!row) throw new NotFoundException('Серия задач недоступна');
		return row;
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
				initial.workspaceId
			);
			permission(access, true);
			if (
				access.subject !== initial.subject ||
				access.workspaceId !== initial.workspaceId
			)
				throw new ForbiddenException();
			await this.actors.verify(token, access, dto.actorMembershipId);
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw(
							Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-task-series-command:${dto.commandId}`}, 0))`
						);
						const prior = await tx.taskSeriesCommand.findUnique({
							where: { commandId: dto.commandId }
						});
						if (prior) {
							if (
								prior.workspaceId !== access.workspaceId ||
								prior.actorSubject !== access.subject ||
								prior.requestHash !== hash
							)
								conflict('crm_task_series_command_conflict');
							await this.visible(tx, access, prior.seriesId);
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
						if (previous?.status === 'CANCELLED')
							conflict('crm_task_series_cancelled');
						const create =
							kind === 'CREATE' ? (dto as CreateTaskSeriesDto) : null;
						let deal = previous?.deal ?? null;
						if (create?.dealId)
							deal = await tx.deal.findFirst({
								where: {
									AND: [
										salesScope(access),
										{ id: create.dealId, archivedAt: null }
									]
								}
							});
						if (create?.dealId && !deal)
							throw new NotFoundException('Сделка недоступна');
						if (create?.teamId && deal && create.teamId !== deal.teamId)
							throw new ForbiddenException();
						if (deal)
							await tx.$queryRaw(
								Prisma.sql`SELECT id FROM crm_sales.deals WHERE id=${deal.id}::uuid AND workspace_id=${access.workspaceId}::uuid FOR UPDATE`
							);
						const content = 'content' in dto ? dto.content : null;
						const now = new Date();
						let candidate: SeriesRow;
						if (create && content) {
							await tx.$executeRaw(
								Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-task-series-limit:${access.workspaceId}`}, 0))`
							);
							if (
								(await tx.taskSeries.count({
									where: {
										workspaceId: access.workspaceId,
										status: { not: 'CANCELLED' }
									}
								})) >= 200
							)
								throw new BadRequestException(
									'Можно создать не более 200 активных и приостановленных серий'
								);
							candidate = {
								id: randomUUID(),
								workspaceId: access.workspaceId,
								version: 1,
								creatorSubject: access.subject,
								creatorMembershipId: dto.actorMembershipId,
								title: content.title.trim(),
								dealId: deal?.id ?? null,
								deal,
								teamId: deal ? null : (create.teamId ?? null),
								assignedToSubject: content.assignee.subject,
								assignedToMembershipId: content.assignee.membershipId,
								frequency: create.frequency,
								startDate: create.startDate,
								localTime: content.localTime,
								timeZone: content.timeZone,
								status: 'ACTIVE',
								nextIndex: 0,
								nextRunAt: now,
								nextCheckAt: now,
								blockedReason: null,
								createdAt: now,
								updatedAt: now
							};
						} else {
							if (!previous) throw new NotFoundException();
							candidate = {
								...previous,
								...(content
									? {
											title: content.title.trim(),
											localTime: content.localTime,
											timeZone: content.timeZone,
											assignedToSubject: content.assignee.subject,
											assignedToMembershipId: content.assignee.membershipId
										}
									: {}),
								...('status' in dto ? { status: dto.status } : {}),
								version: previous.version + 1,
								updatedAt: now,
								nextCheckAt: now,
								blockedReason: null
							};
						}
						try {
							candidate.nextRunAt = recurrenceOccurrence(
								seriesSchedule(candidate),
								candidate.nextIndex
							).availableAt;
						} catch {
							throw new BadRequestException(
								'Некорректное расписание серии'
							);
						}
						if (candidate.status === 'ACTIVE' || content) {
							if (deal && (deal.status !== 'OPEN' || deal.archivedAt))
								conflict('crm_task_series_deal_closed');
							const allowed = await this.authority.authorize({
								...seriesAuthority(candidate),
								creatorBinding: {
									subject: access.subject,
									membershipId: dto.actorMembershipId
								}
							});
							if (!allowed.allowed)
								throw new ForbiddenException({
									code: 'crm_task_series_authority_denied',
									reason: allowed.reason,
									message: 'Права серии или ответственного изменились'
								});
						}
						const fresh = await this.accessClient.authorize(
							token,
							access.workspaceId
						);
						permission(fresh, true);
						if (canonical(fresh) !== canonical(access))
							throw new ForbiddenException('Права изменились');
						const { deal: _deal, ...data } = candidate;
						void _deal;
						if (create) await tx.taskSeries.create({ data });
						else {
							const updated = await tx.taskSeries.updateMany({
								where: {
									id: candidate.id,
									workspaceId: access.workspaceId,
									version: previous!.version,
									status: { not: 'CANCELLED' }
								},
								data
							});
							if (updated.count !== 1) conflict();
						}
						const result = {
							schemaVersion: 1,
							series: seriesDto(candidate)
						};
						await tx.taskSeriesCommand.create({
							data: {
								commandId: dto.commandId,
								workspaceId: access.workspaceId,
								actorSubject: access.subject,
								requestHash: hash,
								seriesId: candidate.id,
								before: previous ? seriesDto(previous) : Prisma.DbNull,
								result
							}
						});
						if (candidate.status === 'ACTIVE')
							await enqueueSeriesScan(
								tx,
								dto.commandId,
								access.workspaceId
							);
						return result;
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						timeout: 20000,
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
		return conflict();
	}
}
