import AdminBroadcastEmail from '../../emails/admin-broadcast.email';
import LeadNotificationEmail from '../../emails/lead-notification.email';
import LimitReachedEmail from '../../emails/limit-reached.email';
import PaymentSucceededEmail from '../../emails/payment-succeeded.email';
import SubscriptionExpiryReminderEmail from '../../emails/subscription-expiry-reminder.email';
import WincrmInvitationEmail from '../../emails/wincrm-invitation.email';
import { EMAIL_TRANSPORTER } from '../config/mailer.config';
import { Inject, Injectable } from '@nestjs/common';
import { render } from '@react-email/render';
import type { Transporter } from 'nodemailer';
import { join } from 'node:path';

const EMAIL_LOGO_CID = 'winwidget-notification-logo';
const EMAIL_LOGO_PATH = join(process.cwd(), 'assets', 'email-logo.png');

interface LeadNotificationPayload {
	widgetName: string;
	phone?: string;
	email?: string;
	name?: string;
	bonus?: string;
	bonusLabel?: string;
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

interface SubscriptionExpiryReminderPayload {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
}

@Injectable()
export class EmailService {
	constructor(
		@Inject(EMAIL_TRANSPORTER)
		private readonly mailer: Transporter
	) {}

	sendEmail(
		to: string,
		subject: string,
		html: string,
		options: { messageId?: string } = {}
	) {
		return this.mailer.sendMail({
			to,
			subject,
			html,
			attachments: [
				{
					filename: 'winwidget-logo.png',
					path: EMAIL_LOGO_PATH,
					cid: EMAIL_LOGO_CID,
					contentDisposition: 'inline'
				}
			],
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
				bonusLabel: data.bonusLabel,
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

	sendAdminBroadcast(
		to: string,
		data: { subject: string; message: string },
		options: { messageId?: string } = {}
	) {
		const html = render(AdminBroadcastEmail(data));
		return this.sendEmail(to, data.subject, html, options);
	}

	sendSubscriptionExpiryReminder(
		to: string,
		data: SubscriptionExpiryReminderPayload,
		options: { messageId?: string } = {}
	) {
		const html = render(SubscriptionExpiryReminderEmail(data));
		const subject =
			data.daysBeforeExpiry === 0
				? 'Сегодня последний день подписки WinWidget'
				: `Подписка WinWidget закончится через ${this.getDaysLabel(data.daysBeforeExpiry)}`;

		return this.sendEmail(to, subject, html, options);
	}

	sendWincrmInvitation(
		to: string,
		invitationId: string,
		expiresAt: string,
		eventId: string
	) {
		const html = render(
			WincrmInvitationEmail({
				invitationId,
				expiresAtLabel: new Date(expiresAt).toLocaleString('ru-RU', {
					timeZone: 'Europe/Moscow'
				})
			})
		);
		return this.sendEmail(to, 'Приглашение в WinCRM', html, {
			messageId: `<${eventId}.wincrm-invitation@winwidget.ru>`
		});
	}

	private getDaysLabel(days: number): string {
		const mod10 = days % 10;
		const mod100 = days % 100;
		if (mod10 === 1 && mod100 !== 11) return `${days} день`;
		if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
			return `${days} дня`;
		}
		return `${days} дней`;
	}
}
