import { DailySummaryRequestedEventPayload } from '@/messaging/daily-summary-event';
import {
	LeadIntegrationEventPayload,
	ResolvedLeadIntegrationEventPayload
} from '@/messaging/lead-integration-event';
import { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import { MailingDeliveryEventPayload } from '@/messaging/mailing-delivery-event';
import {
	CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS,
	MonolithIntegrationKind
} from '@/messaging/messaging.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	CampaignEmailNotificationRequestedEventPayload,
	CampaignTelegramNotificationRequestedEventPayload,
	NotificationDeliveryOutcomeEventPayload,
	serializeNotificationDeliveryEvent
} from '@/messaging/notification-delivery-event';
import { TelegramDestinationUnavailableEventPayload } from '@/messaging/telegram-destination-unavailable-event';
import { PrismaService } from '@/prisma.service';
import { DailySummaryDeliveryService } from '@/reports/daily-summary-delivery.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import { SCHEDULED_JOB_TYPES } from '@/scheduled-jobs/scheduled-jobs.types';
import { Injectable } from '@nestjs/common';
import {
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus,
	Prisma,
	SubscriptionExpiryReminderStatus
} from '@prisma/client';

type DeliveryEventPayload =
	| LeadIntegrationEventPayload
	| MailingDeliveryEventPayload
	| TelegramDestinationUnavailableEventPayload
	| NotificationDeliveryOutcomeEventPayload
	| DailySummaryRequestedEventPayload;

interface MailingDeliveryOutcomeRow {
	id: string;
	campaignId: string;
	status: MailingDeliveryStatus;
}

@Injectable()
export class IntegrationDeliveryService {
	constructor(
		private readonly safeOutboundHttpService: SafeOutboundHttpService,
		private readonly prisma: PrismaService,
		private readonly dailySummaryDelivery: DailySummaryDeliveryService,
		private readonly leadDestination: LeadIntegrationDestinationService,
		private readonly scheduledJobs: ScheduledJobsService
	) {}

	async deliver(
		kind: MonolithIntegrationKind,
		event: DeliveryEventPayload,
		eventId: string
	): Promise<void> {
		if (kind === 'daily-summary-telegram') {
			await this.dailySummaryDelivery.deliver(
				event as DailySummaryRequestedEventPayload,
				eventId
			);
			return;
		}
		if (kind === 'telegram-destination-unavailable') {
			await this.applyTelegramDestinationUnavailable(
				event as TelegramDestinationUnavailableEventPayload
			);
			return;
		}
		if (kind === 'notification-delivery-outcome') {
			await this.applyNotificationDeliveryOutcome(
				event as NotificationDeliveryOutcomeEventPayload
			);
			return;
		}
		if (kind === 'mailing-email' || kind === 'mailing-telegram') {
			await this.dispatchMailingDelivery(kind, event, eventId);
			return;
		}

		const leadEvent = await this.leadDestination.resolve(
			eventId,
			event as LeadIntegrationEventPayload
		);
		if (leadEvent.integration !== kind) {
			throw new Error(
				`Integration mismatch: queue=${kind}, payload=${leadEvent.integration}`
			);
		}

		switch (kind) {
			case 'webhook':
				await this.sendWebhook(leadEvent, eventId);
				return;
			case 'bitrix24':
				await this.sendBitrix24(leadEvent);
				return;
			case 'amo-crm':
				await this.sendAmoCrm(leadEvent);
				return;
		}
	}

	private async applyTelegramDestinationUnavailable(
		event: TelegramDestinationUnavailableEventPayload
	): Promise<void> {
		const occurredAt = new Date(event.occurredAt);
		await this.prisma.telegramNotificationChannel.updateMany({
			where: {
				chatId: event.destination.telegramChatId,
				isActive: true,
				updatedAt: { lte: occurredAt }
			},
			data: {
				isActive: false,
				disabledAt: occurredAt
			}
		});
	}

