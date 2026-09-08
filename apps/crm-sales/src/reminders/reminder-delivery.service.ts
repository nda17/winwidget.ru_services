import { Injectable } from '@nestjs/common';
import {
	Prisma,
	type SalesTask,
	type Deal,
	type ReminderRule,
	type ReminderJob
} from '@prisma/crm-sales-client';
import { randomUUID } from 'node:crypto';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import {
	parseReminderRule,
	type ReminderBinding,
	type ReminderRuleV1
} from './reminder-rule';
import {
	ReminderRecipientsClient,
	type ReminderTaskAuthority
} from './reminder-recipients.client';
import {
	currentOccurrence,
	assignmentOccurrence,
	deliveryKey,
	quietUntil,
	reminderDeliveryEnabled,
	reminderEventType,
	REMINDER_TICK,
	sameBinding
} from './reminder-delivery.contract';

type Task = SalesTask & { deal: Deal | null };
const active = (task: Task) =>
	['OPEN', 'IN_PROGRESS'].includes(task.status) &&
	(task.dealId === null ||
		(task.deal !== null && task.deal.archivedAt === null));
const authority = (task: Task): ReminderTaskAuthority => ({
	id: task.id,
	assignedToSubject: task.assignedToSubject,
	assignedToMembershipId: task.assignedToMembershipId,
	teamId: task.teamId,
	deal: task.deal && {
		assignedToSubject: task.deal.assignedToSubject,
		teamId: task.deal.teamId
	}
});
const taskFingerprint = (task: Task) =>
	JSON.stringify([
		task.id,
		task.workspaceId,
		task.version,
		task.status,
		task.dueAt.toISOString(),
		task.title,
		task.assignedToSubject,
		task.assignedToMembershipId,
		task.assignmentVersion,
		task.assignmentAt,
		task.teamId,
		task.deal?.id,
		task.deal?.version,
		task.deal?.archivedAt,
		task.deal?.assignedToSubject,
		task.deal?.teamId
	]);
function config(row: ReminderRule): ReminderRuleV1 {
	const rule = parseReminderRule(row.configuration);
	if (
		rule.id.toLowerCase() !== row.id ||
		rule.scope !== row.scope ||
		rule.ownerBinding.subject !== row.ownerSubject ||
		rule.ownerBinding.membershipId !== row.ownerMembershipId
	)
		throw new Error('REMINDER_STORED_BINDING');
	return rule;
}
function taskOccurrence(
	rule: ReminderRuleV1,
	row: ReminderRule,
	task: Task
) {
	return rule.trigger.kind === 'ASSIGNED'
		? task.assignmentVersion
			? assignmentOccurrence(
					rule,
					task.assignmentAt,
					row.updatedAt,
					Date.now()
				)
			: null
		: currentOccurrence(rule, task.dueAt, Date.now());
}
export function enqueueReminderJob(
	tx: Prisma.TransactionClient,
	jobId: string,
	availableAt = new Date()
) {
	const eventId = randomUUID();
	return tx.reminderOutbox.create({
		data: {
			id: eventId,
			messageId: eventId,
			eventType: REMINDER_TICK,
			availableAt,
			payload: {
				schemaVersion: 1,
				eventId,
				eventType: REMINDER_TICK,
				occurredAt: new Date().toISOString(),
				jobId
			}
		}
	});
}

