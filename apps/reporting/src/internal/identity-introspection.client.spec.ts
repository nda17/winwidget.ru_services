import { IdentityIntrospectionClient } from './identity-introspection.client';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const TOKEN = 'identity-reporting-test-token-at-least-32-characters';

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new IdentityIntrospectionClient(
		config({
			IDENTITY_REPORTING_TOKEN: TOKEN,
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
			...overrides
		}),
		{ apiEnabled: true } as never
	);
}

describe('IdentityIntrospectionClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		'http://identity:4900',
		'http://10.0.0.2:4900',
		'https://127.0.0.1:4900',
		'http://127.0.0.1:4900/base'
	])('rejects non-loopback or non-origin URL %s', url => {
		expect(() => client({ IDENTITY_INTERNAL_BASE_URL: url })).toThrow(
			'IDENTITY_INTERNAL_BASE_URL'
		);
	});

	it('rejects the documented Identity CI placeholder', () => {
		expect(() =>
			client({
				IDENTITY_REPORTING_TOKEN:
					'ci_identity_reporting_token_at_least_32_chars'
			})
		).toThrow('IDENTITY_REPORTING_TOKEN');
	});

	it('forwards bearer, service token and correlation ID directly to Identity', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'admin-id',
					sessionId: 'session-id',
					roles: ['ADMIN']
				}),
				{ status: 200 }
			)
		);
		await client().introspect(
			'Bearer user-token',
			'22222222-2222-4222-8222-222222222222'
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer user-token',
					'x-winwidget-service': 'reporting',
					'x-winwidget-internal-token': TOKEN,
					'x-correlation-id': '22222222-2222-4222-8222-222222222222'
				})
			})
		);
	});

	it('fails closed when introspection is unavailable', async () => {
		jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('maps a rejected Reporting credential to 503 instead of user logout', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			client().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
