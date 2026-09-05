import {
	BadGatewayException,
	Injectable,
	InternalServerErrorException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { passwordEmail, verificationEmail } from './email-templates';

const SMSAERO_ENDPOINT = 'https://gate.smsaero.ru/v2/sms/send';
const SMSAERO_BALANCE_ENDPOINT = 'https://gate.smsaero.ru/v2/balance';
const MAIL_FROM = '"winwidget.ru" <no-reply@winwidget.ru>';
const EMAIL_LOGO_CID = 'winwidget-identity-logo';
const EMAIL_LOGO_PATH = join(process.cwd(), 'assets', 'email-logo.png');
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

	/** A single bounded login attempt; existing registration transports stay unchanged. */
	async loginCode(
		channel: 'EMAIL' | 'SMS',
		destination: string,
		code: string,
		signal: AbortSignal
	): Promise<void> {
		signal.throwIfAborted();
		if (channel === 'SMS') {
			if (!this.isSmsConfigured())
				throw new Error('Login delivery unavailable');
			const payload = {
				number: Number(destination.replace(/\D/g, '')),
				text: `Код входа в WinWidget: ${code}. Никому не сообщайте код.`,
				sign: this.smsSign
			};
			const response = await fetch(SMSAERO_ENDPOINT, {
				method: 'POST',
				redirect: 'error',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Basic ${Buffer.from(`${this.smsEmail}:${this.smsApiKey}`).toString('base64')}`
				},
				body: JSON.stringify(payload),
				signal
			});
			if (!response.ok) throw new Error('Login delivery unavailable');
			const body = (await response.json()) as SmsAeroResponse;
			if (body.success !== true)
				throw new Error('Login delivery unavailable');
			return;
		}
		if (!this.isEmailConfigured())
			throw new Error('Login delivery unavailable');
		const host = this.config.get<string>('SMTP_SERVER')!.trim();
		const development =
			this.config.get<string>('MODE')?.trim().toLowerCase() ===
			'development';
		const port = development ? 2525 : 465;
		let socket: Socket | undefined;
		const options: SMTPTransport.Options = {
			host,
			port,
			secure: !development,
			auth: {
				user: this.config.get<string>('SMTP_LOGIN')!.trim(),
				pass: this.config.get<string>('SMTP_PASSWORD')!.trim()
			},
			connectionTimeout: 4_000,
			greetingTimeout: 4_000,
			socketTimeout: 4_000,
			// Own the underlying socket so the same hard response deadline also
			// aborts DNS/TCP/TLS/SMTP work. Nodemailer performs normal TLS checks.
			getSocket: (_options, callback) => {
				if (signal.aborted) {
					callback(new Error('Login delivery unavailable'), null);
					return;
				}
				socket = connect({ host, port, signal });
				let handedOff = false;
				socket.once('connect', () => {
					handedOff = true;
					callback(null, { connection: socket });
				});
				socket.once('error', () => {
					if (!handedOff)
						callback(new Error('Login delivery unavailable'), null);
				});
			}
		};
		const mailer = nodemailer.createTransport(options);
		try {
			await mailer.sendMail({
				from: MAIL_FROM,
				to: destination,
				subject: 'Код входа в WinWidget',
				text: `Ваш код входа в WinWidget: ${code}. Код действует 5 минут. Никому не сообщайте код. Если вы не запрашивали вход, проигнорируйте письмо.`
			});
		} finally {
			socket?.destroy();
			mailer.close();
		}
	}

	async verifyEmailTransport(): Promise<void> {
		if (!this.mailer) {
			throw new Error('SMTP transport is not configured');
		}
		await this.mailer.verify();
	}

	async verifySmsTransport(): Promise<void> {
		if (!this.smsEmail || !this.smsApiKey) {
			throw new Error('SMS Aero transport is not configured');
		}
		const response = await fetch(SMSAERO_BALANCE_ENDPOINT, {
			headers: {
				Authorization: `Basic ${Buffer.from(
					`${this.smsEmail}:${this.smsApiKey}`
				).toString('base64')}`
			},
			signal: AbortSignal.timeout(3_000)
		});
		if (!response.ok) {
			throw new Error(
				`SMS Aero health request failed: HTTP ${response.status}`
			);
		}
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
		await this.mailer.sendMail({
			from: MAIL_FROM,
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
			]
		});
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
