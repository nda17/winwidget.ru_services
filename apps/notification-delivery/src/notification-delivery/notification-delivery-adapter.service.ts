import { EmailService } from '../email/email.service';
import {
	CampaignEmailNotificationRequestedEventPayload,
	CampaignTelegramNotificationRequestedEventPayload,
	DailySummaryTelegramNotificationRequestedEventPayload,
	LeadIntegrationEventPayloadV2,
	LimitReachedEmailEventPayload,
	LimitReachedTelegramEventPayload,
	PaymentTelegramNotificationEventPayload,
	PaymentSucceededEventPayload,
	ResolvedLeadIntegrationEventPayload,
	SubscriptionExpiryEmailNotificationRequestedEventPayload,
	SubscriptionExpiryTelegramNotificationRequestedEventPayload
} from '../messaging/delivery-event.types';
import {
	CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	NotificationDeliveryKind,
	OUTBOX_EVENT_TYPE,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE
} from '../messaging/messaging.constants';
import { NotificationDeliveryEventPayload } from './notification-delivery-contract';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { Injectable } from '@nestjs/common';
import { NotificationDeliveryReceiptStatus } from '@prisma/notification-delivery-client';

@Injectable()
export class NotificationDeliveryAdapterService {
	constructor(
		private readonly emailService: EmailService,
		private readonly telegram: TelegramInfoTransportService,
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	async deliver(
		kind: NotificationDeliveryKind,
		event: NotificationDeliveryEventPayload,
		eventId: string,
		lockToken?: string
	): Promise<void> {
		switch (kind) {
			case 'email':
				await this.sendLeadEmail(this.getLeadEvent(event, kind), eventId);
				return;
			case 'telegram':
				await this.sendLeadTelegram(this.getLeadEvent(event, kind));
				return;
			case 'payment-email':
				await this.sendPaymentEmail(this.getPaymentEvent(event), eventId);
				return;
			case 'payment-telegram':
				await this.sendPaymentTelegram(
					this.getPaymentTelegramEvent(event)
				);
				return;
			case 'limit-email':
				await this.sendLimitEmail(this.getLimitEmailEvent(event), eventId);
				return;
			case 'limit-telegram':
				await this.sendLimitTelegram(this.getLimitTelegramEvent(event));
				return;
			case 'campaign-email':
				await this.sendCampaignEmail(
					this.getCampaignEmailEvent(event),
					eventId
				);
				return;
			case 'campaign-telegram':
				if (!lockToken) {
					throw new Error(
						'Campaign Telegram delivery requires an active claim'
					);
				}
				await this.sendCampaignTelegram(
					this.getCampaignTelegramEvent(event),
					eventId,
					lockToken
				);
				return;
			case 'daily-summary-delivery-telegram':
				await this.sendDailySummaryTelegram(
					this.getDailySummaryTelegramEvent(event)
				);
				return;
			case 'subscription-expiry-email':
				await this.sendSubscriptionExpiryEmail(
					this.getSubscriptionExpiryEmailEvent(event),
					eventId
				);
				return;
			case 'subscription-expiry-telegram':
				await this.sendSubscriptionExpiryTelegram(
					this.getSubscriptionExpiryTelegramEvent(event)
				);
				return;
		}
	}

	private getCampaignEmailEvent(
		event: NotificationDeliveryEventPayload
	): CampaignEmailNotificationRequestedEventPayload {
		const value = event as CampaignEmailNotificationRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE
		) {
			throw new Error('Invalid campaign email event payload');
		}
		return value;
	}

