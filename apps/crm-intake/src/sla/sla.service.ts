import {
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Prisma, type SlaRule } from '@prisma/crm-intake-client';
import { randomUUID } from 'node:crypto';
import { acceptanceHash } from '../acceptance/acceptance.contract';
import {
	assertIntakePermission,
	type IntakeAuthorization
} from '../access/intake-authorization.client';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { SlaAuthorityClient } from './sla-authority.client';
import { SlaReadinessService } from './sla-readiness.service';
import { intakeEntryScope } from '../intake/intake.service';
import { slaDeadline } from './sla-clock';
import {
	parseSlaRule,
	type SlaCommand,
	type SlaEvent
} from './sla.contract';

export async function slaDatabaseNow(
	tx: Pick<Prisma.TransactionClient, '$queryRaw'>
) {
	const [row] = await tx.$queryRaw<
		Array<{ now: Date }>
	>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	if (!row || !Number.isFinite(row.now.getTime()))
		throw new Error('SLA_CLOCK_UNAVAILABLE');
	return row.now;
}
export async function enqueueSla(
	tx: Prisma.TransactionClient,
	event: SlaEvent,
	availableAt: Date,
	route = 'MAIN',
	retryAttempt = 0
) {
	await tx.slaOutbox.createMany({
		data: [
			{
				id: randomUUID(),
				eventId: event.eventId,
				deduplicationKey: `${event.eventId}:${route}:${retryAttempt}`,
				route,
				payload: event as unknown as Prisma.InputJsonObject,
				availableAt,
				retryAttempt
			}
		],
		skipDuplicates: true
	});
}
export function assertSlaManager(
	context: IntakeAuthorization,
	write = false
) {
	assertIntakePermission(
		context,
		write ? 'intake:write' : 'intake:read',
		write
	);
	if (!['OWNER', 'CRM_ADMIN'].includes(context.role))
		throw new ForbiddenException(
			'Only workspace managers can manage Intake SLA'
		);
}
const ruleView = (rule: SlaRule | null) =>
	rule
		? {
				version: rule.version,
				config: parseSlaRule(rule.config),
				effectiveAt: rule.effectiveAt.toISOString()
			}
		: null;

