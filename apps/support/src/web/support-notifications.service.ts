import {
	BadRequestException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	SupportConversation,
	SupportNotificationSettings
} from '@prisma/support-client';
import { randomUUID } from 'node:crypto';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportWebIdentityClient } from './support-web-identity.client';
import { hashSupport } from './support-web.util';

export const SUPPORT_NOTIFICATION_KINDS = [
	'support-team-email',
	'support-team-telegram',
	'support-client-email'
] as const;
export type SupportNotificationKind =
	(typeof SUPPORT_NOTIFICATION_KINDS)[number];
export const SUPPORT_NOTIFICATION_EVENTS: Record<
	SupportNotificationKind,
	string
> = {
	'support-team-email': 'notification.support.team.email.requested.v1',
	'support-team-telegram':
		'notification.support.team.telegram.requested.v1',
	'support-client-email': 'notification.support.client.email.requested.v1'
};
export const SUPPORT_OUTCOME_EVENT =
	'support.notification.delivery.outcome.v1';
export const SUPPORT_OUTCOME_QUEUE =
	'winwidget.support.notification-outcomes.v1';
export const SUPPORT_OUTCOME_CONSUMER = 'support-notification-outcome';

@Injectable()
export class SupportNotificationsService {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly identity: SupportWebIdentityClient
	) {}
	async settings(
		tx: Prisma.TransactionClient = this.prisma
	): Promise<SupportNotificationSettings> {
		return tx.supportNotificationSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}
	serializeSettings(value: SupportNotificationSettings) {
		return {
			version: value.version,
			enabled: value.enabled,
			emailEnabled: value.emailEnabled,
			staffEmails: value.staffEmails,
			telegramEnabled: value.telegramEnabled,
			telegramChatId: value.telegramChatId,
			telegramThreadId: value.telegramThreadId,
			telegramBot: 'SUPPORT' as const,
			clientEmailEnabled: value.clientEmailEnabled
		};
	}
	async enqueue(
		tx: Prisma.TransactionClient,
		conversation: SupportConversation,
		notificationType:
			| 'NEW_CONVERSATION'
			| 'CLIENT_MESSAGE'
			| 'OPERATOR_REPLY'
	): Promise<void> {
		const settings = await this.settings(tx);
		if (!settings.enabled) return;
		const rows = await tx.$queryRaw<
			Array<{ windowAt: Date; dueAt: Date }>
		>(
			Prisma.sql`SELECT to_timestamp(floor(extract(epoch from transaction_timestamp())/60)*60) AS "windowAt",to_timestamp((floor(extract(epoch from transaction_timestamp())/60)+1)*60) AS "dueAt"`
		);
		const { windowAt, dueAt } = rows[0];
		const targets: Array<{
			kind: SupportNotificationKind;
			email?: string;
			subject?: string;
			chatId?: string;
			threadId?: number;
		}> = [];
		if (notificationType === 'OPERATOR_REPLY') {
			if (settings.clientEmailEnabled)
				targets.push({
					kind: 'support-client-email',
					subject: conversation.authorSubject
				});
		} else {
			if (settings.emailEnabled)
				for (const email of settings.staffEmails)
					targets.push({ kind: 'support-team-email', email });
			if (
				settings.telegramEnabled &&
				settings.telegramChatId &&
				settings.telegramThreadId
			)
				targets.push({
					kind: 'support-team-telegram',
					chatId: settings.telegramChatId,
					threadId: settings.telegramThreadId
				});
		}
		for (const target of targets) {
			const groupKey = hashSupport([
				conversation.id,
				target,
				settings.version,
				windowAt.toISOString()
			]);
			const existing = await tx.supportNotificationIntent.findUnique({
				where: { groupKey }
			});
			if (existing) {
				await tx.supportNotificationIntent.update({
					where: { id: existing.id },
					data: { lastSequence: conversation.lastSequence }
				});
				continue;
			}
			const eventId = randomUUID();
			const intentId = randomUUID();
			const eventType = SUPPORT_NOTIFICATION_EVENTS[target.kind];
			await tx.supportNotificationIntent.create({
				data: {
					id: intentId,
					eventId,
					conversationId: conversation.id,
					kind: target.kind,
					notificationType,
					recipientSubject: target.subject ?? null,
					recipientEmail: target.email ?? null,
					telegramChatId: target.chatId ?? null,
					telegramThreadId: target.threadId ?? null,
					settingsVersion: settings.version,
					groupKey,
					firstSequence: conversation.lastSequence,
					lastSequence: conversation.lastSequence,
					windowAt
				}
			});
			await tx.outboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `support-notification:${intentId}`,
					eventType,
					routingKey: eventType,
					availableAt: dueAt,
					aggregateType: 'support.notification',
					aggregateId: intentId,
					payload: {
						schemaVersion: 1,
						eventId,
						eventType,
						occurredAt: new Date().toISOString(),
						reference: { type: 'support-notification', id: intentId }
					}
				}
			});
		}
	}
	async deliveryContext(
		intentId: string,
		eventId: string,
		kind: SupportNotificationKind
	) {
		const intent = await this.prisma.supportNotificationIntent.findUnique({
			where: { id: intentId },
			include: { conversation: true }
		});
		if (!intent || intent.eventId !== eventId || intent.kind !== kind)
			throw new NotFoundException('Support notification not found');
		const base = { schemaVersion: 1 as const, eventId, intentId, kind };
		const skip = (
			reason:
				| 'RECIPIENT_UNAVAILABLE'
				| 'CHANNEL_DISABLED'
				| 'INTENT_CANCELLED'
		) => ({
			...base,
			deliver: false as const,
			destination: null,
			content: null,
			reason
		});
		const settings = await this.settings();
		if (intent.settingsVersion !== settings.version)
			return skip('INTENT_CANCELLED');
		if (!settings.enabled) return skip('CHANNEL_DISABLED');
		let destination:
			| { email: string }
			| {
					bot: 'SUPPORT';
					telegramChatId: string;
					messageThreadId: number;
			  };
		if (kind === 'support-client-email') {
			if (!settings.clientEmailEnabled) return skip('CHANNEL_DISABLED');
			const recipient = await this.identity.recipient(
				intent.recipientSubject!
			);
			if (!recipient.active || !recipient.verifiedEmail)
				return skip('RECIPIENT_UNAVAILABLE');
			destination = { email: recipient.verifiedEmail };
		} else if (kind === 'support-team-email') {
			if (!settings.emailEnabled) return skip('CHANNEL_DISABLED');
			if (
				!intent.recipientEmail ||
				!settings.staffEmails.includes(intent.recipientEmail)
			)
				return skip('INTENT_CANCELLED');
			destination = { email: intent.recipientEmail };
		} else {
			if (!settings.telegramEnabled) return skip('CHANNEL_DISABLED');
			if (
				!intent.telegramChatId ||
				!intent.telegramThreadId ||
				intent.telegramChatId !== settings.telegramChatId ||
				intent.telegramThreadId !== settings.telegramThreadId
			)
				return skip('INTENT_CANCELLED');
			destination = {
				bot: 'SUPPORT',
				telegramChatId: intent.telegramChatId,
				messageThreadId: intent.telegramThreadId
			};
		}
		return {
			...base,
			deliver: true as const,
			destination,
			content: {
				conversationId: intent.conversationId,
				conversationNumber: intent.conversation.number,
				notificationType: intent.notificationType
			},
			reason: null
		};
	}
	validateSettings(value: {
		enabled: boolean;
		emailEnabled: boolean;
		staffEmails: string[];
		telegramEnabled: boolean;
		telegramChatId: string | null;
		telegramThreadId: number | null;
	}): void {
		if (value.emailEnabled && !value.staffEmails.length)
			throw new BadRequestException('Укажите служебный email');
		if (
			value.telegramEnabled &&
			(!value.telegramChatId || !value.telegramThreadId)
		)
			throw new BadRequestException('Укажите Telegram-группу и тему');
		if (Boolean(value.telegramChatId) !== Boolean(value.telegramThreadId))
			throw new BadRequestException(
				'Группа и тема должны быть указаны вместе'
			);
	}
}
