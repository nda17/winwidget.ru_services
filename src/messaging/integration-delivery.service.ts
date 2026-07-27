import { EmailService } from '@/email/email.service';
import { DailySummaryRequestedEventPayload } from '@/messaging/daily-summary-event';
import { classifyIntegrationError } from '@/messaging/integration-error-classifier';
import {
	LeadIntegrationEventPayload,
	ResolvedLeadIntegrationEventPayload
} from '@/messaging/lead-integration-event';
import { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import { LimitReachedTelegramEventPayload } from '@/messaging/limit-reached-event';
import { MailingDeliveryEventPayload } from '@/messaging/mailing-delivery-event';
import {
	MonolithIntegrationKind,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { PaymentSucceededEventPayload } from '@/messaging/payment-succeeded-event';
import { PrismaService } from '@/prisma.service';
import { DailySummaryDeliveryService } from '@/reports/daily-summary-delivery.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { TelegramInfoTransportService } from '@/telegram-bot/telegram-info-transport.service';
import { Injectable, Logger } from '@nestjs/common';
import {
	BillingPeriod,
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus,
	Plan
} from '@prisma/client';

type DeliveryEventPayload =
	| LeadIntegrationEventPayload
	| PaymentSucceededEventPayload
	| MailingDeliveryEventPayload
	| LimitReachedTelegramEventPayload
	| DailySummaryRequestedEventPayload;

const MAILING_PROCESSING_LEASE_MS = 10 * 60 * 1000;

@Injectable()
export class IntegrationDeliveryService {
	private readonly logger = new Logger(IntegrationDeliveryService.name);

	constructor(
		private readonly emailService: EmailService,
		private readonly safeOutboundHttpService: SafeOutboundHttpService,
		private readonly prisma: PrismaService,
		private readonly dailySummaryDelivery: DailySummaryDeliveryService,
		private readonly leadDestination: LeadIntegrationDestinationService,
		private readonly telegram: TelegramInfoTransportService
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
		if (kind === 'payment-telegram') {
			await this.sendPaymentTelegram(this.getPaymentEvent(event));
			return;
		}
		if (kind === 'mailing-email' || kind === 'mailing-telegram') {
			await this.sendMailingDelivery(kind, event, eventId);
			return;
		}
		if (kind === 'limit-telegram') {
			await this.sendLimitReachedTelegram(event);
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

	private getPaymentEvent(
		event: DeliveryEventPayload
	): PaymentSucceededEventPayload {
		const value = event as PaymentSucceededEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== 'payment.succeeded.v1' ||
			!value.payment?.id ||
			!value.payment?.yookassaId ||
			!value.user?.id
		) {
			throw new Error('Invalid payment succeeded event payload');
		}
		return value;
	}

	private async sendMailingDelivery(
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
			delivery.status === MailingDeliveryStatus.CANCELLED
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
		if (delivery.status === MailingDeliveryStatus.PROCESSING) {
			const reclaimed = await this.prisma.mailingDelivery.updateMany({
				where: {
					id: delivery.id,
					campaignId: delivery.campaignId,
					status: MailingDeliveryStatus.PROCESSING,
					updatedAt: {
						equals: delivery.updatedAt,
						lt: new Date(Date.now() - MAILING_PROCESSING_LEASE_MS)
					}
				},
				data: {
					status: MailingDeliveryStatus.PENDING
				}
			});
			if (reclaimed.count !== 1) {
				throw new Error('Mailing delivery is already processing');
			}
		}

		const claimed = await this.prisma.$transaction(async transaction => {
			const result = await transaction.mailingDelivery.updateMany({
				where: {
					id: delivery.id,
					campaignId: delivery.campaignId,
					status: MailingDeliveryStatus.PENDING
				},
				data: {
					status: MailingDeliveryStatus.PROCESSING,
					attempts: { increment: 1 }
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
			return true;
		});
		if (!claimed) {
			const current = await this.prisma.mailingDelivery.findUnique({
				where: { id: delivery.id },
				select: { status: true }
			});
			if (
				current?.status === MailingDeliveryStatus.SENT ||
				current?.status === MailingDeliveryStatus.CANCELLED
			) {
				return;
			}
			throw new Error('Mailing delivery could not be claimed');
		}

		try {
			if (expectedChannel === MailingDeliveryChannel.EMAIL) {
				await this.emailService.sendAdminBroadcast(
					delivery.recipient,
					{
						subject: delivery.campaign.subject,
						message: delivery.campaign.message
					},
					{ messageId: `<${eventId}.mailing@winwidget.ru>` }
				);
			} else {
				await this.sendMailingTelegramMessages(
					delivery.id,
					delivery.campaignId,
					delivery.recipient,
					this.buildTelegramBroadcastMessages(
						delivery.campaign.subject,
						delivery.campaign.message
					),
					delivery.nextChunkIndex
				);
			}

			await this.completeMailingDelivery(delivery.id, delivery.campaignId);
		} catch (error) {
			await this.prisma.mailingDelivery.updateMany({
				where: {
					id: delivery.id,
					campaignId: delivery.campaignId,
					status: MailingDeliveryStatus.PROCESSING
				},
				data: {
					status: MailingDeliveryStatus.PENDING,
					lastError:
						error instanceof Error
							? error.message.slice(0, 10_000)
							: String(error).slice(0, 10_000)
				}
			});
			throw error;
		}
	}

	private async sendLimitReachedTelegram(
		event: DeliveryEventPayload
	): Promise<void> {
		const payload = event as LimitReachedTelegramEventPayload;
		if (
			payload?.schemaVersion !== 2 ||
			payload.eventType !== LIMIT_REACHED_TELEGRAM_EVENT_TYPE ||
			!payload.entity?.id ||
			!payload.entity?.name ||
			!Number.isInteger(payload.limit) ||
			typeof payload.destination?.telegramChatId !== 'string' ||
			!payload.destination.telegramChatId.trim()
		) {
			throw new Error('Invalid limit reached Telegram event payload');
		}
		await this.sendTelegramMessage(
			'limit-telegram',
			payload.destination.telegramChatId,
			[
				[
					'⚠️ <b>Лимит заявок исчерпан</b>',
					`${this.escapeHtml(payload.entity.name)} принял последнюю заявку (${payload.limit} из ${payload.limit}).`,
					'',
					'Новые заявки больше не принимаются.',
					'Для продолжения работы перейдите на платный тариф:',
					'👉 https://winwidget.ru/#pricing'
				].join('\n')
			],
			'HTML'
		);
	}

	private async sendMailingTelegramMessages(
		deliveryId: string,
		campaignId: string,
		chatId: string,
		messages: string[],
		nextChunkIndex: number
	): Promise<void> {
		if (
			!Number.isInteger(nextChunkIndex) ||
			nextChunkIndex < 0 ||
			nextChunkIndex > messages.length
		) {
			throw new Error('Invalid Telegram mailing chunk progress');
		}

		for (let index = nextChunkIndex; index < messages.length; index += 1) {
			await this.sendTelegramMessage('mailing-telegram', chatId, [
				messages[index]
			]);
			const checkpoint = await this.prisma.mailingDelivery.updateMany({
				where: {
					id: deliveryId,
					campaignId,
					status: MailingDeliveryStatus.PROCESSING,
					nextChunkIndex: index
				},
				data: { nextChunkIndex: index + 1 }
			});
			if (checkpoint.count !== 1) {
				throw new Error('Telegram mailing chunk progress was lost');
			}
		}
	}

	private async completeMailingDelivery(
		deliveryId: string,
		campaignId: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const updated = await transaction.mailingDelivery.updateMany({
				where: {
					id: deliveryId,
					status: MailingDeliveryStatus.PROCESSING
				},
				data: {
					status: MailingDeliveryStatus.SENT,
					sentAt: new Date(),
					lastError: null
				}
			});
			if (updated.count !== 1) return;
			const campaign = await transaction.mailingCampaign.update({
				where: { id: campaignId },
				data: { sentCount: { increment: 1 } }
			});
			const pending = await transaction.mailingDelivery.count({
				where: {
					campaignId,
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
					id: campaignId,
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

	private buildTelegramBroadcastMessages(
		subject: string,
		message: string
	) {
		const chunks: string[] = [];
		let rest = message;
		while (rest.length > 3500) {
			const slice = rest.slice(0, 3500);
			const lastLineBreak = slice.lastIndexOf('\n');
			const splitAt = lastLineBreak > 2100 ? lastLineBreak + 1 : 3500;
			chunks.push(rest.slice(0, splitAt).trimEnd());
			rest = rest.slice(splitAt).trimStart();
		}
		if (rest) chunks.push(rest);
		if (!chunks.length) chunks.push('');
		return chunks.map((chunk, index) =>
			index === 0 ? [subject, '', chunk].join('\n') : chunk
		);
	}

	private async sendTelegramMessage(
		kind: 'mailing-telegram' | 'limit-telegram',
		chatId: string,
		messages: string[],
		parseMode: 'HTML' | null = null
	): Promise<void> {
		for (const text of messages) {
			try {
				await this.telegram.sendMessage(chatId, text, {
					parseMode
				});
			} catch (error) {
				const classification = classifyIntegrationError(kind, error);
				if (classification.mayDisableDestination) {
					try {
						await this.prisma.telegramNotificationChannel.updateMany({
							where: { chatId },
							data: {
								isActive: false,
								disabledAt: new Date()
							}
						});
					} catch (updateError) {
						this.logger.warn(
							`Could not deactivate Telegram destination chatId=${chatId}: ${
								updateError instanceof Error
									? updateError.message
									: String(updateError)
							}`
						);
					}
				}
				throw error;
			}
		}
	}

	private async sendPaymentTelegram(
		event: PaymentSucceededEventPayload
	): Promise<void> {
		const settings = await this.prisma.telegramBotSettings.findUnique({
			where: { id: 'singleton' },
			select: {
				dailySummaryChatId: true,
				paymentsThreadId: true
			}
		});
		const chatId = settings?.dailySummaryChatId.trim();
		const messageThreadId = settings?.paymentsThreadId;
		if (!chatId)
			throw new Error('Telegram payment chat ID is not configured');
		if (!messageThreadId) {
			throw new Error('Telegram Payments topic is not configured');
		}
		const text = [
			'<b>Новый успешный платёж</b>',
			'',
			`<b>Сумма:</b> ${this.escapeHtml(event.payment.amount)} ₽`,
			`<b>Тариф:</b> ${this.escapeHtml(this.getPlanLabel(event.payment.plan))}`,
			`<b>Период:</b> ${this.escapeHtml(this.getBillingPeriodLabel(event.payment.billingPeriod))}`,
			`<b>Пользователь:</b> ${this.escapeHtml(event.user.name || '—')}`,
			`<b>Email:</b> ${this.escapeHtml(event.user.email || '—')}`,
			`<b>Телефон:</b> ${this.escapeHtml(event.user.phone || '—')}`,
			`<b>ID пользователя:</b> <code>${this.escapeHtml(event.user.id)}</code>`,
			`<b>ID платежа:</b> <code>${this.escapeHtml(event.payment.id)}</code>`,
			`<b>ID YooKassa:</b> <code>${this.escapeHtml(event.payment.yookassaId)}</code>`,
			`<b>Оплачен:</b> ${this.escapeHtml(this.formatMoscowDateTime(new Date(event.payment.succeededAt)))} МСК`
		].join('\n');
		await this.telegram.sendMessage(chatId, text, {
			messageThreadId,
			parseMode: 'HTML'
		});
	}

	private getPlanLabel(plan: Plan): string {
		return plan === Plan.TRIAL
			? 'Тест-драйв'
			: plan === Plan.EASY
				? 'Easy'
				: 'Hard';
	}

	private getBillingPeriodLabel(period: BillingPeriod): string {
		return period === BillingPeriod.MONTHLY ? 'месяц' : 'год';
	}

	private formatMoscowDateTime(value: Date): string {
		return value.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
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

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}
}