@Injectable()
export class SlaService {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly authority: SlaAuthorityClient,
		private readonly readiness: SlaReadinessService
	) {}
	async read(context: IntakeAuthorization) {
		assertSlaManager(context);
		return {
			schemaVersion: 1,
			workspaceId: context.workspaceId,
			deliveryEnabled: await this.readiness.ready(),
			rule: ruleView(
				await this.prisma.slaRule.findUnique({
					where: { workspaceId: context.workspaceId }
				})
			)
		};
	}
	async save(context: IntakeAuthorization, command: SlaCommand) {
		assertSlaManager(context, true);
		if (context.workspaceId !== command.workspaceId)
			throw new ForbiddenException('Workspace mismatch');
		const deliveryEnabled = await this.readiness.ready();
		if (command.config.enabled && !deliveryEnabled)
			throw new ServiceUnavailableException(
				'Intake SLA delivery is not active'
			);
		const binding = await this.authority.owner(
			context.workspaceId,
			context.subject
		);
		if (!binding)
			throw new ForbiddenException('SLA rule authority is not active');
		const hash = acceptanceHash(command);
		const result = await this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			// Short resource-scoped command lock, not a shared scheduler lock.
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:sla-command:${command.commandId}`},0))`;
			const previous = await tx.slaCommand.findUnique({
				where: { commandId: command.commandId }
			});
			if (previous) {
				if (
					previous.workspaceId !== context.workspaceId ||
					previous.actorSubject !== context.subject ||
					previous.requestHash !== hash ||
					previous.action !== 'RULE_SAVED'
				)
					throw new ConflictException('SLA command conflicts');
				return previous.response;
			}
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:sla-rule:${context.workspaceId}`},0))`;
			const previousRule = await tx.slaRule.findUnique({
				where: { workspaceId: context.workspaceId }
			});
			if ((previousRule?.version ?? 0) !== command.expectedVersion)
				throw new ConflictException('SLA rule changed');
			const now = await slaDatabaseNow(tx),
				version = command.expectedVersion + 1;
			const data = {
				version,
				enabled: command.config.enabled,
				config: command.config as unknown as Prisma.InputJsonObject,
				ownerBinding: binding as unknown as Prisma.InputJsonObject,
				effectiveAt: now
			};
			const rule = await tx.slaRule.upsert({
				where: { workspaceId: context.workspaceId },
				create: { workspaceId: context.workspaceId, ...data },
				update: data
			});
			await tx.slaJob.updateMany({
				where: {
					workspaceId: context.workspaceId,
					status: { not: 'CANCELLED' }
				},
				data: { status: 'CANCELLED' }
			});
			const response = {
				schemaVersion: 1,
				workspaceId: context.workspaceId,
				rule: ruleView(rule)
			};
			await tx.slaCommand.create({
				data: {
					commandId: command.commandId,
					workspaceId: context.workspaceId,
					actorSubject: context.subject,
					action: 'RULE_SAVED',
					entityId: context.workspaceId,
					requestHash: hash,
					response: response as unknown as Prisma.InputJsonObject
				}
			});
			return response;
		});
		return { ...(result as object), deliveryEnabled };
	}
	async inboxStatus(context: IntakeAuthorization, entryIds: string[]) {
		assertIntakePermission(context, 'intake:read');
		const deliveryEnabled = await this.readiness.ready();
		return this.prisma.$transaction(
			async tx => {
				const now = await slaDatabaseNow(tx);
				const entries = await tx.inboxEntry.findMany({
					where: {
						AND: [intakeEntryScope(context), { id: { in: entryIds } }]
					},
					select: { id: true, status: true }
				});
				const ids = entries.map(entry => entry.id);
				const rule = await tx.slaRule.findUnique({
					where: { workspaceId: context.workspaceId }
				});
				const jobs = await tx.slaJob.findMany({
					where: {
						workspaceId: context.workspaceId,
						entryId: { in: ids }
					},
					orderBy: { ruleVersion: 'desc' }
				});
				const accepted = await tx.acceptance.findMany({
					where: {
						workspaceId: context.workspaceId,
						entryId: { in: ids }
					},
					select: { entryId: true }
				});
				const handled = new Set(accepted.map(item => item.entryId));
				return {
					schemaVersion: 1,
					workspaceId: context.workspaceId,
					deliveryEnabled,
					items: entries.map(entry => {
						const job = jobs.find(item => item.entryId === entry.id);
						const stopped =
							!deliveryEnabled ||
							!rule?.enabled ||
							entry.status !== 'NEW' ||
							handled.has(entry.id) ||
							job?.ruleVersion !== rule.version ||
							['CANCELLED', 'DEAD'].includes(job?.status ?? '');
						return {
							entryId: entry.id,
							state: !job
								? 'NOT_TRACKED'
								: stopped
									? 'STOPPED'
									: job.dueAt <= now
										? 'BREACHED'
										: 'PENDING',
							dueAt: job?.dueAt.toISOString() ?? null
						};
					})
				};
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
	/** Bounded owner-DB scan. One job per entry+rule version; no historical backfill,
	 * no missed-period replay and no provider calls. Job and event commit together. */
	async schedule() {
		return this.prisma.$transaction(
			async tx => {
				await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
				await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
				const candidates = await tx.$queryRaw<
					Array<{
						workspaceId: string;
						entryId: string;
						receivedAt: Date;
						version: number;
						config: Prisma.JsonValue;
					}>
				>`
			 SELECT e.workspace_id AS "workspaceId", e.id AS "entryId", e.received_at AS "receivedAt", r.version, r.config
			 FROM crm_intake.inbox_entries e JOIN crm_intake.sla_rules r ON r.workspace_id = e.workspace_id
			 WHERE e.status = 'NEW' AND r.enabled AND e.received_at >= r.effective_at
			 AND NOT EXISTS (SELECT 1 FROM crm_intake.acceptances a WHERE a.workspace_id=e.workspace_id AND a.entry_id=e.id)
			 AND NOT EXISTS (SELECT 1 FROM crm_intake.sla_jobs j WHERE j.workspace_id=e.workspace_id AND j.entry_id=e.id AND j.rule_version=r.version)
			 ORDER BY e.received_at,e.id LIMIT 20 FOR UPDATE OF e,r SKIP LOCKED`;
				for (const row of candidates) {
					const id = randomUUID(),
						eventId = randomUUID(),
						dueAt = slaDeadline(row.receivedAt, parseSlaRule(row.config));
					await tx.slaJob.create({
						data: {
							id,
							workspaceId: row.workspaceId,
							entryId: row.entryId,
							ruleVersion: row.version,
							activeEventId: eventId,
							dueAt
						}
					});
					await enqueueSla(
						tx,
						{
							schemaVersion: 1,
							eventId,
							workspaceId: row.workspaceId,
							jobId: id,
							generation: 1
						},
						dueAt
					);
				}
				return candidates.length;
			},
			{ timeout: 10000 }
		);
	}
	async retry(
		context: IntakeAuthorization,
		jobId: string,
		commandId: string,
		generation: number
	) {
		assertSlaManager(context, true);
		const hash = acceptanceHash({
			jobId,
			generation,
			workspaceId: context.workspaceId,
			commandId
		});
		return this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:sla-command:${commandId}`},0))`;
			const prior = await tx.slaCommand.findUnique({
				where: { commandId }
			});
			if (prior) {
				if (
					prior.workspaceId !== context.workspaceId ||
					prior.actorSubject !== context.subject ||
					prior.requestHash !== hash ||
					prior.action !== 'JOB_RETRIED'
				)
					throw new ConflictException('SLA command conflicts');
				return prior.response;
			}
			const job = await tx.slaJob.findFirst({
				where: { id: jobId, workspaceId: context.workspaceId }
			});
			if (!job) throw new NotFoundException('SLA job not found');
			const eventId = randomUUID(),
				now = await slaDatabaseNow(tx);
			const changed = await tx.slaJob.updateMany({
				where: {
					id: jobId,
					workspaceId: context.workspaceId,
					generation,
					status: 'DEAD'
				},
				data: {
					status: 'PENDING',
					generation: { increment: 1 },
					activeEventId: eventId
				}
			});
			if (changed.count !== 1)
				throw new ConflictException('SLA job is not retryable');
			await enqueueSla(
				tx,
				{
					schemaVersion: 1,
					eventId,
					workspaceId: context.workspaceId,
					jobId,
					generation: generation + 1
				},
				now
			);
			const response = {
				schemaVersion: 1,
				workspaceId: context.workspaceId,
				jobId,
				generation: generation + 1
			};
			await tx.slaCommand.create({
				data: {
					commandId,
					workspaceId: context.workspaceId,
					actorSubject: context.subject,
					action: 'JOB_RETRIED',
					entityId: jobId,
					requestHash: hash,
					response
				}
			});
			return response;
		});
	}
}
