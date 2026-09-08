import {
	BadRequestException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import {
	intakeSlaEnabled,
	parseSlaRule,
	slaBinding,
	slaKeys,
	slaRecord,
	slaUuid
} from './sla.contract';
import { SlaRecipientsClient } from './sla-recipients.client';

@Injectable()
export class SlaDeliveryService {
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly recipients: SlaRecipientsClient
	) {}
	async context(notificationId: string, input: unknown) {
		if (
			!slaUuid(notificationId) ||
			!slaRecord(input) ||
			!slaKeys(input, [
				'schemaVersion',
				'eventId',
				'workspaceId',
				'channel'
			]) ||
			input.schemaVersion !== 1 ||
			input.eventId !== notificationId ||
			!slaUuid(input.workspaceId) ||
			!['EMAIL', 'TELEGRAM'].includes(String(input.channel))
		)
			throw new BadRequestException(
				'Invalid Intake SLA delivery context request'
			);
		const workspaceId = input.workspaceId,
			channel = input.channel as 'EMAIL' | 'TELEGRAM';
		const base = {
			schemaVersion: 1,
			eventId: notificationId,
			notificationId,
			workspaceId,
			channel
		};
		const unavailable = {
			...base,
			deliver: false,
			destination: null,
			content: null
		};
		if (!intakeSlaEnabled()) return unavailable;
		const snapshot = await this.snapshot(
			notificationId,
			workspaceId,
			channel
		);
		if (!snapshot) return unavailable;
		const { notification, job, entry, rule } = snapshot,
			config = parseSlaRule(rule.config);
		if (!slaBinding(rule.ownerBinding))
			throw new ServiceUnavailableException(
				'Intake SLA rule authority is unavailable'
			);
		const proof = await this.recipients.read(
			workspaceId,
			rule.ownerBinding,
			config,
			{
				id: entry.id,
				createdBySubject: entry.createdBySubject,
				teamId: entry.teamId
			},
			{
				subject: notification.recipientSubject,
				membershipId: notification.recipientMembershipId
			}
		);
		if (!proof.allowed || !proof.items.length) return unavailable;
		// The external authority check must not revive an accepted entry or superseded rule.
		const current = await this.snapshot(
			notificationId,
			workspaceId,
			channel
		);
		if (!current) return unavailable;
		if (!isDeepStrictEqual(snapshot, current))
			throw new ServiceUnavailableException(
				'Intake SLA changed during authorization'
			);
		const recipient = proof.items[0],
			address =
				channel === 'EMAIL' ? recipient.email : recipient.telegramChatId;
		if (!address) return unavailable;
		return {
			...base,
			deliver: true,
			destination: {
				email: channel === 'EMAIL' ? address : null,
				telegramChatId: channel === 'TELEGRAM' ? address : null
			},
			content: {
				entryId: entry.id,
				title: entry.title,
				dueAt: job.dueAt.toISOString(),
				timeZone: config.timeZone
			}
		};
	}
	private snapshot(id: string, workspaceId: string, channel: string) {
		return this.prisma.$transaction(
			async tx => {
				const notification = await tx.slaNotification.findFirst({
					where: { id, workspaceId, channel }
				});
				if (!notification) return null;
				const job = await tx.slaJob.findFirst({
					where: { id: notification.jobId, workspaceId }
				});
				if (
					!job ||
					!job.breachedAt ||
					['CANCELLED', 'DEAD'].includes(job.status)
				)
					return null;
				const entry = await tx.inboxEntry.findFirst({
					where: { id: job.entryId, workspaceId }
				});
				if (
					!entry ||
					entry.status !== 'NEW' ||
					(await tx.acceptance.findFirst({
						where: { workspaceId, entryId: entry.id },
						select: { id: true }
					}))
				)
					return null;
				const rule = await tx.slaRule.findUnique({
					where: { workspaceId }
				});
				if (
					!rule?.enabled ||
					rule.version !== job.ruleVersion ||
					entry.receivedAt < rule.effectiveAt ||
					!parseSlaRule(rule.config).channels.includes(
						channel as 'EMAIL' | 'TELEGRAM'
					)
				)
					return null;
				return { notification, job, entry, rule };
			},
			{ isolationLevel: 'RepeatableRead' }
		);
	}
}
