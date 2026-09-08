import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { acceptanceHash } from '../acceptance/acceptance.contract';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { SlaRecipientsClient } from './sla-recipients.client';
import {
	parseSlaRule,
	SLA_EMAIL_EVENT,
	SLA_TELEGRAM_EVENT,
	slaBinding,
	type SlaEvent
} from './sla.contract';
import { enqueueSla, slaDatabaseNow } from './sla.service';

export const SLA_CONSUMER = 'crm-intake-sla-evaluate-v1';
export const SLA_RETRY_MS = [30000, 300000, 1800000] as const;
const LEASE_MS = 120000;
export class SlaLeaseLost extends Error {}
const key = (event: SlaEvent) => ({
	eventId_consumer: { eventId: event.eventId, consumer: SLA_CONSUMER }
});
const identity = (event: SlaEvent) => ({
	id: event.jobId,
	workspaceId: event.workspaceId,
	generation: event.generation,
	activeEventId: event.eventId
});

@Injectable()
export class SlaProcessor {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly recipients: SlaRecipientsClient
	) {}
	async claim(
		event: SlaEvent,
		retryAttempt: number
	): Promise<{ state: 'DONE' } | { state: 'CLAIMED'; token: string }> {
		return this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`crm-intake:sla-event:${event.eventId}`},0))`;
			const prior = await tx.slaReceipt.findUnique({ where: key(event) }),
				hash = acceptanceHash(event),
				now = await slaDatabaseNow(tx);
			if (
				prior &&
				(prior.payloadHash !== hash ||
					prior.workspaceId !== event.workspaceId ||
					prior.jobId !== event.jobId)
			)
				throw new ConflictException('SLA event binding changed');
			if (prior && ['DELIVERED', 'DEAD_LETTERED'].includes(prior.status))
				return { state: 'DONE' };
			if (prior && retryAttempt < prior.retryAttempt)
				return { state: 'DONE' };
			if (retryAttempt !== (prior?.retryAttempt ?? 0))
				throw new ConflictException('SLA retry binding changed');
			if (
				prior?.status === 'PROCESSING' &&
				(!prior.leaseUntil || prior.leaseUntil > now)
			)
				throw new SlaLeaseLost();
			const job = await tx.slaJob.findFirst({
				where: { id: event.jobId, workspaceId: event.workspaceId }
			});
			if (!job) throw new ConflictException('SLA job not found');
			const done =
				job.generation !== event.generation ||
				job.activeEventId !== event.eventId ||
				!['PENDING', 'PROCESSING'].includes(job.status);
			if (!done && job.dueAt > now) throw new SlaLeaseLost();
			const token = randomUUID(),
				state = done ? 'DELIVERED' : 'PROCESSING';
			const data = {
				status: state,
				leaseToken: done ? null : token,
				leaseUntil: done ? null : new Date(now.getTime() + LEASE_MS)
			};
			if (prior) {
				const changed = await tx.slaReceipt.updateMany({
					where: {
						eventId: event.eventId,
						consumer: SLA_CONSUMER,
						status: prior.status,
						retryAttempt,
						leaseToken: prior.leaseToken,
						...(prior.status === 'PROCESSING'
							? { leaseUntil: { lte: now } }
							: {})
					},
					data
				});
				if (changed.count !== 1) throw new SlaLeaseLost();
			} else
				await tx.slaReceipt.create({
					data: {
						eventId: event.eventId,
						consumer: SLA_CONSUMER,
						workspaceId: event.workspaceId,
						jobId: event.jobId,
						payloadHash: hash,
						...data
					}
				});
			if (done) return { state: 'DONE' };
			const changed = await tx.slaJob.updateMany({
				where: {
					...identity(event),
					status: { in: ['PENDING', 'PROCESSING'] }
				},
				data: { status: 'PROCESSING' }
			});
			if (changed.count !== 1) throw new SlaLeaseLost();
			return { state: 'CLAIMED', token };
		});
	}
	async renew(event: SlaEvent, token: string) {
		const now = await slaDatabaseNow(this.prisma);
		return (
			(
				await this.prisma.slaReceipt.updateMany({
					where: {
						eventId: event.eventId,
						consumer: SLA_CONSUMER,
						status: 'PROCESSING',
						leaseToken: token,
						leaseUntil: { gt: now }
					},
					data: { leaseUntil: new Date(now.getTime() + LEASE_MS) }
				})
			).count === 1
		);
	}
	async run(event: SlaEvent, token: string) {
		const initialRule = await this.prisma.slaRule.findUnique({
			where: { workspaceId: event.workspaceId }
		});
		if (!initialRule || !slaBinding(initialRule.ownerBinding))
			throw new Error('SLA_RULE_BINDING_INVALID');
		const initialJob = await this.prisma.slaJob.findFirst({
			where: identity(event)
		});
		if (!initialJob) throw new SlaLeaseLost();
		const initialEntry = await this.prisma.inboxEntry.findFirst({
			where: { id: initialJob.entryId, workspaceId: event.workspaceId }
		});
		if (!initialEntry) throw new Error('SLA_ENTRY_UNAVAILABLE');
		const config = parseSlaRule(initialRule.config);
		const proof = await this.recipients.read(
			event.workspaceId,
			initialRule.ownerBinding,
			config,
			{
				id: initialEntry.id,
				createdBySubject: initialEntry.createdBySubject,
				teamId: initialEntry.teamId
			},
			null,
			initialJob.recipientCursor
		);
		return this.prisma.$transaction(async tx => {
			await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
			const job = await tx.slaJob.findFirst({ where: identity(event) });
			if (!job) throw new SlaLeaseLost();
			// Same row locks as acceptance/cancellation; an older evaluation cannot
			// overwrite an accepted entry's cancellation after its transaction commits.
			await tx.$queryRaw`SELECT id FROM crm_intake.inbox_entries WHERE workspace_id=${event.workspaceId}::uuid AND id=${job.entryId}::uuid FOR UPDATE`;
			await tx.$queryRaw`SELECT workspace_id FROM crm_intake.sla_rules WHERE workspace_id=${event.workspaceId}::uuid FOR UPDATE`;
			const rule = await tx.slaRule.findUnique({
				where: { workspaceId: event.workspaceId }
			});
			const entry = await tx.inboxEntry.findFirst({
				where: { id: job.entryId, workspaceId: event.workspaceId }
			});
			const acceptance = await tx.acceptance.findFirst({
				where: { workspaceId: event.workspaceId, entryId: job.entryId },
				select: { id: true }
			});
			const now = await slaDatabaseNow(tx);
			if (
				entry?.status === 'NEW' &&
				!acceptance &&
				entry.version !== initialEntry.version
			)
				throw new SlaLeaseLost();
			const finished = await tx.slaReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: SLA_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now }
				},
				data: { status: 'DELIVERED', leaseToken: null, leaseUntil: null }
			});
			if (finished.count !== 1) throw new SlaLeaseLost();
			const current =
				proof.allowed &&
				rule?.enabled &&
				rule.version === job.ruleVersion &&
				rule.version === initialRule.version &&
				entry?.status === 'NEW' &&
				!acceptance &&
				entry.version === initialEntry.version &&
				job.dueAt <= now;
			if (!current) {
				await tx.slaJob.updateMany({
					where: { ...identity(event), status: 'PROCESSING' },
					data: { status: 'CANCELLED' }
				});
				return;
			}
			const notifications = proof.items.flatMap(item =>
				config.channels.flatMap(channel =>
					(channel === 'EMAIL' ? item.email : item.telegramChatId)
						? [
								{
									id: randomUUID(),
									workspaceId: event.workspaceId,
									jobId: job.id,
									recipientSubject: item.binding.subject,
									recipientMembershipId: item.binding.membershipId,
									channel,
									deduplicationKey: acceptanceHash([
										job.id,
										item.binding.subject,
										item.binding.membershipId,
										channel
									])
								}
							]
						: []
				)
			);
			if (notifications.length) {
				await tx.slaNotification.createMany({
					data: notifications,
					skipDuplicates: true
				});
				const created = await tx.slaNotification.findMany({
					where: { id: { in: notifications.map(item => item.id) } }
				});
				if (created.length)
					await tx.slaOutbox.createMany({
						data: created.map(item => ({
							id: randomUUID(),
							eventId: item.id,
							deduplicationKey: `notification:${item.id}`,
							route: item.channel === 'EMAIL' ? 'ND_EMAIL' : 'ND_TELEGRAM',
							availableAt: now,
							payload: {
								schemaVersion: 1,
								eventId: item.id,
								eventType:
									item.channel === 'EMAIL'
										? SLA_EMAIL_EVENT
										: SLA_TELEGRAM_EVENT,
								occurredAt: item.createdAt.toISOString(),
								reference: {
									type: 'wincrm-intake-sla',
									id: item.id,
									workspaceId: item.workspaceId
								}
							}
						}))
					});
			}
			const nextEventId = proof.nextCursor ? randomUUID() : event.eventId;
			const changed = await tx.slaJob.updateMany({
				where: { ...identity(event), status: 'PROCESSING' },
				data: {
					status: proof.nextCursor ? 'PENDING' : 'BREACHED',
					breachedAt: job.breachedAt ?? now,
					recipientCursor: proof.nextCursor,
					...(proof.nextCursor
						? { generation: { increment: 1 }, activeEventId: nextEventId }
						: {})
				}
			});
			if (changed.count !== 1) throw new SlaLeaseLost();
			if (proof.nextCursor)
				await enqueueSla(
					tx,
					{
						...event,
						eventId: nextEventId,
						generation: event.generation + 1
					},
					now
				);
		});
	}
	async fail(event: SlaEvent, token: string, retryAttempt: number) {
		return this.prisma.$transaction(async tx => {
			const now = await slaDatabaseNow(tx),
				retry = retryAttempt < SLA_RETRY_MS.length;
			const nextAttempt = retry ? retryAttempt + 1 : retryAttempt;
			const changed = await tx.slaReceipt.updateMany({
				where: {
					eventId: event.eventId,
					consumer: SLA_CONSUMER,
					status: 'PROCESSING',
					leaseToken: token,
					leaseUntil: { gt: now },
					retryAttempt
				},
				data: {
					status: retry ? 'RETRY_SCHEDULED' : 'DEAD_LETTERED',
					retryAttempt: nextAttempt,
					leaseToken: null,
					leaseUntil: null
				}
			});
			if (changed.count !== 1) return false;
			await tx.slaJob.updateMany({
				where: { ...identity(event), status: 'PROCESSING' },
				data: { status: retry ? 'PENDING' : 'DEAD' }
			});
			await enqueueSla(
				tx,
				event,
				new Date(now.getTime() + (retry ? SLA_RETRY_MS[retryAttempt] : 0)),
				retry ? 'MAIN' : 'DLQ',
				nextAttempt
			);
			return true;
		});
	}
}
