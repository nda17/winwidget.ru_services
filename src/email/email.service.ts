import VerificationEmail from '@email/confirmation.email';
import AdminBroadcastEmail from '@email/admin-broadcast.email';
import LeadNotificationEmail from '@email/lead-notification.email';
import LimitReachedEmail from '@email/limit-reached.email';
import NewPasswordEmail from '@email/restore-password.email';
import { MailerService } from '@nestjs-modules/mailer';
import { Injectable } from '@nestjs/common';
import { render } from '@react-email/render';

interface LeadNotificationPayload {
	widgetName: string;
	phone?: string;
	email?: string;
	name?: string;
	bonus?: string;
	url?: string;
	date: Date;
}

interface AdminBroadcastPayload {
	subject: string;
	message: string;
}

@Injectable()
export class EmailService {
	constructor(private readonly mailerService: MailerService) {}

	sendEmail(to: string, subject: string, html: string) {
		return this.mailerService.sendMail({
			to,
			subject,
			html
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

	sendAdminBroadcast(to: string, data: AdminBroadcastPayload) {
		const html = render(
			AdminBroadcastEmail({
				subject: data.subject,
				message: data.message
			})
		);

		return this.sendEmail(to, data.subject, html);
	}

	sendLeadNotification(to: string, data: LeadNotificationPayload) {
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
				url: data.url,
				dateLabel
			})
		);

		return this.sendEmail(
			to,
			`Новая заявка с виджета "${data.widgetName}"`,
			html
		);
	}

	sendLimitReachedNotification(
		to: string,
		widgetName: string,
		limit: number
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
			html
		);
	}
}
