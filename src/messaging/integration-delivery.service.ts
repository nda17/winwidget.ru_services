import { EmailService } from '@/email/email.service';
import { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import { IntegrationKind } from '@/messaging/messaging.constants';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class IntegrationDeliveryService {
	constructor(
		private readonly emailService: EmailService,
		private readonly safeOutboundHttpService: SafeOutboundHttpService,
		private readonly configService: ConfigService
	) {}

	async deliver(
		kind: IntegrationKind,
		event: LeadIntegrationEventPayload,
		eventId: string
	): Promise<void> {
		if (event.integration !== kind) {
			throw new Error(
				`Integration mismatch: queue=${kind}, payload=${event.integration}`
			);
		}

		switch (kind) {
			case 'email':
				await this.sendEmail(event, eventId);
				return;
			case 'webhook':
				await this.sendWebhook(event, eventId);
				return;
			case 'telegram':
				await this.sendTelegram(event);
				return;
			case 'bitrix24':
				await this.sendBitrix24(event);
				return;
			case 'amo-crm':
				await this.sendAmoCrm(event);
				return;
		}
	}

	private async sendEmail(
		event: LeadIntegrationEventPayload,
		eventId: string
	): Promise<void> {
		const destination = event.destination.email;
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

	private async sendWebhook(
		event: LeadIntegrationEventPayload,
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

	private async sendTelegram(
		event: LeadIntegrationEventPayload
	): Promise<void> {
		const chatId = event.destination.telegramChatId;
		if (!chatId) throw new Error('Telegram chat ID is missing');

		const token = this.configService.get<string>(
			'TELEGRAM_INFO_BOT_TOKEN'
		);
		if (!token)
			throw new Error('TELEGRAM_INFO_BOT_TOKEN is not configured');

		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text: this.buildTelegramMessage(event),
					parse_mode: 'HTML'
				}),
				signal: AbortSignal.timeout(10_000)
			}
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`Telegram API returned ${response.status}: ${body.slice(0, 500)}`
			);
		}
	}

	private async sendBitrix24(
		event: LeadIntegrationEventPayload
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
		event: LeadIntegrationEventPayload
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

	private buildTelegramMessage(
		event: LeadIntegrationEventPayload
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
			if (value) {
				lines.push(`${label}: ${this.escapeHtml(String(value))}`);
			}
		}
		lines.push(
			`Дата: ${new Date(event.lead.createdAt).toLocaleString('ru-RU', {
				timeZone: 'Europe/Moscow'
			})}`
		);
		return lines.join('\n');
	}

	private buildLeadTitle(event: LeadIntegrationEventPayload): string {
		const outcome = this.getOutcome(event);
		return `Заявка с виджета «${event.entity.name}»${
			outcome ? ` — ${outcome}` : ''
		}`;
	}

	private buildComments(event: LeadIntegrationEventPayload): string {
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

	private getOutcome(event: LeadIntegrationEventPayload): string | null {
		return (
			event.lead.bonus ||
			event.lead.result ||
			(event.lead.calculatedPrice
				? `${event.lead.calculatedPrice} ${event.lead.currency || ''}`.trim()
				: null)
		);
	}

	private getDetail(
		event: LeadIntegrationEventPayload
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

	private getSourceLabel(event: LeadIntegrationEventPayload): string {
		const labels: Record<LeadIntegrationEventPayload['source'], string> = {
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
