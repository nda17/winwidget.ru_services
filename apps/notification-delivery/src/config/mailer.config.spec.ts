import { createEmailTransporter, getMailerConfig } from './mailer.config';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

jest.mock('nodemailer', () => ({
	__esModule: true,
	default: {
		createTransport: jest.fn()
	}
}));

describe('mailer config', () => {
	const createTransport = nodemailer.createTransport as jest.Mock;

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('preserves explicit SMTP settings and the default sender', async () => {
		const config = new ConfigService({
			MODE: 'production',
			SMTP_SERVER: 'smtp.example.com',
			SMTP_PORT: '2526',
			SMTP_SECURE: 'false',
			SMTP_LOGIN: 'mailer',
			SMTP_PASSWORD: 'password',
			SMTP_CONNECTION_TIMEOUT_MS: '6000',
			SMTP_GREETING_TIMEOUT_MS: '7000',
			SMTP_SOCKET_TIMEOUT_MS: '16000'
		});

		await expect(getMailerConfig(config)).resolves.toEqual({
			transport: {
				host: 'smtp.example.com',
				port: 2526,
				secure: false,
				connectionTimeout: 6000,
				greetingTimeout: 7000,
				socketTimeout: 16000,
				auth: { user: 'mailer', pass: 'password' }
			},
			defaults: {
				from: '"winwidget.ru" <no-reply@winwidget.ru>'
			}
		});
	});

	it('keeps development fallbacks and passes defaults to nodemailer', async () => {
		const config = new ConfigService({
			MODE: 'development',
			SMTP_SERVER: 'localhost',
			SMTP_PORT: 'invalid',
			SMTP_SECURE: 'invalid',
			SMTP_LOGIN: 'mailer',
			SMTP_PASSWORD: 'password',
			SMTP_CONNECTION_TIMEOUT_MS: '999',
			SMTP_GREETING_TIMEOUT_MS: '60001',
			SMTP_SOCKET_TIMEOUT_MS: 'invalid'
		});
		const transporter = { sendMail: jest.fn() };
		createTransport.mockReturnValue(transporter);

		await expect(createEmailTransporter(config)).resolves.toBe(
			transporter
		);
		expect(createTransport).toHaveBeenCalledWith(
			{
				host: 'localhost',
				port: 2525,
				secure: false,
				connectionTimeout: 5000,
				greetingTimeout: 5000,
				socketTimeout: 15_000,
				auth: { user: 'mailer', pass: 'password' }
			},
			{ from: '"winwidget.ru" <no-reply@winwidget.ru>' }
		);
	});
});
