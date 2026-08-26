import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { IdentityInternalClient } from '../internal/identity-internal.client';
import type { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { BillingAuthGuard } from './billing-auth.guard';

describe('BillingAuthGuard', () => {
	const context = (request: Record<string, unknown>) =>
		({
			switchToHttp: () => ({ getRequest: () => request }),
			getHandler: () => 'handler',
			getClass: () => 'controller'
		}) as unknown as ExecutionContext;

	it('preserves the legacy absent and malformed bearer errors', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue([])
		};
		const identity = { introspect: jest.fn() };
		const guard = new BillingAuthGuard(
			reflector as never,
			identity as never
		);

		const absent = await guard
			.canActivate(context({ headers: {} }))
			.catch(value => value);
		expect(absent).toBeInstanceOf(UnauthorizedException);
		expect(absent.getResponse()).toEqual({
			message: 'Unauthorized',
			statusCode: 401
		});

		const malformed = await guard
			.canActivate(
				context({ headers: { authorization: 'bearer invalid' } })
			)
			.catch(value => value);
		expect(malformed).toBeInstanceOf(UnauthorizedException);
		expect(malformed.getResponse()).toEqual({
			message: 'Invalid access token',
			error: 'Unauthorized',
			statusCode: 401
		});
		expect(identity.introspect).not.toHaveBeenCalled();
	});

	it('fails closed when a route has no explicit access policy', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(undefined)
		};
		const identity = { introspect: jest.fn() };
		const guard = new BillingAuthGuard(
			reflector as never,
			identity as never
		);

		await expect(
			guard.canActivate(
				context({ headers: { authorization: 'Bearer access-token' } })
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(identity.introspect).not.toHaveBeenCalled();
	});

	it('uses current Identity roles and attaches the exact actor', async () => {
		const actor = {
			active: true as const,
			subject: 'user-1',
			sessionId: 'session-1',
			roles: ['USER', 'ADMIN'] as const
		};
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN'])
		};
		const identity = { introspect: jest.fn().mockResolvedValue(actor) };
		const guard = new BillingAuthGuard(
			reflector as never,
			identity as never
		);
		const request = {
			headers: { authorization: 'Bearer access-token' }
		};

		await expect(guard.canActivate(context(request))).resolves.toBe(true);
		expect(identity.introspect).toHaveBeenCalledWith(
			'Bearer access-token'
		);
		expect(request).toEqual(
			expect.objectContaining({ billingActor: actor })
		);
	});

	it('ignores spoofed identity headers and replaces any pre-attached actor', async () => {
		const actor = {
			active: true as const,
			subject: 'user-1',
			sessionId: 'session-1',
			roles: ['USER'] as const
		};
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['USER'])
		};
		const identity = { introspect: jest.fn().mockResolvedValue(actor) };
		const guard = new BillingAuthGuard(
			reflector as never,
			identity as never
		);
		const request = {
			headers: {
				authorization: 'Bearer access-token',
				'x-user-id': 'spoofed-admin',
				'x-user-role': 'DEV'
			},
			billingActor: {
				active: true,
				subject: 'spoofed-admin',
				sessionId: 'spoofed-session',
				roles: ['DEV']
			}
		};

		await expect(guard.canActivate(context(request))).resolves.toBe(true);
		expect(request.billingActor).toBe(actor);
		expect(identity.introspect).toHaveBeenCalledWith(
			'Bearer access-token'
		);
	});

	it('preserves the legacy role-denied response', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['DEV'])
		};
		const identity = {
			introspect: jest.fn().mockResolvedValue({
				active: true,
				subject: 'user-1',
				sessionId: 'session-1',
				roles: ['ADMIN']
			})
		};
		const guard = new BillingAuthGuard(
			reflector as never,
			identity as never
		);

		await expect(
			guard.canActivate(
				context({ headers: { authorization: 'Bearer access-token' } })
			)
		).rejects.toThrow('У тебя нет прав!');
	});
});

describe('IdentityInternalClient auth contract', () => {
	const token = 'billing-test-internal-token-1234567890';
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	const createClient = (
		baseUrl = 'http://127.0.0.1:4900',
		identityToken = token
	) => {
		const values: Record<string, string> = {
			IDENTITY_INTERNAL_BASE_URL: baseUrl,
			IDENTITY_BILLING_TOKEN: identityToken
		};
		const config = {
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService;
		const runtime = {
			apiEnabled: true,
			workerEnabled: false
		} as BillingRuntimeService;
		return new IdentityInternalClient(config, runtime);
	};

	it('accepts only an exact private loopback origin', () => {
		expect(() => createClient('https://127.0.0.1:4200')).toThrow(
			'must use http'
		);
		expect(() => createClient('http://remote-service:4200')).toThrow(
			'must be an exact loopback origin'
		);
		expect(() => createClient('http://127.0.0.1:4200/path')).toThrow(
			'must be an exact loopback origin'
		);
	});

	it('rejects the documented Identity CI placeholder', () => {
		expect(() =>
			createClient(
				'http://127.0.0.1:4900',
				'ci_identity_billing_token_at_least_32_chars'
			)
		).toThrow('IDENTITY_BILLING_TOKEN');
	});

	it('proxies a bounded exact Identity 401 response', async () => {
		global.fetch = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					statusCode: 401,
					message: 'Invalid session',
					error: 'Unauthorized',
					code: 'invalid_session'
				}),
				{
					status: 401,
					headers: { 'content-type': 'application/json' }
				}
			)
		) as typeof fetch;

		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toMatchObject({
			status: 401,
			response: {
				statusCode: 401,
				message: 'Invalid session',
				error: 'Unauthorized',
				code: 'invalid_session'
			}
		});
	});

	it('maps a rejected Billing credential to 503 instead of user logout', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response(null, { status: 403 })
			) as typeof fetch;

		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('rejects an expanded or malformed actor response', async () => {
		global.fetch = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'user-1',
					sessionId: 'session-1',
					roles: ['USER'],
					email: 'must-not-cross-boundary@example.com'
				}),
				{ status: 200 }
			)
		) as typeof fetch;

		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('maps transport failures to a stable 503 without leaking details', async () => {
		global.fetch = jest
			.fn()
			.mockRejectedValue(
				new Error('connect ECONNREFUSED token=secret')
			) as typeof fetch;

		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toThrow('Authorization service is unavailable');
	});
});