	private async dispatchMailingDelivery(
		kind: 'mailing-email' | 'mailing-telegram',
		event: DeliveryEventPayload,
		eventId: string
	): Promise<void> {
		const payload = event as MailingDeliveryEventPayload;
		const expectedChannel =
			kind === 'mailing-email'
				? MailingDeliveryChannel.EMAIL
				: MailingDeliveryChannel.TELEGRAM;
		if (
			payload?.schemaVersion !== 1 ||
			payload?.eventType !== 'mailing.delivery.requested.v1' ||
			!payload.campaignId ||
			!payload.deliveryId ||
			payload.channel !== expectedChannel
		) {
			throw new Error('Invalid mailing delivery event payload');
		}

		const delivery = await this.prisma.mailingDelivery.findUnique({
			where: { id: payload.deliveryId },
			include: { campaign: true }
		});
		if (!delivery || delivery.campaignId !== payload.campaignId) {
			throw new Error('Mailing delivery not found');
		}
		if (delivery.status === MailingDeliveryStatus.FAILED) {
			throw new Error('Mailing delivery is in FAILED state');
		}
		if (
			delivery.status === MailingDeliveryStatus.SENT ||
			delivery.status === MailingDeliveryStatus.CANCELLED ||
			delivery.status === MailingDeliveryStatus.PROCESSING
		) {
			return;
		}
		if (
			delivery.campaign.status === MailingCampaignStatus.CANCELLED ||
			delivery.campaign.cancelRequestedAt
		) {
			await this.cancelPendingMailingDelivery(
				delivery.id,
				delivery.campaignId
			);
			return;
		}

		const notificationKind =
			expectedChannel === MailingDeliveryChannel.EMAIL
				? ('campaign-email' as const)
				: ('campaign-telegram' as const);
		const notificationPayload:
			| CampaignEmailNotificationRequestedEventPayload
			| CampaignTelegramNotificationRequestedEventPayload =
			expectedChannel === MailingDeliveryChannel.EMAIL
				? {
						schemaVersion: 1,
						eventType: CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
						reference: {
							type: 'mailing-delivery',
							id: delivery.id,
							aggregateId: delivery.campaignId
						},
						destination: { email: delivery.recipient },
						content: {
							subject: delivery.campaign.subject,
							message: delivery.campaign.message
						}
					}
				: {
						schemaVersion: 1,
						eventType: CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
						reference: {
							type: 'mailing-delivery',
							id: delivery.id,
							aggregateId: delivery.campaignId
						},
						destination: {
							telegramChatId: delivery.recipient
						},
						content: {
							subject: delivery.campaign.subject,
							message: delivery.campaign.message
						}
					};

		const claimed = await this.prisma.$transaction(async transaction => {
			const result = await transaction.mailingDelivery.updateMany({
				where: {
					id: delivery.id,
					campaignId: delivery.campaignId,
					status: MailingDeliveryStatus.PENDING
				},
				data: {
					status: MailingDeliveryStatus.PROCESSING,
					attempts: { increment: 1 },
					lastError: null
				}
			});
			if (result.count !== 1) return false;
			await transaction.mailingCampaign.updateMany({
				where: {
					id: delivery.campaignId,
					status: MailingCampaignStatus.QUEUED
				},
				data: {
					status: MailingCampaignStatus.RUNNING,
					startedAt: new Date()
				}
			});
			await transaction.outboxEvent.createMany({
				data: [
					{
						messageId: eventId,
						deduplicationKey: `notification-dispatch:${eventId}:${notificationKind}:v1`,
						eventType: notificationPayload.eventType,
						routingKey: MESSAGING_ROUTING_KEYS[notificationKind],
						payload: serializeNotificationDeliveryEvent(
							notificationPayload
						),
						headers: createMessagingHeaders({
							messageId: eventId,
							causationId: eventId
						})
					}
				],
				skipDuplicates: true
			});
			return true;
		});
		if (!claimed) {
			const current = await this.prisma.mailingDelivery.findUnique({
				where: { id: delivery.id },
				select: { status: true }
			});
			if (
				current?.status === MailingDeliveryStatus.SENT ||
				current?.status === MailingDeliveryStatus.CANCELLED ||
				current?.status === MailingDeliveryStatus.PROCESSING
			) {
				return;
			}
			throw new Error('Mailing delivery could not be claimed');
		}
	}

