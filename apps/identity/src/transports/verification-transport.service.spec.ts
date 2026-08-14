import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import {
	PASSWORD_EMAIL_SUBJECT,
	VERIFICATION_EMAIL_SUBJECT,
	VerificationTransportService
} from './verification-transport.service';

jest.mock('nodemailer', () => ({
	__esModule: true,
	default: { createTransport: jest.fn() }
}));

function config(values: Record<string, string>): ConfigService {
	return { get: (name: string) => values[name] } as ConfigService;
}

describe('VerificationTransportService frozen provider contract', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.clearAllMocks();
	});

	it('uses existing SMTP_* keys and MODE=development port 2525', async () => {
		const sendMail = jest.fn();
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail
		});
		const service = new VerificationTransportService(
			config({
				SMTP_SERVER: '127.0.0.1',
				SMTP_LOGIN: 'local-user',
				SMTP_PASSWORD: 'local-password',
				MODE: 'development'
			})
		);
		expect(nodemailer.createTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				host: '127.0.0.1',
				port: 2525,
				secure: false,
				auth: { user: 'local-user', pass: 'local-password' }
			})
		);
		await service.emailCode('user@example.com', '123456');
		await service.newPassword('user@example.com', 'TempPass1');
		expect(sendMail).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				to: 'user@example.com',
				subject: VERIFICATION_EMAIL_SUBJECT,
				html: expect.stringContaining('123456')
			})
		);
		expect(sendMail).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				subject: PASSWORD_EMAIL_SUBJECT,
				html: expect.stringContaining('TempPass1')
			})
		);
	});

	it('uses the SmsAero endpoint and canonical Russian phone number', async () => {
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail: jest.fn()
		});
		global.fetch = jest.fn().mockResolvedValue({
			ok: true,
			headers: { get: () => 'application/json' },
			json: () => Promise.resolve({ success: true })
		} as unknown as globalThis.Response) as typeof fetch;
		const service = new VerificationTransportService(
			config({
				SMSAERO_EMAIL: 'test@example.com',
				SMSAERO_API_KEY: 'test-api-key',
				SMSAERO_SIGN: 'WinWidget'
			})
		);
		await service.smsCode('(999) 123-45-67', '123456');
		const [target, options] = (global.fetch as jest.Mock).mock
			.calls[0] as [string, RequestInit];
		expect(target).toContain('https://gate.smsaero.ru/v2/sms/send?');
		expect(target).toContain('number=79991234567');
		expect(target).toContain('sign=WinWidget');
		expect(options).toMatchObject({
			method: 'GET',
			headers: { Authorization: expect.stringMatching(/^Basic /) }
		});
	});
});
