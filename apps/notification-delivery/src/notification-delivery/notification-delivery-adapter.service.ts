import { EmailService } from '../email/email.service';
import {
	LeadIntegrationEventPayloadV2,
	LimitReachedEmailEventPayload,
	PaymentSucceededEventPayload,
	ResolvedLeadIntegrationEventPayload
} from '../messaging/delivery-event.types';
import {
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	NotificationDeliveryKind,
	OUTBOX_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE
} from '../messaging/messaging.constants';
import { NotificationDeliveryEventPayload } from './notification-delivery-contract';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class NotificationDeliveryAdapterService {
	constructor(
		private readonly emailService: EmailService,
		private readonly telegram: TelegramInfoTransportService
	) {}

	async deliver(
		kind: NotificationDeliveryKind,
		event: NotificationDeliveryEventPayload,
		eventId: string
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
			case 'limit-email':
				await this.sendLimitEmail(this.getLimitEmailEvent(event), eventId);
				return;
		}
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
			['Контакт', event.lead.contact],
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

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}
}
