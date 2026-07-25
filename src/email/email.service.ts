import VerificationEmail from '@email/confirmation.email';
import AdminBroadcastEmail from '@email/admin-broadcast.email';
import LeadNotificationEmail from '@email/lead-notification.email';
import LimitReachedEmail from '@email/limit-reached.email';
import PaymentSucceededEmail from '@email/payment-succeeded.email';
import NewPasswordEmail from '@email/restore-password.email';
import SubscriptionExpiryReminderEmail from '@email/subscription-expiry-reminder.email';
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

interface AdminBroadcastPayload {
	subject: string;
	message: string;
}

interface SubscriptionExpiryReminderPayload {
	daysBeforeExpiry: number;
	planLabel: string;
	expiresAtLabel: string;
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

	sendVerificationCode(to: string, code: string) {
		const html = render(VerificationEmail({ code }));
		return this.sendEmail(to, 'Код подтверждения email', html);
	}

	sendNewPassword(to: string, password: string) {
		const html = render(NewPasswordEmail({ password: password }));
		return this.sendEmail(to, 'Временный пароль', html);
	}

	sendAdminBroadcast(
		to: string,
		data: AdminBroadcastPayload,
		options: { messageId?: string } = {}
	) {
		const html = render(
			AdminBroadcastEmail({
				subject: data.subject,
				message: data.message
			})
		);

		return this.sendEmail(to, data.subject, html, options);
	}

	sendSubscriptionExpiryReminder(
		to: string,
		data: SubscriptionExpiryReminderPayload,
		options: { messageId?: string } = {}
	) {
		const html = render(
			SubscriptionExpiryReminderEmail({
				daysBeforeExpiry: data.daysBeforeExpiry,
				planLabel: data.planLabel,
				expiresAtLabel: data.expiresAtLabel
			})
		);
		const subject =
			data.daysBeforeExpiry === 0
				? 'Сегодня последний день подписки WinWidget'
				: `Подписка WinWidget закончится через ${this.getDaysLabel(data.daysBeforeExpiry)}`;

		return this.sendEmail(to, subject, html, options);
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

	private getDaysLabel(days: number) {
		const mod10 = days % 10;
		const mod100 = days % 100;

		if (mod10 === 1 && mod100 !== 11) return `${days} день`;
		if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
			return `${days} дня`;
		}

		return `${days} дней`;
	}
}