@Injectable()
export class ReminderDeliveryService {
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly recipients: ReminderRecipientsClient
	) {}

	async schedulePeriod(now = new Date()) {
		if (!reminderDeliveryEnabled()) return;
		const periodKey = `minute:${new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()}`;
		await this.prisma.$transaction(async tx => {
			const id = randomUUID();
			const result = await tx.reminderJob.createMany({
				data: [{ id, periodKey }],
				skipDuplicates: true
			});
			if (result.count) await enqueueReminderJob(tx, id);
		});
	}

	/** A push consumer calls one bounded page. The cursor commits together with a
	 * durable continuation before ACK; retries never trust a process-local cursor. */
	async processPage(
		job: ReminderJob,
		leaseToken: string,
		stillOwned: () => boolean
	) {
		if (!reminderDeliveryEnabled())
			throw new Error('REMINDER_DELIVERY_DISABLED');
		const tasks = await this.prisma.salesTask.findMany({
			where: {
				...(job.workspaceId ? { workspaceId: job.workspaceId } : {}),
				...(job.taskId
					? { id: job.taskId }
					: job.cursor
						? { id: { gt: job.cursor } }
						: {}),
				status: { in: ['OPEN', 'IN_PROGRESS'] },
				// Assignments are independent of deadlines, including tasks months ahead.
				AND: [
					{
						OR: [
							{ dueAt: { lte: new Date(Date.now() + 43_200 * 60_000) } },
							{ assignmentAt: { not: null } }
						]
					}
				],
				OR: [{ dealId: null }, { deal: { is: { archivedAt: null } } }]
			},
			orderBy: { id: 'asc' },
			take: 5,
			include: { deal: true }
		});
		for (const task of tasks) {
			if (!stillOwned()) throw new Error('REMINDER_JOB_LEASE_LOST');
			const rules = await this.prisma.reminderRule.findMany({
				where: {
					workspaceId: task.workspaceId,
					archivedAt: null,
					configuration: { path: ['enabled'], equals: true },
					OR: [
						{ scope: 'WORKSPACE' },
						{
							scope: 'PERSONAL',
							ownerSubject: task.assignedToSubject,
							ownerMembershipId: task.assignedToMembershipId
						}
					]
				},
				orderBy: { id: 'asc' },
				take: 31
			});
			if (rules.length > 30)
				throw new Error('REMINDER_RULE_LIMIT_INVARIANT');
			for (const row of rules) {
				if (!stillOwned()) throw new Error('REMINDER_JOB_LEASE_LOST');
				await this.generate(task, row, stillOwned);
			}
		}
		await this.prisma.$transaction(async tx => {
			const more = !job.taskId && tasks.length === 5;
			const result = await tx.reminderJob.updateMany({
				where: {
					id: job.id,
					status: 'PROCESSING',
					leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status: more ? 'PENDING' : 'COMPLETED',
					cursor: tasks.at(-1)?.id ?? job.cursor,
					availableAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					completedAt: more ? null : new Date()
				}
			});
			if (result.count !== 1 || !stillOwned())
				throw new Error('REMINDER_JOB_LEASE_LOST');
			if (more) await enqueueReminderJob(tx, job.id);
		});
	}

	private async generate(
		task: Task,
		row: ReminderRule,
		stillOwned: () => boolean
	) {
		const rule = config(row);
		const occurrence = taskOccurrence(rule, row, task);
		if (
			!rule.enabled ||
			!active(task) ||
			!occurrence ||
			occurrence.notBefore > Date.now()
		)
			return;
		const cursors = new Set<string>();
		let cursor: string | null = null;
		for (let page = 0; page < 102; page++) {
			if (!stillOwned()) throw new Error('REMINDER_JOB_LEASE_LOST');
			const result = await this.recipients.read(
				task.workspaceId,
				rule,
				authority(task),
				null,
				cursor
			);
			if (!result.allowed) return;
			await this.prisma.$transaction(
				async tx => {
					await tx.$queryRaw`SELECT id FROM crm_sales.tasks WHERE id=${task.id}::uuid AND workspace_id=${task.workspaceId}::uuid FOR SHARE`;
					await tx.$queryRaw`SELECT id FROM crm_sales.reminder_rules WHERE id=${row.id}::uuid AND workspace_id=${task.workspaceId}::uuid FOR SHARE`;
					const [currentTask, currentRule] = await Promise.all([
						tx.salesTask.findUnique({
							where: { id: task.id },
							include: { deal: true }
						}),
						tx.reminderRule.findUnique({ where: { id: row.id } })
					]);
					if (
						!currentTask ||
						!active(currentTask) ||
						taskFingerprint(currentTask) !== taskFingerprint(task) ||
						!currentRule ||
						currentRule.version !== row.version ||
						currentRule.archivedAt ||
						!config(currentRule).enabled ||
						!stillOwned()
					)
						return;
					const deliveries = result.items.flatMap(item =>
						rule.channels.flatMap(channel => {
							if (channel === 'EMAIL' ? !item.email : !item.telegramChatId)
								return [];
							return [
								{
									id: randomUUID(),
									workspaceId: task.workspaceId,
									taskId: task.id,
									ruleId: row.id,
									taskVersion: task.version,
									assignmentVersion:
										rule.trigger.kind === 'ASSIGNED'
											? task.assignmentVersion
											: null,
									ruleVersion: row.version,
									occurrenceIndex: occurrence.index,
									recipientSubject: item.binding.subject,
									recipientMembershipId: item.binding.membershipId,
									channel,
									nominalAt: occurrence.nominalAt,
									deduplicationKey: deliveryKey({
										taskId: task.id,
										taskVersion:
											rule.trigger.kind === 'ASSIGNED'
												? task.assignmentVersion!
												: task.version,
										ruleId: row.id,
										ruleVersion: row.version,
										occurrenceIndex: occurrence.index,
										recipient: item.binding,
										channel
									})
								}
							];
						})
					);
					if (!deliveries.length) return;
					await tx.reminderDelivery.createMany({
						data: deliveries,
						skipDuplicates: true
					});
					const created = await tx.reminderDelivery.findMany({
						where: { id: { in: deliveries.map(item => item.id) } }
					});
					if (created.length)
						await tx.reminderOutbox.createMany({
							data: created.map(item => ({
								id: randomUUID(),
								messageId: item.id,
								eventType: reminderEventType(
									item.channel as 'EMAIL' | 'TELEGRAM'
								),
								payload: {
									schemaVersion: 1,
									eventId: item.id,
									eventType: reminderEventType(
										item.channel as 'EMAIL' | 'TELEGRAM'
									),
									occurredAt: item.createdAt.toISOString(),
									reference: {
										type: 'wincrm-task-reminder',
										id: item.id,
										workspaceId: item.workspaceId
									}
								}
							}))
						});
				},
				{ timeout: 10_000 }
			);
			if (!result.nextCursor) return;
			if (cursors.has(result.nextCursor))
				throw new Error('REMINDER_DIRECTORY_CURSOR');
			cursors.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		throw new Error('REMINDER_DIRECTORY_PAGE_LIMIT');
	}

	async context(
		id: string,
		input: {
			eventId: string;
			workspaceId: string;
			channel: 'EMAIL' | 'TELEGRAM';
		}
	) {
		const envelope = {
			schemaVersion: 1 as const,
			eventId: input.eventId,
			reminderId: id,
			workspaceId: input.workspaceId,
			channel: input.channel
		};
		const suppress = (retryAt: string | null = null) => ({
			...envelope,
			deliver: false as const,
			retryAt,
			destination: null,
			content: null
		});
		if (!reminderDeliveryEnabled()) return suppress();
		const delivery = await this.prisma.reminderDelivery.findUnique({
			where: { id }
		});
		if (
			!delivery ||
			delivery.id !== input.eventId ||
			delivery.workspaceId !== input.workspaceId ||
			delivery.channel !== input.channel ||
			delivery.status !== 'PENDING'
		)
			return suppress();
		const [task, row] = await Promise.all([
			this.prisma.salesTask.findUnique({
				where: { id: delivery.taskId },
				include: { deal: true }
			}),
			this.prisma.reminderRule.findUnique({
				where: { id: delivery.ruleId }
			})
		]);
		if (
			!task ||
			!row ||
			!active(task) ||
			task.workspaceId !== delivery.workspaceId ||
			row.workspaceId !== delivery.workspaceId ||
			(delivery.assignmentVersion != null
				? task.assignmentVersion !== delivery.assignmentVersion
				: task.version !== delivery.taskVersion) ||
			row.version !== delivery.ruleVersion ||
			row.archivedAt
		)
			return suppress();
		const rule = config(row);
		const occurrence = taskOccurrence(rule, row, task);
		const recipient: ReminderBinding = {
			subject: delivery.recipientSubject,
			membershipId: delivery.recipientMembershipId
		};
		if (
			!rule.enabled ||
			!rule.channels.includes(input.channel) ||
			(rule.trigger.kind === 'ASSIGNED') !==
				(delivery.assignmentVersion != null) ||
			!occurrence ||
			occurrence.index !== delivery.occurrenceIndex ||
			occurrence.nominalAt.getTime() !== delivery.nominalAt.getTime() ||
			(rule.scope === 'PERSONAL' &&
				!sameBinding(rule.ownerBinding, recipient))
		)
			return suppress();
		const proof = await this.recipients.read(
			task.workspaceId,
			rule,
			authority(task),
			recipient
		);
		if (!proof.allowed || proof.items.length !== 1) return suppress();
		const current = await this.prisma.$transaction(
			async tx => {
				const [latestTask, latestRule, latestDelivery] = await Promise.all(
					[
						tx.salesTask.findUnique({
							where: { id: task.id },
							include: { deal: true }
						}),
						tx.reminderRule.findUnique({ where: { id: row.id } }),
						tx.reminderDelivery.findUnique({ where: { id } })
					]
				);
				return (
					latestTask &&
					latestRule &&
					latestDelivery?.status === 'PENDING' &&
					active(latestTask) &&
					taskFingerprint(latestTask) === taskFingerprint(task) &&
					latestRule.version === row.version &&
					!latestRule.archivedAt &&
					config(latestRule).enabled
				);
			},
			{ isolationLevel: 'RepeatableRead' }
		);
		if (!current) return suppress();
		const latest = taskOccurrence(rule, row, task);
		if (!latest || latest.index !== delivery.occurrenceIndex)
			return suppress();
		const allowedAt = quietUntil(rule, Date.now());
		if (allowedAt > Date.now())
			return suppress(new Date(allowedAt).toISOString());
		const item = proof.items[0];
		if (input.channel === 'EMAIL' ? !item.email : !item.telegramChatId)
			return suppress();
		return {
			...envelope,
			deliver: true as const,
			schemaVersion:
				rule.trigger.kind === 'ASSIGNED' ? (2 as const) : (1 as const),
			retryAt: null,
			destination: {
				email: input.channel === 'EMAIL' ? item.email : null,
				telegramChatId:
					input.channel === 'TELEGRAM' ? item.telegramChatId : null
			},
			content: {
				...(rule.trigger.kind === 'ASSIGNED'
					? { trigger: 'ASSIGNED' as const }
					: {}),
				taskId: task.id,
				title: task.title,
				dueAt: task.dueAt.toISOString(),
				timeZone: rule.timeZone
			}
		};
	}
}
