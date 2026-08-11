import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { CoreInternalClient } from '../internal/core-internal.client';
import type { BillingRuntimeService } from '../runtime/billing-runtime.service';
import { BillingAuthGuard } from './billing-auth.guard';

describe('BillingAuthGuard', () => {
	const context = (request: Record<string, unknown>) =>
		({
			switchToHttp: () => ({ getRequest: () => request }),
			getHandler: () => 'handler',
			getClass: () => 'controller'
		}) as unknown as ExecutionContext;

	it('rejects absent and malformed bearer tokens before introspection', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue([])
		};
		const core = { introspect: jest.fn() };
		const guard = new BillingAuthGuard(reflector as never, core as never);

		await expect(
			guard.canActivate(context({ headers: {} }))
		).rejects.toBeInstanceOf(UnauthorizedException);
		await expect(
			guard.canActivate(
				context({ headers: { authorization: 'bearer invalid' } })
			)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(core.introspect).not.toHaveBeenCalled();
	});

	it('fails closed when a route has no explicit access policy', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(undefined)
		};
		const core = { introspect: jest.fn() };
		const guard = new BillingAuthGuard(reflector as never, core as never);

		await expect(
			guard.canActivate(
				context({ headers: { authorization: 'Bearer access-token' } })
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(core.introspect).not.toHaveBeenCalled();
	});

	it('uses current Core roles and attaches the exact actor', async () => {
		const actor = {
			active: true as const,
			subject: 'user-1',
			sessionId: 'session-1',
			roles: ['USER', 'ADMIN'] as const
		};
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN'])
		};
		const core = { introspect: jest.fn().mockResolvedValue(actor) };
		const guard = new BillingAuthGuard(reflector as never, core as never);
		const request = {
			headers: { authorization: 'Bearer access-token' }
		};

		await expect(guard.canActivate(context(request))).resolves.toBe(true);
		expect(core.introspect).toHaveBeenCalledWith('Bearer access-token');
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
		const core = { introspect: jest.fn().mockResolvedValue(actor) };
		const guard = new BillingAuthGuard(reflector as never, core as never);
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
		expect(core.introspect).toHaveBeenCalledWith('Bearer access-token');
	});

	it('preserves the legacy role-denied response', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['DEV'])
		};
		const core = {
			introspect: jest.fn().mockResolvedValue({
				active: true,
				subject: 'user-1',
				sessionId: 'session-1',
				roles: ['ADMIN']
			})
		};
		const guard = new BillingAuthGuard(reflector as never, core as never);

		await expect(
			guard.canActivate(
				context({ headers: { authorization: 'Bearer access-token' } })
			)
		).rejects.toThrow('У тебя нет прав!');
	});
});

describe('CoreInternalClient auth contract', () => {
	const token = 'billing-test-internal-token-1234567890';
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
	});

	const createClient = (baseUrl = 'http://127.0.0.1:4200') => {
		const values: Record<string, string> = {
			BILLING_CORE_INTERNAL_BASE_URL: baseUrl,
			BILLING_INTERNAL_TOKEN: token,
			BILLING_INTERNAL_TIMEOUT_MS: '10000'
		};
		const config = {
			get: jest.fn((key: string) => values[key])
		} as unknown as ConfigService;
		const runtime = {
			apiEnabled: true,
			workerEnabled: false
		} as BillingRuntimeService;
		return new CoreInternalClient(config, runtime);
	};

	it('accepts only an exact private loopback origin', () => {
		expect(() => createClient('https://127.0.0.1:4200')).toThrow(
			'must use http'
		);
		expect(() => createClient('http://core:4200')).toThrow(
			'must be an exact loopback origin'
		);
		expect(() => createClient('http://127.0.0.1:4200/path')).toThrow(
			'must be an exact loopback origin'
		);
	});

	it('proxies a bounded exact Core 401 response', async () => {
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
