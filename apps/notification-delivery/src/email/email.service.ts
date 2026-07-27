import LeadNotificationEmail from '../../emails/lead-notification.email';
import LimitReachedEmail from '../../emails/limit-reached.email';
import PaymentSucceededEmail from '../../emails/payment-succeeded.email';
import { MailerService } from '@nestjs-modules/mailer';
import { Injectable } from '@nestjs/common';
import { render } from '@react-email/render';

interface LeadNotificationPayload {
	widgetName: string;
	phone?: string;
	email?: string;
	name?: string;
	bonus?: string;
	detailLabel?: string;
	detailValue?: string;
	url?: string;
	date: Date;
}

interface PaymentSucceededEmailPayload {
	amount: string;
	planLabel: string;
	billingPeriodLabel: string;
	expiresAtLabel: string | null;
}

@Injectable()
export class EmailService {
	constructor(private readonly mailerService: MailerService) {}

	sendEmail(
		to: string,
		subject: string,
		html: string,
		options: { messageId?: string } = {}
	) {
		return this.mailerService.sendMail({
			to,
			subject,
			html,
			...options
		});
	}

	sendLeadNotification(
		to: string,
		data: LeadNotificationPayload,
		options: { messageId?: string } = {}
	) {
		const dateLabel = data.date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
		const html = render(
			LeadNotificationEmail({
				widgetName: data.widgetName,
				phone: data.phone,
				email: data.email,
				name: data.name,
				bonus: data.bonus,
				detailLabel: data.detailLabel,
				detailValue: data.detailValue,
				url: data.url,
				dateLabel
			})
		);

		return this.sendEmail(
			to,
			`Новая заявка с виджета "${data.widgetName}"`,
			html,
			options
		);
	}

	sendPaymentSucceededNotification(
		to: string,
		data: PaymentSucceededEmailPayload,
		eventId: string
	) {
		const html = render(PaymentSucceededEmail(data));
		return this.sendEmail(
			to,
			'Оплата WinWidget успешно подтверждена',
			html,
			{ messageId: `<${eventId}.payment@winwidget.ru>` }
		);
	}

	sendLimitReachedNotification(
		to: string,
		widgetName: string,
		limit: number,
		options: { messageId?: string } = {}
	) {
		const html = render(
			LimitReachedEmail({
				widgetName,
				limit
			})
		);

		return this.sendEmail(
			to,
			`⚠️ Лимит заявок исчерпан — виджет «${widgetName}»`,
			html,
			options
		);
	}
}