	private getCampaignTelegramEvent(
		event: NotificationDeliveryEventPayload
	): CampaignTelegramNotificationRequestedEventPayload {
		const value =
			event as CampaignTelegramNotificationRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE
		) {
			throw new Error('Invalid campaign Telegram event payload');
		}
		return value;
	}

	private getDailySummaryTelegramEvent(
		event: NotificationDeliveryEventPayload
	): DailySummaryTelegramNotificationRequestedEventPayload {
		const value =
			event as DailySummaryTelegramNotificationRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE
		) {
			throw new Error('Invalid daily summary Telegram event payload');
		}
		return value;
	}

	private getSubscriptionExpiryEmailEvent(
		event: NotificationDeliveryEventPayload
	): SubscriptionExpiryEmailNotificationRequestedEventPayload {
		const value =
			event as SubscriptionExpiryEmailNotificationRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !==
				SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE
		) {
			throw new Error('Invalid subscription expiry email event payload');
		}
		return value;
	}

	private getSubscriptionExpiryTelegramEvent(
		event: NotificationDeliveryEventPayload
	): SubscriptionExpiryTelegramNotificationRequestedEventPayload {
		const value =
			event as SubscriptionExpiryTelegramNotificationRequestedEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !==
				SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE
		) {
			throw new Error(
				'Invalid subscription expiry Telegram event payload'
			);
		}
		return value;
	}

	private getLeadEvent(
		event: NotificationDeliveryEventPayload,
		expectedKind: 'email' | 'telegram'
	): ResolvedLeadIntegrationEventPayload {
		const value = event as LeadIntegrationEventPayloadV2;
		if (
			value?.schemaVersion !== 2 ||
			value?.eventType !== OUTBOX_EVENT_TYPE ||
			value?.integration !== expectedKind
		) {
			throw new Error(
				`Invalid lead integration event for ${expectedKind}`
			);
		}

		return value as ResolvedLeadIntegrationEventPayload;
	}

	private getPaymentEvent(
		event: NotificationDeliveryEventPayload
	): PaymentSucceededEventPayload {
		const value = event as PaymentSucceededEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== PAYMENT_SUCCEEDED_EVENT_TYPE ||
			!value.payment?.id ||
			!value.payment?.yookassaId ||
			!value.user?.id
		) {
			throw new Error('Invalid payment succeeded event payload');
		}
		return value;
	}

	private getPaymentTelegramEvent(
		event: NotificationDeliveryEventPayload
	): PaymentTelegramNotificationEventPayload {
		const value = event as PaymentTelegramNotificationEventPayload;
		if (
			value?.schemaVersion !== 1 ||
			value?.eventType !== PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE ||
			!value.payment?.id ||
			!value.payment?.yookassaId ||
			!value.user?.id ||
			!value.destination ||
			!('telegramChatId' in value.destination) ||
			!('messageThreadId' in value.destination)
		) {
			throw new Error(
				'Invalid payment Telegram notification event payload'
			);
		}
		return value;
	}

	private getLimitEmailEvent(
		event: NotificationDeliveryEventPayload
	): LimitReachedEmailEventPayload {
		const value = event as LimitReachedEmailEventPayload;
		if (
			value?.schemaVersion !== 2 ||
			value?.eventType !== LIMIT_REACHED_EMAIL_EVENT_TYPE ||
			!value.entity?.id ||
			!value.entity?.name ||
			!Number.isInteger(value.limit) ||
			typeof value.destination?.email !== 'string' ||
			!value.destination.email.trim()
		) {
			throw new Error('Invalid limit reached email event payload');
		}
		return value;
	}

	private getLimitTelegramEvent(
		event: NotificationDeliveryEventPayload
	): LimitReachedTelegramEventPayload {
		const value = event as LimitReachedTelegramEventPayload;
		if (
			value?.schemaVersion !== 2 ||
			value?.eventType !== LIMIT_REACHED_TELEGRAM_EVENT_TYPE ||
			!value.entity?.id ||
			!value.entity?.name ||
			!Number.isInteger(value.limit) ||
			typeof value.destination?.telegramChatId !== 'string' ||
			!value.destination.telegramChatId.trim()
		) {
			throw new Error('Invalid limit reached Telegram event payload');
		}
		return value;
	}

	private async sendLeadEmail(
		event: ResolvedLeadIntegrationEventPayload,
		eventId: string
	): Promise<void> {
		const destination =
			'email' in event.destination ? event.destination.email : null;
		if (!destination) throw new Error('Email destination is missing');

		const detail = this.getDetail(event);
		await this.emailService.sendLeadNotification(
			destination,
			{
				widgetName: event.entity.name,
				phone: event.lead.phone || undefined,
				email: event.lead.email || undefined,
				name: event.lead.name || undefined,
				bonus: this.getOutcome(event) || undefined,
				detailLabel: detail?.label,
				detailValue: detail?.value,
				url: event.lead.url || undefined,
				date: new Date(event.lead.createdAt)
			},
			{ messageId: `<${eventId}@winwidget.ru>` }
		);
	}

	private async sendPaymentTelegram(
		event: PaymentTelegramNotificationEventPayload
	): Promise<void> {
		const chatId = event.destination.telegramChatId?.trim() || null;
		const messageThreadId = event.destination.messageThreadId;
		if (!chatId || !messageThreadId) {
			throw this.createDestinationConfigurationError(
				'Telegram payment destination is not configured'
			);
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

	private async sendLeadTelegram(
		event: ResolvedLeadIntegrationEventPayload
	): Promise<void> {
		const chatId =
			'telegramChatId' in event.destination
				? event.destination.telegramChatId
				: null;
		if (!chatId) throw new Error('Telegram chat ID is missing');

		await this.telegram.sendMessage(
			chatId,
			this.buildTelegramMessage(event),
			{
				parseMode: 'HTML'
			}
		);
	}

	private async sendLimitTelegram(
		event: LimitReachedTelegramEventPayload
	): Promise<void> {
		await this.telegram.sendMessage(
			event.destination.telegramChatId,
			[
				'⚠️ <b>Лимит заявок исчерпан</b>',
				`${this.escapeHtml(event.entity.name)} принял последнюю заявку (${event.limit} из ${event.limit}).`,
				'',
				'Новые заявки больше не принимаются.',
				'Для продолжения работы перейдите на платный тариф:',
				'👉 https://winwidget.ru/#pricing'
			].join('\n'),
			{ parseMode: 'HTML' }
		);
	}

	private async sendPaymentEmail(
		event: PaymentSucceededEventPayload,
		eventId: string
	): Promise<void> {
		if (!event.user.email) return;

		await this.emailService.sendPaymentSucceededNotification(
			event.user.email,
			{
				amount: event.payment.amount,
				planLabel: this.getPlanLabel(event.payment.plan),
				billingPeriodLabel: this.getBillingPeriodLabel(
					event.payment.billingPeriod
				),
				expiresAtLabel: event.subscription.expiresAt
					? this.formatMoscowDateTime(
							new Date(event.subscription.expiresAt)
						)
					: null
			},
			eventId
		);
	}

	private async sendLimitEmail(
		event: LimitReachedEmailEventPayload,
		eventId: string
	): Promise<void> {
		await this.emailService.sendLimitReachedNotification(
			event.destination.email,
			event.entity.name,
			event.limit,
			{ messageId: `<${eventId}.limit@winwidget.ru>` }
		);
	}

	private async sendCampaignEmail(
		event: CampaignEmailNotificationRequestedEventPayload,
		eventId: string
	): Promise<void> {
		await this.emailService.sendAdminBroadcast(
			event.destination.email,
			event.content,
			{ messageId: `<${eventId}.mailing@winwidget.ru>` }
		);
	}

	private async sendCampaignTelegram(
		event: CampaignTelegramNotificationRequestedEventPayload,
		eventId: string,
		lockToken: string
	): Promise<void> {
		const messages = this.buildTelegramBroadcastMessages(
			event.content.subject,
			event.content.message
		);
		const nextChunkIndex = await this.getCampaignTelegramCheckpoint(
			eventId,
			lockToken,
			messages.length
		);

		for (let index = nextChunkIndex; index < messages.length; index += 1) {
			await this.telegram.sendMessage(
				event.destination.telegramChatId,
				messages[index],
				{ parseMode: null }
			);
			const checkpoint =
				await this.prisma.notificationDeliveryReceipt.updateMany({
					where: {
						eventId,
						consumer: 'campaign-telegram',
						status: NotificationDeliveryReceiptStatus.PROCESSING,
						lockToken
					},
					data: {
						checkpoint: { nextChunkIndex: index + 1 }
					}
				});
			if (checkpoint.count !== 1) {
				throw new Error(
					'Campaign Telegram delivery checkpoint claim was lost'
				);
			}
		}
	}

	private async getCampaignTelegramCheckpoint(
		eventId: string,
		lockToken: string,
		messageCount: number
	): Promise<number> {
		const receipt =
			await this.prisma.notificationDeliveryReceipt.findFirst({
				where: {
					eventId,
					consumer: 'campaign-telegram',
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockToken
				},
				select: { checkpoint: true }
			});
		if (!receipt) {
			throw new Error('Campaign Telegram delivery claim was lost');
		}
		const checkpoint = receipt.checkpoint;
		const value =
			checkpoint &&
			typeof checkpoint === 'object' &&
			!Array.isArray(checkpoint)
				? checkpoint.nextChunkIndex
				: 0;
		if (
			!Number.isInteger(value) ||
			Number(value) < 0 ||
			Number(value) > messageCount
		) {
			throw new Error('Invalid campaign Telegram delivery checkpoint');
		}
		return Number(value);
	}

	private async sendDailySummaryTelegram(
		event: DailySummaryTelegramNotificationRequestedEventPayload
	): Promise<void> {
		await this.telegram.sendMessage(
			event.destination.telegramChatId,
			event.content.text,
			{
				messageThreadId: event.destination.messageThreadId,
				parseMode: 'HTML'
			}
		);
	}

	private async sendSubscriptionExpiryEmail(
		event: SubscriptionExpiryEmailNotificationRequestedEventPayload,
		eventId: string
	): Promise<void> {
		await this.emailService.sendSubscriptionExpiryReminder(
			event.destination.email,
			event.content,
			{
				messageId: `<${eventId}.subscription-expiry@winwidget.ru>`
			}
		);
	}

	private async sendSubscriptionExpiryTelegram(
		event: SubscriptionExpiryTelegramNotificationRequestedEventPayload
	): Promise<void> {
		await this.telegram.sendMessage(
			event.destination.telegramChatId,
			this.buildSubscriptionExpiryTelegramMessage(event.content),
			{ parseMode: 'HTML' }
		);
	}

	private buildTelegramBroadcastMessages(
		subject: string,
		message: string
	): string[] {
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

	private buildSubscriptionExpiryTelegramMessage(content: {
		daysBeforeExpiry: number;
		planLabel: string;
		expiresAtLabel: string;
	}): string {
		const statusText =
			content.daysBeforeExpiry === 0
				? 'Сегодня последний день подписки.'
				: `До окончания подписки осталось ${content.daysBeforeExpiry} ${this.getDayWord(content.daysBeforeExpiry)}.`;
		return [
			'<b>Подписка winwidget.ru</b>',
			`Тариф: ${this.escapeHtml(content.planLabel)}`,
			`Дата окончания: ${this.escapeHtml(content.expiresAtLabel)} МСК`,
			'',
			statusText,
			'',
			'Продлить доступ можно в личном кабинете.'
		].join('\n');
	}

	private getDayWord(value: number): string {
		const mod10 = value % 10;
		const mod100 = value % 100;
		if (mod10 === 1 && mod100 !== 11) return 'день';
		if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
			return 'дня';
		}
		return 'дней';
	}

	private buildTelegramMessage(
		event: ResolvedLeadIntegrationEventPayload
	): string {
		const lines = [
			'🎯 <b>Новая заявка</b>',
			`Источник: ${this.escapeHtml(this.getSourceLabel(event))}`,
			`Виджет: ${this.escapeHtml(event.entity.name)}`
		];
		const fields = [
			['Имя', event.lead.name],
			['Телефон', event.lead.phone],
			['Email', event.lead.email],
			['Контакт', this.getDistinctContact(event)],
			['Результат', this.getOutcome(event)],
			['Время', event.lead.timeSlot],
			['Часовой пояс', event.lead.timezone],
			['Вопрос', event.lead.actionLabel],
			['Ответ', event.lead.actionValue],
			[
				'Стоимость',
				event.lead.calculatedPrice
					? `${event.lead.calculatedPrice} ${event.lead.currency || ''}`.trim()
					: null
			],
			['Страница', event.lead.url]
		] as const;

		for (const [label, value] of fields) {
			if (value) lines.push(`${label}: ${this.escapeHtml(String(value))}`);
		}
		lines.push(
			`Дата: ${this.formatMoscowDateTime(new Date(event.lead.createdAt))}`
		);
		return lines.join('\n');
	}

	private getDistinctContact(
		event: ResolvedLeadIntegrationEventPayload
	): string | null {
		const contact = event.lead.contact?.trim();
		if (!contact) return null;

		const duplicatesKnownField = [
			event.lead.name,
			event.lead.phone,
			event.lead.email
		].some(value => this.areContactValuesEquivalent(contact, value));

		return duplicatesKnownField ? null : contact;
	}

	private areContactValuesEquivalent(
		left: string,
		right: string | null | undefined
	): boolean {
		if (!right) return false;

		const normalizedLeft = left.trim().toLowerCase();
		const normalizedRight = right.trim().toLowerCase();
		if (normalizedLeft === normalizedRight) return true;

		const phonePattern = /^[+\d\s().-]+$/;
		if (
			!phonePattern.test(normalizedLeft) ||
			!phonePattern.test(normalizedRight)
		) {
			return false;
		}

		const leftDigits = normalizedLeft.replace(/\D/g, '');
		const rightDigits = normalizedRight.replace(/\D/g, '');

		return leftDigits.length >= 7 && leftDigits === rightDigits;
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

	private getPlanLabel(
		plan: PaymentSucceededEventPayload['payment']['plan']
	): string {
		return plan === 'TRIAL'
			? 'Тест-драйв'
			: plan === 'EASY'
				? 'Easy'
				: 'Hard';
	}

	private getBillingPeriodLabel(
		period: PaymentSucceededEventPayload['payment']['billingPeriod']
	): string {
		return period === 'MONTHLY' ? 'месяц' : 'год';
	}

	private formatMoscowDateTime(value: Date): string {
		return value.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
	}

	private createDestinationConfigurationError(message: string): Error {
		return Object.assign(new Error(message), {
			code: 'DESTINATION_CONFIGURATION_MISSING'
		});
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
