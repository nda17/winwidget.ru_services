import { ConfigService } from '@nestjs/config';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthIdentityType, UserStatus } from '@prisma/identity-client';
import express from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';
import { OAuthService } from './oauth.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import { OAuthController } from './oauth.controller';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';

const configuration = {
	RECAPTCHA_CLIENT_URL: 'https://winwidget.ru',
	GOOGLE_CLIENT_ID: 'google-client',
	GOOGLE_CLIENT_SECRET: 'google-secret',
	GOOGLE_CALLBACK_URL:
		'https://api.winwidget.ru/api/v1/auth/google/redirect',
	GITHUB_CLIENT_ID: 'github-client',
	GITHUB_CLIENT_SECRET: 'github-secret',
	GITHUB_CALLBACK_URL:
		'https://api.winwidget.ru/api/v1/auth/github/redirect',
	YANDEX_CLIENT_ID: 'yandex-client',
	YANDEX_CLIENT_SECRET: 'yandex-secret',
	YANDEX_CALLBACK_URL:
		'https://api.winwidget.ru/api/v1/auth/yandex/redirect',
	VK_CLIENT_ID: 'vk-client',
	VK_SERVICE_TOKEN: 'vk-service-token',
	VK_CALLBACK_URL: 'https://api.winwidget.ru/api/v1/auth/vk/redirect'
};

function fetchResponse(value: unknown, ok = true, status = 200) {
	return Promise.resolve({
		ok,
		status,
		json: () => Promise.resolve(value)
	} as unknown as globalThis.Response);
}

function response() {
	return {
		cookie: jest.fn(),
		clearCookie: jest.fn(),
		redirect: jest.fn((url: string) => url)
	} as unknown as Response;
}

function createService(prismaOverrides: Record<string, any> = {}) {
	const prisma = {
		oAuthAuthorization: { create: jest.fn() },
		$transaction: jest.fn(),
		...prismaOverrides
	};
	const auth = { startSession: jest.fn() };
	const settings = { assertProviderEnabled: jest.fn() };
	const refresh = new RefreshTokenService();
	const service = new OAuthService(
		{
			get: (name: keyof typeof configuration) => configuration[name]
		} as ConfigService,
		prisma as any,
		{ emitUserChanged: jest.fn(), emitBillingRequest: jest.fn() } as any,
		settings as any,
		auth as any,
		refresh
	);
	return { service, prisma, auth, refresh, settings };
}

describe('OAuth provider contracts', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('requires a verified Google email', async () => {
		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			)
			.mockImplementationOnce(() =>
				fetchResponse({
					sub: 'google-id',
					email: 'user@example.com',
					email_verified: false
				})
			) as typeof fetch;
		const { service } = createService();
		await expect(
			(service as any).profile('google', 'code', 'verifier')
		).rejects.toThrow('Google OAuth email is not verified');
	});

	it('uses the verified primary GitHub email endpoint and requires provider id', async () => {
		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			)
			.mockImplementationOnce(() =>
				fetchResponse({ id: 42, email: null, login: 'octocat' })
			)
			.mockImplementationOnce(() =>
				fetchResponse([
					{
						email: 'fallback@example.com',
						verified: true,
						primary: false
					},
					{ email: 'PRIMARY@Example.COM', verified: true, primary: true }
				])
			) as typeof fetch;
		const { service } = createService();
		await expect(
			(service as any).profile('github', 'code', 'verifier')
		).resolves.toMatchObject({
			providerId: '42',
			email: 'primary@example.com',
			name: 'octocat'
		});
		expect(global.fetch).toHaveBeenNthCalledWith(
			3,
			'https://api.github.com/user/emails',
			expect.any(Object)
		);

		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			)
			.mockImplementationOnce(() => fetchResponse({ login: 'missing-id' }))
			.mockImplementationOnce(() =>
				fetchResponse([
					{ email: 'user@example.com', verified: true, primary: true }
				])
			) as typeof fetch;
		await expect(
			(service as any).profile('github', 'code', 'verifier')
		).rejects.toThrow('OAuth provider response has no id');
	});

	it('restores the Yandex avatar contract and fails closed without email', async () => {
		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			)
			.mockImplementationOnce(() =>
				fetchResponse({
					id: 'yandex-id',
					default_email: 'user@example.com',
					default_avatar_id: 'avatar-id',
					is_avatar_empty: false
				})
			) as typeof fetch;
		const { service } = createService();
		await expect(
			(service as any).profile('yandex', 'code', 'verifier')
		).resolves.toMatchObject({
			avatarPath:
				'https://avatars.yandex.net/get-yapic/avatar-id/islands-200'
		});

		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			)
			.mockImplementationOnce(() =>
				fetchResponse({ id: 'yandex-id' })
			) as typeof fetch;
		await expect(
			(service as any).profile('yandex', 'code', 'verifier')
		).rejects.toThrow('OAuth provider response has no default_email');
	});

	it('validates VK token state, user id and email instead of coercing undefined', async () => {
		global.fetch = jest.fn().mockImplementationOnce(() =>
			fetchResponse({
				access_token: 'token',
				user_id: 9,
				state: 'other-state'
			})
		) as typeof fetch;
		const { service } = createService();
		await expect(
			(service as any).profile('vk', 'code', 'verifier', 'device', 'state')
		).rejects.toThrow('invalid state');

		global.fetch = jest
			.fn()
			.mockImplementationOnce(() =>
				fetchResponse({ access_token: 'token' })
			) as typeof fetch;
		await expect(
			(service as any).profile('vk', 'code', 'verifier', 'device', 'state')
		).rejects.toThrow('OAuth provider response has no user_id');
	});
});