	private async applyNotificationDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		switch (event.reference.type) {
			case 'mailing-delivery':
				await this.applyMailingDeliveryOutcome(event);
				return;
			case 'daily-summary-job':
				await this.applyDailySummaryDeliveryOutcome(event);
				return;
			case 'subscription-expiry-reminder':
				await this.applySubscriptionExpiryDeliveryOutcome(event);
				return;
		}
	}

	private async applyMailingDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		if (
			event.reference.type !== 'mailing-delivery' ||
			(event.sourceKind !== 'campaign-email' &&
				event.sourceKind !== 'campaign-telegram')
		) {
			throw new Error('Invalid mailing delivery outcome');
		}
		const reference = event.reference;
		await this.prisma.$transaction(async transaction => {
			const rows = await transaction.$queryRaw<
				MailingDeliveryOutcomeRow[]
			>(
				Prisma.sql`
					SELECT
						"id",
						"campaign_id" AS "campaignId",
						"status"
					FROM "mailing_deliveries"
						WHERE "id" = ${reference.id}::uuid
					FOR UPDATE
				`
			);
			const delivery = rows[0];
			if (!delivery || delivery.campaignId !== reference.aggregateId) {
				throw new Error('Mailing delivery outcome reference not found');
			}

			let campaign;
			if (event.status === 'FAILED') {
				if (delivery.status !== MailingDeliveryStatus.PROCESSING) return;
				await transaction.mailingDelivery.update({
					where: { id: delivery.id },
					data: {
						status: MailingDeliveryStatus.FAILED,
						lastError: this.getOutcomeError(event),
						sentAt: null
					}
				});
				campaign = await transaction.mailingCampaign.update({
					where: { id: delivery.campaignId },
					data: { failedCount: { increment: 1 } }
				});
			} else {
				if (
					delivery.status !== MailingDeliveryStatus.PROCESSING &&
					delivery.status !== MailingDeliveryStatus.FAILED
				) {
					return;
				}
				await transaction.mailingDelivery.update({
					where: { id: delivery.id },
					data: {
						status: MailingDeliveryStatus.SENT,
						sentAt: new Date(event.occurredAt),
						lastError: null
					}
				});
				campaign = await transaction.mailingCampaign.update({
					where: { id: delivery.campaignId },
					data: {
						sentCount: { increment: 1 },
						...(delivery.status === MailingDeliveryStatus.FAILED
							? { failedCount: { decrement: 1 } }
							: {})
					}
				});
			}

			const pending = await transaction.mailingDelivery.count({
				where: {
					campaignId: delivery.campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				}
			});
			if (pending !== 0) return;
			await transaction.mailingCampaign.updateMany({
				where: {
					id: delivery.campaignId,
					status: { not: MailingCampaignStatus.CANCELLED }
				},
				data: {
					status:
						campaign.failedCount > 0
							? MailingCampaignStatus.PARTIAL_FAILED
							: MailingCampaignStatus.COMPLETED,
					completedAt: new Date()
				}
			});
		});
	}

	private async applyDailySummaryDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		if (
			event.reference.type !== 'daily-summary-job' ||
			event.sourceKind !== 'daily-summary-delivery-telegram'
		) {
			throw new Error('Invalid daily summary delivery outcome');
		}
		await this.prisma.$transaction(async transaction => {
			if (event.status === 'FAILED') {
				await this.scheduledJobs.failExternalDeliveryInTransaction(
					transaction,
					event.reference.id,
					event.sourceEventId,
					this.getOutcomeError(event)
				);
				return;
			}

			const job =
				await this.scheduledJobs.completeExternalDeliveryInTransaction(
					transaction,
					event.reference.id,
					event.sourceEventId,
					{
						telegramSent: true,
						sentAt: event.occurredAt
					}
				);
			if (!job) return;
			if (
				job.jobType !== SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY ||
				!job.periodStart
			) {
				throw new Error('Daily summary outcome references an invalid job');
			}
			await transaction.telegramBotSettings.update({
				where: { id: 'singleton' },
				data: {
					dailySummaryLastSentPeriodStart: new Date(job.periodStart),
					dailySummaryLastSentAt: new Date(event.occurredAt)
				}
			});
		});
	}

	private async applySubscriptionExpiryDeliveryOutcome(
		event: NotificationDeliveryOutcomeEventPayload
	): Promise<void> {
		if (
			event.reference.type !== 'subscription-expiry-reminder' ||
			(event.sourceKind !== 'subscription-expiry-email' &&
				event.sourceKind !== 'subscription-expiry-telegram')
		) {
			throw new Error('Invalid subscription expiry delivery outcome');
		}
		if (event.status === 'FAILED') {
			await this.prisma.subscriptionExpiryReminder.updateMany({
				where: {
					id: event.reference.id,
					status: SubscriptionExpiryReminderStatus.PROCESSING
				},
				data: {
					status: SubscriptionExpiryReminderStatus.FAILED,
					lockedAt: null,
					lockedBy: null,
					lastError: this.getOutcomeError(event)
				}
			});
			return;
		}
		await this.prisma.subscriptionExpiryReminder.updateMany({
			where: {
				id: event.reference.id,
				status: {
					in: [
						SubscriptionExpiryReminderStatus.PROCESSING,
						SubscriptionExpiryReminderStatus.FAILED
					]
				}
			},
			data: {
				status: SubscriptionExpiryReminderStatus.SENT,
				sentAt: new Date(event.occurredAt),
				lockedAt: null,
				lockedBy: null,
				lastError: null
			}
		});
	}

	private getOutcomeError(
		event: NotificationDeliveryOutcomeEventPayload
	): string {
		if (event.status !== 'FAILED' || !event.failure) {
			throw new Error('Failed notification outcome is missing failure');
		}
		return `${event.failure.normalizedCode}: ${event.failure.safeReason}`.slice(
			0,
			10_000
		);
	}

	private async cancelPendingMailingDelivery(
		deliveryId: string,
		campaignId: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const updated = await transaction.mailingDelivery.updateMany({
				where: {
					id: deliveryId,
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				},
				data: {
					status: MailingDeliveryStatus.CANCELLED,
					cancelledAt: new Date()
				}
			});
			if (updated.count !== 1) return;
			await transaction.mailingCampaign.update({
				where: { id: campaignId },
				data: { cancelledCount: { increment: 1 } }
			});
		});
	}

	private async sendWebhook(
		event: ResolvedLeadIntegrationEventPayload,
		eventId: string
	): Promise<void> {
		const destination = event.destination.webhookUrl;
		if (!destination) throw new Error('Webhook destination is missing');

		await this.safeOutboundHttpService.postJson(
			destination,
			{
				eventId,
				eventType: 'lead.created.v1',
				source: event.source,
				entity: event.entity,
				lead: event.lead
			},
			{
				policy: 'webhook',
				headers: {
					'X-WinWidget-Event-Id': eventId
				}
			}
		);
	}

	private async sendBitrix24(
		event: ResolvedLeadIntegrationEventPayload
	): Promise<void> {
		const webhookUrl = event.destination.bitrix24WebhookUrl;
		if (!webhookUrl) throw new Error('Bitrix24 webhook URL is missing');

		const fields: Record<string, unknown> = {
			TITLE: this.buildLeadTitle(event),
			SOURCE_ID: 'WEB',
			COMMENTS: this.buildComments(event)
		};
		if (event.lead.name) fields.NAME = event.lead.name;
		if (event.lead.phone) {
			fields.PHONE = [{ VALUE: event.lead.phone, VALUE_TYPE: 'WORK' }];
		}
		if (event.lead.email) {
			fields.EMAIL = [{ VALUE: event.lead.email, VALUE_TYPE: 'WORK' }];
		}

		const base = webhookUrl.replace(/\/$/, '');
		await this.safeOutboundHttpService.postJson(
			`${base}/crm.lead.add.json`,
			{ fields },
			{ policy: 'bitrix24' }
		);
	}

	private async sendAmoCrm(
		event: ResolvedLeadIntegrationEventPayload
	): Promise<void> {
		const domain = event.destination.amoCrmDomain;
		const token = event.destination.amoCrmToken;
		if (!domain || !token) {
			throw new Error('amoCRM destination is incomplete');
		}

		const contactFields: Array<Record<string, unknown>> = [];
		if (event.lead.phone) {
			contactFields.push({
				field_code: 'PHONE',
				values: [{ value: event.lead.phone, enum_code: 'WORK' }]
			});
		}
		if (event.lead.email) {
			contactFields.push({
				field_code: 'EMAIL',
				values: [{ value: event.lead.email, enum_code: 'WORK' }]
			});
		}

		const contact = {
			...(event.lead.name ? { first_name: event.lead.name } : {}),
			...(contactFields.length
				? { custom_fields_values: contactFields }
				: {})
		};

		await this.safeOutboundHttpService.postJson(
			this.safeOutboundHttpService.getAmoCrmApiUrl(domain),
			[
				{
					name: this.buildLeadTitle(event),
					_embedded: { contacts: [contact] },
					custom_fields_values: [
						{
							field_code: 'DESCRIPTION',
							values: [{ value: this.buildComments(event) }]
						}
					]
				}
			],
			{
				policy: 'amo-crm',
				headers: { Authorization: `Bearer ${token}` }
			}
		);
	}

	private buildLeadTitle(
		event: ResolvedLeadIntegrationEventPayload
	): string {
		const outcome = this.getOutcome(event);
		return `Заявка с виджета «${event.entity.name}»${
			outcome ? ` — ${outcome}` : ''
		}`;
	}

	private buildComments(
		event: ResolvedLeadIntegrationEventPayload
	): string {
		const detail = this.getDetail(event);
		return [
			`${this.getSourceLabel(event)}: ${event.entity.name}`,
			event.lead.contact ? `Контакт: ${event.lead.contact}` : '',
			this.getOutcome(event) ? `Результат: ${this.getOutcome(event)}` : '',
			detail ? `${detail.label}: ${detail.value}` : '',
			event.lead.timeSlot ? `Время: ${event.lead.timeSlot}` : '',
			event.lead.timezone ? `Часовой пояс: ${event.lead.timezone}` : '',
			event.lead.url ? `Страница: ${event.lead.url}` : ''
		]
			.filter(Boolean)
			.join('\n');
	}

	private getOutcome(
		event: ResolvedLeadIntegrationEventPayload
	): string | null {
		return (
			event.lead.bonus ||
			event.lead.result ||
			(event.lead.calculatedPrice
				? `${event.lead.calculatedPrice} ${event.lead.currency || ''}`.trim()
				: null)
		);
	}

	private getDetail(
		event: ResolvedLeadIntegrationEventPayload
	): { label: string; value: string } | null {
		if (event.lead.actionLabel && event.lead.actionValue) {
			return {
				label: event.lead.actionLabel,
				value: event.lead.actionValue
			};
		}
		if (event.lead.timeSlot) {
			return {
				label: 'Желаемое время',
				value: [
					event.lead.timeSlot,
					event.lead.timezone ? `(${event.lead.timezone})` : ''
				]
					.filter(Boolean)
					.join(' ')
			};
		}
		return null;
	}

	private getSourceLabel(
		event: ResolvedLeadIntegrationEventPayload
	): string {
		const labels: Record<
			ResolvedLeadIntegrationEventPayload['source'],
			string
		> = {
			widget: 'Колесо фортуны',
			quiz: 'Квиз',
			callback: 'Обратный звонок',
			'countdown-timer': 'Таймер',
			'stop-offer': 'Стоп-оффер',
			'online-consultant': 'Онлайн-консультант',
			calculator: 'Калькулятор стоимости'
		};
		return labels[event.source];
	}
}
