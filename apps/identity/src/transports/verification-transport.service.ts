import {
	BadGatewayException,
	Injectable,
	InternalServerErrorException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';
import nodemailer, { type Transporter } from 'nodemailer';
import { passwordEmail, verificationEmail } from './email-templates';

const SMSAERO_ENDPOINT = 'https://gate.smsaero.ru/v2/sms/send';
const MAIL_FROM = '"winwidget.ru" <no-reply@winwidget.ru>';
export const VERIFICATION_EMAIL_SUBJECT = 'Код подтверждения email';
export const PASSWORD_EMAIL_SUBJECT = 'Временный пароль';

type SmsAeroResponse = {
	success: boolean;
	message?: string | null;
};

@Injectable()
export class VerificationTransportService {
	private readonly mailer: Transporter | null;
	private readonly smtpConfigured: boolean;
	private readonly smsEmail: string;
	private readonly smsApiKey: string;
	private readonly smsSign: string;

	constructor(private readonly config: ConfigService) {
		const host = config.get<string>('SMTP_SERVER')?.trim() || '';
		const user = config.get<string>('SMTP_LOGIN')?.trim() || '';
		const password = config.get<string>('SMTP_PASSWORD')?.trim() || '';
		const development =
			config.get<string>('MODE')?.trim().toLowerCase() === 'development';
		this.smtpConfigured = Boolean(host && user && password);
		this.mailer = this.smtpConfigured
			? nodemailer.createTransport({
					host,
					port: development ? 2525 : 465,
					secure: !development,
					connectionTimeout: timeout(
						config,
						'SMTP_CONNECTION_TIMEOUT_MS',
						5_000
					),
					greetingTimeout: timeout(
						config,
						'SMTP_GREETING_TIMEOUT_MS',
						5_000
					),
					socketTimeout: timeout(config, 'SMTP_SOCKET_TIMEOUT_MS', 15_000),
					auth: { user, pass: password }
				})
			: null;
		this.smsEmail = config.get<string>('SMSAERO_EMAIL')?.trim() || '';
		this.smsApiKey = config.get<string>('SMSAERO_API_KEY')?.trim() || '';
		this.smsSign =
			config.get<string>('SMSAERO_SIGN')?.trim() || 'SMS Aero';
	}

	isEmailConfigured(): boolean {
		return this.smtpConfigured;
	}

	isSmsConfigured(): boolean {
		return Boolean(this.smsEmail && this.smsApiKey);
	}

	async emailCode(email: string, code: string): Promise<void> {
		await this.sendEmail(
			email,
			VERIFICATION_EMAIL_SUBJECT,
			render(verificationEmail(code))
		);
	}

	async newPassword(email: string, password: string): Promise<void> {
		await this.sendEmail(
			email,
			PASSWORD_EMAIL_SUBJECT,
			render(passwordEmail(password))
		);
	}

	smsCode(phone: string, code: string): Promise<void> {
		return this.sendSms(phone, `Ваш код подтверждения: ${code}`);
	}

	smsPassword(phone: string, password: string): Promise<void> {
		return this.sendSms(phone, `Ваш новый пароль: ${password}`);
	}

	private async sendEmail(
		to: string,
		subject: string,
		html: string
	): Promise<void> {
		if (!this.mailer) {
			throw new InternalServerErrorException(
				'Email verification transport is not configured'
			);
		}
		await this.mailer.sendMail({ from: MAIL_FROM, to, subject, html });
	}

	private async sendSms(to: string, text: string): Promise<void> {
		if (!this.smsEmail || !this.smsApiKey) {
			throw new InternalServerErrorException(
				'SMS Aero credentials are not configured'
			);
		}
		const digits = to.replace(/\D/g, '');
		const number = digits.length === 10 ? `7${digits}` : digits;
		if (!number)
			throw new BadGatewayException('SMS provider request failed');
		const params = new URLSearchParams({
			number,
			text,
			sign: this.smsSign
		});
		const authorization = Buffer.from(
			`${this.smsEmail}:${this.smsApiKey}`
		).toString('base64');
		const response = await fetch(
			`${SMSAERO_ENDPOINT}?${params.toString()}`,
			{
				method: 'GET',
				headers: { Authorization: `Basic ${authorization}` },
				signal: AbortSignal.timeout(10_000)
			}
		);
		if (!response.ok) {
			throw new BadGatewayException('SMS provider request failed');
		}
		if (
			!(response.headers.get('content-type') || '').includes(
				'application/json'
			)
		) {
			return;
		}
		const result = (await response.json()) as SmsAeroResponse;
		if (!result.success) {
			throw new BadGatewayException(
				result.message || 'SMS provider returned an error'
			);
		}
	}
}

function timeout(
	config: ConfigService,
	key: string,
	fallback: number
): number {
	const value = Number(config.get<string>(key));
	return Number.isInteger(value) && value >= 1_000 && value <= 60_000
		? value
		: fallback;
}
