import {
	BadRequestException,
	ExecutionContext,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RecaptchaGuard } from './recaptcha.guard';

describe('reCAPTCHA outage classification', () => {
	const originalFetch = global.fetch;
	afterEach(() => {
		global.fetch = originalFetch;
	});
	function guard() {
		return new RecaptchaGuard(
			new ConfigService({
				RECAPTCHA_ENABLED: 'true',
				RECAPTCHA_SECRET_KEY: 'synthetic-only'
			}),
			{ getAllAndOverride: () => 'login' } as unknown as Reflector,
			{ get: async () => ({ recaptchaEnabled: true }) } as never
		);
	}
	const context = {
		getHandler: () => null,
		getClass: () => null,
		switchToHttp: () => ({
			getRequest: () => ({ header: () => 'synthetic-token' })
		})
	} as unknown as ExecutionContext;

	it.each(['network', 'http', 'invalid-json', 'null-json'])(
		'classifies %s as explicit unavailable, retaining status/message',
		async kind => {
			global.fetch = jest.fn(async () => {
				if (kind === 'network') throw new Error('private provider detail');
				return kind === 'http'
					? new Response('', { status: 503 })
					: new Response(kind === 'invalid-json' ? '{' : 'null');
			}) as typeof fetch;
			try {
				await guard().canActivate(context);
				throw new Error('expected rejection');
			} catch (error) {
				expect(error).toBeInstanceOf(ServiceUnavailableException);
				expect(
					(error as ServiceUnavailableException).getResponse()
				).toEqual({
					code: 'recaptcha_unavailable',
					message: 'Не удалось проверить reCAPTCHA. Попробуйте позже.'
				});
			}
		}
	);

	it.each([
		{ success: false },
		{ success: true, action: 'login', score: 0.1 },
		{ success: true, action: 'register', score: 0.9 }
	])('does not turn a rejected token into outage: %j', async body => {
		global.fetch = jest.fn(async () =>
			Response.json(body)
		) as typeof fetch;
		await expect(guard().canActivate(context)).rejects.toBeInstanceOf(
			BadRequestException
		);
	});

	it('accepts a successful high-score token unchanged', async () => {
		global.fetch = jest.fn(async () =>
			Response.json({ success: true, action: 'login', score: 0.9 })
		) as typeof fetch;
		await expect(guard().canActivate(context)).resolves.toBe(true);
	});
});
