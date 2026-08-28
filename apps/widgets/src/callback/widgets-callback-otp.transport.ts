import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import { Buffer } from 'node:buffer';

const SMS_AERO_ENDPOINT = 'https://gate.smsaero.ru/v2/sms/send';
const MAIL_FROM = '"winwidget.ru" <no-reply@winwidget.ru>';
const EMAIL_SUBJECT = 'Код подтверждения заявки на обратный звонок';

type SmsAeroResponse = { success?: boolean };

export interface WidgetsCallbackOtpTransport {
	isEmailConfigured(): boolean;
	isSmsConfigured(): boolean;
	sendEmail(destination: string, code: string): Promise<void>;
	sendSms(destination: string, code: string): Promise<void>;
}

export const WIDGETS_CALLBACK_OTP_TRANSPORT = Symbol(
	'WIDGETS_CALLBACK_OTP_TRANSPORT'
);

@Injectable()
export class WidgetsCallbackOtpProvider implements WidgetsCallbackOtpTransport {
	private readonly mailer: Transporter | null;
	private readonly smsEmail: string;
	private readonly smsApiKey: string;
	private readonly smsSign: string;
	private readonly smsTimeoutMs: number;

	constructor(config: ConfigService) {
		const smtpHost = value(config, 'SMTP_SERVER');
		const smtpLogin = value(config, 'SMTP_LOGIN');
		const smtpPassword = value(config, 'SMTP_PASSWORD');
		assertCompleteGroup('SMTP', [smtpHost, smtpLogin, smtpPassword]);
		const development =
			value(config, 'MODE').toLowerCase() === 'development';
		this.mailer = smtpHost
			? nodemailer.createTransport({
					host: smtpHost,
					port: optionalPort(config, development ? 2525 : 465),
					secure: optionalBoolean(config, 'SMTP_SECURE', !development),
					connectionTimeout: optionalTimeout(
						config,
						'SMTP_CONNECTION_TIMEOUT_MS',
						5_000
					),
					greetingTimeout: optionalTimeout(
						config,
						'SMTP_GREETING_TIMEOUT_MS',
						5_000
					),
					socketTimeout: optionalTimeout(
						config,
						'SMTP_SOCKET_TIMEOUT_MS',
						15_000
					),
					auth: { user: smtpLogin, pass: smtpPassword }
				})
			: null;

		this.smsEmail = value(config, 'SMSAERO_EMAIL');
		this.smsApiKey = value(config, 'SMSAERO_API_KEY');
		this.smsSign = value(config, 'SMSAERO_SIGN');
		assertCompleteGroup('SMS Aero', [
			this.smsEmail,
			this.smsApiKey,
			this.smsSign
		]);
		this.smsTimeoutMs = optionalTimeout(
			config,
			'WIDGETS_CALLBACK_OTP_PROVIDER_TIMEOUT_MS',
			10_000
		);
	}

	isEmailConfigured(): boolean {
		return this.mailer !== null;
	}

	isSmsConfigured(): boolean {
		return Boolean(this.smsEmail && this.smsApiKey && this.smsSign);
	}

	async sendEmail(destination: string, code: string): Promise<void> {
		if (!this.mailer)
			throw new Error('Callback OTP SMTP is not configured');
		await this.mailer.sendMail({
			from: MAIL_FROM,
			to: destination,
			subject: EMAIL_SUBJECT,
			text: `Код подтверждения WinWidget: ${code}. Код действует 5 минут.`
		});
	}

	async sendSms(destination: string, code: string): Promise<void> {
		if (!this.isSmsConfigured()) {
			throw new Error('Callback OTP SMS Aero is not configured');
		}
		const number = destination.replace(/\D/g, '');
		if (!number)
			throw new Error('Callback OTP SMS destination is invalid');
		const query = new URLSearchParams({
			number,
			text: `Код подтверждения WinWidget: ${code}`,
			sign: this.smsSign
		});
		const authorization = Buffer.from(
			`${this.smsEmail}:${this.smsApiKey}`
		).toString('base64');
		const response = await fetch(
			`${SMS_AERO_ENDPOINT}?${query.toString()}`,
			{
				method: 'GET',
				redirect: 'error',
				headers: { Authorization: `Basic ${authorization}` },
				signal: AbortSignal.timeout(this.smsTimeoutMs)
			}
		);
		if (!response.ok)
			throw new Error('Callback OTP SMS provider rejected');
		let result: SmsAeroResponse;
		try {
			result = (await response.json()) as SmsAeroResponse;
		} catch {
			throw new Error('Callback OTP SMS provider response is invalid');
		}
		if (result.success !== true) {
			throw new Error('Callback OTP SMS provider returned failure');
		}
	}
}

function value(config: ConfigService, key: string): string {
	return config.get<string>(key)?.trim() || '';
}

function assertCompleteGroup(label: string, values: string[]): void {
	const configured = values.filter(Boolean).length;
	if (configured !== 0 && configured !== values.length) {
		throw new Error(`${label} callback OTP configuration is incomplete`);
	}
}

function optionalPort(config: ConfigService, fallback: number): number {
	const raw = value(config, 'SMTP_PORT');
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new Error('SMTP_PORT must be an integer between 1 and 65535');
	}
	return parsed;
}

function optionalBoolean(
	config: ConfigService,
	key: string,
	fallback: boolean
): boolean {
	const raw = value(config, key);
	if (!raw) return fallback;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new Error(`${key} must be true or false`);
}

function optionalTimeout(
	config: ConfigService,
	key: string,
	fallback: number
): number {
	const raw = value(config, key);
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
		throw new Error(`${key} must be between 1000 and 60000`);
	}
	return parsed;
}
