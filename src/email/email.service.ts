import VerificationEmail from '@email/confirmation.email';
import NewPasswordEmail from '@email/restore-password.email';
import { MailerService } from '@nestjs-modules/mailer';
import { Injectable } from '@nestjs/common';
import { render } from '@react-email/render';

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
}
