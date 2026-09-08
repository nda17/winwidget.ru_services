import { Injectable } from '@nestjs/common';
import {
	Prisma,
	type Deal,
	type ReminderJob,
	type TaskSeries
} from '@prisma/crm-sales-client';
import { randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { enqueueReminderJob } from '../reminders/reminder-delivery.service';
import { reminderDeliveryEnabled } from '../reminders/reminder-delivery.contract';
import { taskDto } from '../workday/workday.service';
import {
	currentRecurrence,
	recurrenceOccurrence
} from './recurrence-time';
import { TaskSeriesAuthorityClient } from './task-series-authority.client';
import {
	enqueueSeriesScan,
	seriesAuthority,
	seriesSchedule
} from './task-series.service';

const PAGE_SIZE = 5;
@Injectable()
export class TaskSeriesGenerationService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly authority: TaskSeriesAuthorityClient
	) {}
	async schedulePeriod(now = new Date()) {
		if (!reminderDeliveryEnabled()) return;
		const key = `minute:${new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString()}`;
		await this.prisma.$transaction(tx => enqueueSeriesScan(tx, key));
	}
	/** Runs through the existing push consumer and its renewable PostgreSQL job
	 * lease. Five rows at a time; continuation and cursor commit before ACK. */
	async processPage(
		job: ReminderJob,
		leaseToken: string,
		stillOwned: () => boolean
	) {
		if (!reminderDeliveryEnabled())
			throw new Error('SERIES_GENERATION_DISABLED');
		const now = new Date();
		const rows = await this.prisma.taskSeries.findMany({
			where: {
				...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
				status: 'ACTIVE',
				nextRunAt: { lte: now },
				nextCheckAt: { lte: now },
				...(job.cursor ? { id: { gt: job.cursor } } : {})
			},
			orderBy: { id: 'asc' },
			take: PAGE_SIZE,
			include: { deal: true }
		});
		for (const row of rows) {
			if (!stillOwned()) throw new Error('SERIES_JOB_LEASE_LOST');
			await this.generate(
				row,
				{ jobId: job.id, token: leaseToken },
				stillOwned
			);
		}
		await this.prisma.$transaction(async tx => {
			const more = rows.length === PAGE_SIZE;
			const changed = await tx.reminderJob.updateMany({
				where: {
					id: job.id,
					status: 'PROCESSING',
					leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status: more ? 'PENDING' : 'COMPLETED',
					cursor: rows.at(-1)?.id ?? job.cursor,
					availableAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					completedAt: more ? null : new Date()
				}
			});
			if (changed.count !== 1 || !stillOwned())
				throw new Error('SERIES_JOB_LEASE_LOST');
			if (more) await enqueueReminderJob(tx, job.id);
		});
	}
	async generate(
		row: TaskSeries & { deal: Deal | null },
		lease: { jobId: string; token: string },
		stillOwned: () => boolean,
		now = new Date()
	) {
		const occurrence = currentRecurrence(
			seriesSchedule(row),
			row.nextIndex,
			now
		);
		if (row.status !== 'ACTIVE' || !occurrence) return;
		const closed =
			row.dealId &&
			(!row.deal || row.deal.archivedAt || row.deal.status !== 'OPEN');
		const authority = closed
			? { allowed: false as const, reason: 'DEAL_CLOSED' }
			: await this.authority.authorize(seriesAuthority(row));
		if (!stillOwned()) throw new Error('SERIES_JOB_LEASE_LOST');
		if (!authority.allowed) {
			await this.prisma.taskSeries.updateMany({
				where: {
					id: row.id,
					workspaceId: row.workspaceId,
					status: 'ACTIVE',
					version: row.version,
					nextIndex: row.nextIndex
				},
				data: {
					blockedReason: authority.reason,
					nextCheckAt: new Date(now.getTime() + 300000)
				}
			});
			return;
		}
		await this.prisma.$transaction(
			async tx => {
				const owned = await tx.reminderJob.updateMany({
					where: {
						id: lease.jobId,
						status: 'PROCESSING',
						leaseToken: lease.token,
						leaseExpiresAt: { gt: new Date() }
					},
					data: { leaseExpiresAt: new Date(Date.now() + 60000) }
				});
				if (owned.count !== 1) throw new Error('SERIES_JOB_LEASE_LOST');
				await tx.$queryRaw(
					Prisma.sql`SELECT id FROM crm_sales.task_series WHERE id=${row.id}::uuid AND workspace_id=${row.workspaceId}::uuid FOR UPDATE`
				);
				if (row.dealId)
					await tx.$queryRaw(
						Prisma.sql`SELECT id FROM crm_sales.deals WHERE id=${row.dealId}::uuid AND workspace_id=${row.workspaceId}::uuid FOR UPDATE`
					);
				const current = await tx.taskSeries.findUnique({
					where: { id: row.id },
					include: { deal: true }
				});
				if (
					!current ||
					current.status !== 'ACTIVE' ||
					current.version !== row.version ||
					current.nextIndex !== row.nextIndex ||
					!stillOwned()
				)
					return;
				if (
					row.dealId &&
					(!current.deal ||
						current.deal.status !== 'OPEN' ||
						current.deal.archivedAt ||
						current.deal.version !== row.deal?.version)
				)
					return;
				const next = recurrenceOccurrence(
					seriesSchedule(current),
					occurrence.index + 1
				);
				const updated = await tx.taskSeries.updateMany({
					where: {
						id: row.id,
						status: 'ACTIVE',
						version: row.version,
						nextIndex: row.nextIndex
					},
					data: {
						nextIndex: occurrence.index + 1,
						nextRunAt: next.availableAt,
						nextCheckAt: next.availableAt,
						blockedReason: null
					}
				});
				if (updated.count !== 1) throw new Error('SERIES_CURSOR_CONFLICT');
				const taskId = randomUUID();
				const task = await tx.salesTask.create({
					data: {
						id: taskId,
						workspaceId: current.workspaceId,
						dealId: current.dealId,
						title: current.title,
						dueAt: occurrence.dueAt,
						assignedToSubject: current.assignedToSubject,
						assignedToMembershipId: current.assignedToMembershipId,
						teamId: current.deal ? null : current.teamId
					}
				});
				if (current.deal && current.deal.nextTaskId === null) {
					const selected = await tx.deal.updateMany({
						where: {
							id: current.deal.id,
							workspaceId: current.workspaceId,
							version: current.deal.version,
							status: 'OPEN',
							archivedAt: null,
							nextTaskId: null
						},
						data: { nextTaskId: taskId, version: { increment: 1 } }
					});
					if (selected.count !== 1)
						throw new Error('SERIES_DEAL_VERSION_CONFLICT');
				}
				await tx.taskSeriesOccurrence.create({
					data: {
						id: randomUUID(),
						workspaceId: current.workspaceId,
						seriesId: current.id,
						periodIndex: occurrence.index,
						seriesVersion: current.version,
						taskId,
						dueAt: occurrence.dueAt
					}
				});
				await tx.taskTimeline.create({
					data: {
						id: randomUUID(),
						workspaceId: current.workspaceId,
						taskId,
						commandId: randomUUID(),
						actorSubject: current.creatorSubject,
						kind: 'CREATED',
						before: Prisma.DbNull,
						after: taskDto({ ...task, deal: current.deal })
					}
				});
				// The occurrence, task and durable async wake-up are a single commit.
				const jobId = randomUUID();
				await tx.reminderJob.create({
					data: {
						id: jobId,
						periodKey: `task-series-task:${current.id}:${occurrence.index}`,
						workspaceId: current.workspaceId,
						taskId
					}
				});
				await enqueueReminderJob(tx, jobId);
				if (!stillOwned()) throw new Error('SERIES_JOB_LEASE_LOST');
				await tx.$executeRaw(
					Prisma.sql`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`
				);
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				timeout: 10000
			}
		);
	}
}
