import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { WidgetsCallbackOtpProvider } from './widgets-callback-otp.transport';

jest.mock('nodemailer', () => ({
	__esModule: true,
	default: { createTransport: jest.fn() }
}));

const config = (values: Record<string, string>) =>
	({ get: (key: string) => values[key] }) as ConfigService;

describe('WidgetsCallbackOtpProvider', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.clearAllMocks();
	});

	it('validates partial provider groups without exposing credentials', () => {
		expect(
			() =>
				new WidgetsCallbackOtpProvider(
					config({ SMTP_SERVER: 'smtp.example.test' })
				)
		).toThrow('SMTP callback OTP configuration is incomplete');
		expect(
			() =>
				new WidgetsCallbackOtpProvider(
					config({
						SMSAERO_EMAIL: 'service@example.test',
						SMSAERO_API_KEY: 'provider-key'
					})
				)
		).toThrow('SMS Aero callback OTP configuration is incomplete');
	});

	it('uses bounded SMTP settings and sends a plain OTP email', async () => {
		const sendMail = jest.fn().mockResolvedValue(undefined);
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail
		});
		const provider = new WidgetsCallbackOtpProvider(
			config({
				MODE: 'production',
				SMTP_SERVER: 'smtp.example.test',
				SMTP_PORT: '465',
				SMTP_SECURE: 'true',
				SMTP_LOGIN: 'sender@example.test',
				SMTP_PASSWORD: 'smtp-password'
			})
		);

		expect(provider.isEmailConfigured()).toBe(true);
		expect(provider.isSmsConfigured()).toBe(false);
		await provider.sendEmail('visitor@example.test', '123456');
		expect(nodemailer.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				host: 'smtp.example.test',
				port: 465,
				secure: true,
				auth: {
					user: 'sender@example.test',
					pass: 'smtp-password'
				}
			})
		);
		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'visitor@example.test',
				text: expect.stringContaining('123456')
			})
		);
	});

	it('uses SMS Aero Basic auth and fails closed on provider failure', async () => {
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ success: true })
		} as Response) as typeof fetch;
		const provider = new WidgetsCallbackOtpProvider(
			config({
				SMSAERO_EMAIL: 'service@example.test',
				SMSAERO_API_KEY: 'provider-key',
				SMSAERO_SIGN: 'WinWidget'
			})
		);

		await provider.sendSms('+79991234567', '654321');
		const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [
			string,
			RequestInit
		];
		expect(url).toContain('https://gate.smsaero.ru/v2/sms/send?');
		expect(url).toContain('number=79991234567');
		expect(url).toContain('text=');
		expect(options).toMatchObject({
			method: 'GET',
			headers: { Authorization: expect.stringMatching(/^Basic /) }
		});

		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: false })
		});
		await expect(
			provider.sendSms('+79991234567', '654321')
		).rejects.toThrow('provider returned failure');
	});
});
