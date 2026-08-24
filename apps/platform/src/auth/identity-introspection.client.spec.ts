import {
	HttpException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IdentityIntrospectionClient } from './identity-introspection.client';

const TOKEN = 'platform-test-token-at-least-32-characters';

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new IdentityIntrospectionClient(
		config({
			IDENTITY_PLATFORM_TOKEN: TOKEN,
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
			IDENTITY_INTERNAL_TIMEOUT_MS: '10000',
			...overrides
		}),
		{ apiEnabled: true } as never
	);
}

const actor = (overrides: Record<string, unknown> = {}) => ({
	active: true,
	subject: 'admin-id',
	sessionId: 'session-id',
	roles: ['ADMIN'],
	...overrides
});

describe('IdentityIntrospectionClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		'http://identity:4900',
		'http://10.0.0.2:4900',
		'https://127.0.0.1:4900',
		'http://127.0.0.1:4900/base'
	])('rejects a non-loopback exact HTTP origin %s', url => {
		expect(() => client({ IDENTITY_INTERNAL_BASE_URL: url })).toThrow(
			'IDENTITY_INTERNAL_BASE_URL'
		);
	});

	it('accepts the exact IPv6 loopback origin', () => {
		expect(() =>
			client({ IDENTITY_INTERNAL_BASE_URL: 'http://[::1]:4900' })
		).not.toThrow();
	});

	it.each(['499', '60001', 'not-a-number'])(
		'rejects an unbounded timeout %s',
		value => {
			expect(() =>
				client({ IDENTITY_INTERNAL_TIMEOUT_MS: value })
			).toThrow('IDENTITY_INTERNAL_TIMEOUT_MS');
		}
	);

	it('forwards the exact Platform service credential', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(actor()), { status: 200 })
			);
		await expect(
			client().introspect('Bearer user-token')
		).resolves.toEqual(actor());
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer user-token',
					'x-winwidget-service': 'platform',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('preserves a valid Identity 401 contract', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					statusCode: 401,
					message: 'Invalid session',
					error: 'Unauthorized'
				}),
				{ status: 401 }
			)
		);
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(HttpException);
	});

	it('maps a rejected Platform credential to 503', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it.each([
		actor({ subject: '' }),
		actor({ sessionId: ' '.repeat(3) }),
		actor({ roles: [1] }),
		actor({ roles: ['ADMIN', 'ADMIN'] }),
		actor({ roles: ['ADMIN', 'DEV', 'USER', 'ADMIN'] }),
		actor({ unexpected: true })
	])('rejects a malformed exact actor response', async value => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(value), { status: 200 })
			);
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('rejects an oversized successful response', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(
					JSON.stringify(actor({ subject: 'x'.repeat(20_000) })),
					{ status: 200 }
				)
			);
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
