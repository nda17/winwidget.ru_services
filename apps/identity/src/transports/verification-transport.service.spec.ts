import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import {
	PASSWORD_EMAIL_SUBJECT,
	VERIFICATION_EMAIL_SUBJECT,
	VerificationTransportService,
	EmailDeliveryException
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
		jest.restoreAllMocks();
		jest.clearAllMocks();
	});

	it('uses existing SMTP_* keys and MODE=development port 2525', async () => {
		const sendMail = jest.fn();
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail,
			close: jest.fn()
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
				html: expect.stringContaining('123456'),
				attachments: [
					expect.objectContaining({
						path: expect.stringMatching(/assets\/email-logo\.png$/),
						cid: 'winwidget-identity-logo',
						contentDisposition: 'inline'
					})
				]
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
			sendMail: jest.fn(),
			close: jest.fn()
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

	it.each([
		[{ code: 'EAUTH', responseCode: 535 }, 'FAILED'],
		[{ code: 'EENVELOPE', responseCode: 550 }, 'FAILED'],
		[{ code: 'EMESSAGE', responseCode: 451 }, 'FAILED'],
		[{ code: 'EDNS' }, 'FAILED'],
		[{ code: 'ENOENT' }, 'FAILED'],
		[{ code: 'ETIMEDOUT', command: 'CONN' }, 'UNKNOWN'],
		[{ code: 'ESOCKET', command: 'CONN' }, 'UNKNOWN'],
		[{}, 'UNKNOWN']
	])('reports sanitized outcome for %j', async (details, outcome) => {
		const privateMarker =
			'do-not-log-recipient-code-password-provider-response';
		const warn = jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined);
		const close = jest.fn();
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail: jest.fn().mockRejectedValue(
				Object.assign(new Error(privateMarker), details, {
					response: privateMarker,
					rejected: ['private@example.test']
				})
			),
			close
		});
		const service = new VerificationTransportService(
			config({
				SMTP_SERVER: 'smtp.example.test',
				SMTP_LOGIN: 'private@example.test',
				SMTP_PASSWORD: privateMarker
			})
		);
		const attemptId = '00000000-0000-4000-8000-000000000001';
		const failure = await service
			.emailCode('recipient@example.test', '987654', attemptId)
			.catch(error => error);
		expect(failure).toBeInstanceOf(EmailDeliveryException);
		expect(failure.outcome).toBe(outcome);
		expect(failure.getResponse()).toMatchObject({
			code:
				outcome === 'FAILED'
					? 'email_delivery_failed'
					: 'email_delivery_unknown',
			deliveryAttemptId: attemptId
		});
		const log = JSON.stringify(warn.mock.calls);
		expect(log).toContain(attemptId);
		for (const secret of [
			privateMarker,
			'private@example.test',
			'recipient@example.test',
			'987654'
		]) {
			expect(log).not.toContain(secret);
			expect(JSON.stringify(failure.getResponse())).not.toContain(secret);
		}
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('keeps verification and password plaintext alternatives and a non-recipient message ID', async () => {
		const sendMail = jest
			.fn()
			.mockResolvedValue({ response: '250 accepted' });
		const log = jest
			.spyOn(Logger.prototype, 'log')
			.mockImplementation(() => undefined);
		(nodemailer.createTransport as jest.Mock).mockReturnValue({
			sendMail,
			close: jest.fn()
		});
		const service = new VerificationTransportService(
			config({
				SMTP_SERVER: 'smtp.example.test',
				SMTP_LOGIN: 'private@example.test',
				SMTP_PASSWORD: 'private'
			})
		);
		await service.emailCode('recipient@example.test', '123456');
		await service.newPassword('recipient@example.test', 'TempPass1');
		expect(sendMail.mock.calls[0][0]).toMatchObject({
			text: expect.stringContaining('123456')
		});
		expect(sendMail.mock.calls[1][0]).toMatchObject({
			text: expect.stringContaining('Прежний пароль заменится после входа')
		});
		expect(sendMail.mock.calls[0][0].messageId).toMatch(
			/^<[0-9a-f-]{36}@winwidget\.ru>$/
		);
		expect(
			log.mock.calls.every(
				([entry]) => JSON.parse(entry as string).outcome === 'ACCEPTED'
			)
		).toBe(true);
	});
});