describe('OAuth callback secret handling', () => {
	const previousMode = process.env.MODE;
	const previousDomain = process.env.AUTH_COOKIE_DOMAIN;

	beforeEach(() => {
		process.env.MODE = 'production';
		process.env.AUTH_COOKIE_DOMAIN = '.winwidget.ru';
	});

	afterEach(() => {
		if (previousMode === undefined) delete process.env.MODE;
		else process.env.MODE = previousMode;
		if (previousDomain === undefined)
			delete process.env.AUTH_COOKIE_DOMAIN;
		else process.env.AUTH_COOKIE_DOMAIN = previousDomain;
		jest.restoreAllMocks();
	});

	it('redirects with no token/code/PII and sets only the HttpOnly refresh cookie', async () => {
		const { service, auth } = createService();
		jest.spyOn(service as any, 'consume').mockResolvedValue({
			codeVerifier: 'verifier',
			referrerId: null
		});
		jest.spyOn(service as any, 'profile').mockResolvedValue({
			providerId: 'provider-id',
			email: 'user@example.com'
		});
		jest
			.spyOn(service as any, 'upsertUser')
			.mockResolvedValue({ id: 'user' });
		auth.startSession.mockResolvedValue({
			refreshToken: 'refresh-secret'
		});
		const target = response();
		await service.callback(
			'google',
			{
				cookies: { identityOAuthState_google: 'state' }
			} as unknown as Request,
			target,
			{ code: 'provider-code', state: 'state' }
		);
		expect(target.redirect).toHaveBeenCalledWith(
			'https://winwidget.ru/social-auth'
		);
		const redirect = (target.redirect as jest.Mock).mock
			.calls[0]?.[0] as string;
		expect(redirect).not.toMatch(
			/[?&](accessToken|refreshToken|code|email)=/i
		);
		expect(target.cookie).toHaveBeenCalledWith(
			'refreshToken',
			'refresh-secret',
			expect.objectContaining({
				httpOnly: true,
				secure: true,
				sameSite: 'none',
				domain: '.winwidget.ru',
				path: '/'
			})
		);
	});

	it('returns the frozen account_deactivated error for an inactive linked user', async () => {
		const inactiveUser = {
			id: 'user',
			status: UserStatus.DEACTIVATED,
			deletedAt: null,
			authIdentities: [],
			telegramNotificationChannel: null
		};
		const transaction = {
			authIdentity: {
				findUnique: jest.fn().mockResolvedValue({
					type: AuthIdentityType.GOOGLE,
					value: 'provider-id',
					user: inactiveUser
				})
			}
		};
		const { service } = createService({
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => unknown) =>
					callback(transaction)
			)
		});
		jest.spyOn(service as any, 'consume').mockResolvedValue({
			codeVerifier: 'verifier',
			referrerId: null
		});
		jest.spyOn(service as any, 'profile').mockResolvedValue({
			providerId: 'provider-id',
			email: 'user@example.com'
		});
		const target = response();
		await service.callback(
			'google',
			{
				cookies: { identityOAuthState_google: 'state' }
			} as unknown as Request,
			target,
			{ code: 'provider-code', state: 'state' }
		);
		expect(target.redirect).toHaveBeenCalledWith(
			'https://winwidget.ru/login?error=account_deactivated'
		);
	});

	it('rejects state mismatch before consuming the authorization', async () => {
		const { service } = createService();
		const consume = jest.spyOn(service as any, 'consume');
		const target = response();
		await service.callback(
			'github',
			{
				cookies: { identityOAuthState_github: 'cookie-state' }
			} as unknown as Request,
			target,
			{ code: 'provider-code', state: 'query-state' }
		);
		expect(consume).not.toHaveBeenCalled();
		expect(target.redirect).toHaveBeenCalledWith(
			'https://winwidget.ru/login?error=social_auth_failed'
		);
	});

	it.each([
		['google', 'Google auth is disabled'],
		['github', 'Github auth is disabled'],
		['yandex', 'Yandex auth is disabled'],
		['vk', 'VK auth is disabled']
	] as const)(
		'rejects a %s callback when the provider is disabled during the flow',
		async (provider, message) => {
			const { service, settings } = createService();
			settings.assertProviderEnabled.mockRejectedValue(
				new ForbiddenException(message)
			);
			const consume = jest.spyOn(service as any, 'consume');
			const target = response();

			await expect(
				service.callback(
					provider,
					{
						cookies: { [`identityOAuthState_${provider}`]: 'state' }
					} as unknown as Request,
					target,
					{ code: 'provider-code', state: 'state', deviceId: 'device' }
				)
			).resolves.toBe(
				'https://winwidget.ru/login?error=social_auth_failed'
			);

			expect(settings.assertProviderEnabled).toHaveBeenCalledWith(
				provider
			);
			expect(consume).not.toHaveBeenCalled();
			expect(target.clearCookie).toHaveBeenCalledWith(
				`identityOAuthState_${provider}`,
				expect.any(Object)
			);
			const clearOptions = (target.clearCookie as jest.Mock).mock
				.calls[0][1];
			expect(clearOptions).toMatchObject({
				httpOnly: true,
				path: `/api/v1/auth/${provider}`,
				sameSite: 'lax',
				secure: true
			});
			expect(clearOptions).not.toHaveProperty('maxAge');
			expect(clearOptions).not.toHaveProperty('expires');
			expect(target.cookie).toHaveBeenCalledTimes(1);
			expect(target.cookie).toHaveBeenCalledWith(
				'refreshToken',
				'',
				expect.objectContaining({
					domain: '.winwidget.ru',
					expires: new Date(0),
					httpOnly: true,
					path: '/',
					sameSite: 'none',
					secure: true
				})
			);
			expect(target.redirect).toHaveBeenCalledWith(
				'https://winwidget.ru/login?error=social_auth_failed'
			);
		}
	);

	it('uses distinct cookie options for setting and clearing OAuth state', async () => {
		const { service } = createService();
		const app = express();
		app.get('/start', (_request, response, next) => {
			void service.start('google', undefined, response).catch(next);
		});
		app.get('/callback', (request, response, next) => {
			void service
				.callback('google', request, response, { error: 'access_denied' })
				.catch(next);
		});

		const started = await request(app).get('/start').expect(302);
		const stateCookie = (
			started.headers['set-cookie'] as unknown as string[]
		).find(value => value.startsWith('identityOAuthState_google='));
		expect(stateCookie).toContain('Max-Age=600');
		expect(stateCookie).toContain('Path=/api/v1/auth/google');

		const cleared = await request(app).get('/callback').expect(302);
		const clearedStateCookie = (
			cleared.headers['set-cookie'] as unknown as string[]
		).find(value => value.startsWith('identityOAuthState_google='));
		expect(clearedStateCookie).toContain(
			'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
		);
		expect(clearedStateCookie).toContain('Path=/api/v1/auth/google');
		expect(clearedStateCookie).not.toContain('Max-Age=');
	});
});

describe('OAuth controller scalar query contract', () => {
	let app: INestApplication;
	const oauth = {
		start: jest.fn(
			(_provider: string, ref: string | undefined, response: Response) =>
				response.status(200).json({ ref: ref ?? null })
		),
		callback: jest.fn()
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [OAuthController],
			providers: [{ provide: OAuthService, useValue: oauth }]
		})
			.overrideGuard(AuthRateLimitGuard)
			.useValue({ canActivate: () => true })
			.compile();
		app = module.createNestApplication();
		await app.init();
	});

	afterAll(() => app.close());

	it('rejects repeated query parameters before calling OAuth', async () => {
		await request(app.getHttpServer())
			.get('/auth/google?ref=first&ref=second')
			.expect(400);
		expect(oauth.start).not.toHaveBeenCalled();
	});

	it('passes one scalar query parameter unchanged', async () => {
		await request(app.getHttpServer())
			.get('/auth/google?ref=single')
			.expect(200, { ref: 'single' });
		expect(oauth.start).toHaveBeenCalledWith(
			'google',
			'single',
			expect.anything()
		);
	});
});
