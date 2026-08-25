import { ConfigService } from '@nestjs/config';
import { IdentityIntrospectionClient } from './identity-introspection.client';

const token = 's'.repeat(48);

function config(serviceToken: string | undefined) {
	return new ConfigService({
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		IDENTITY_INTERNAL_TIMEOUT_MS: '5000',
		IDENTITY_SUPPORT_TOKEN: serviceToken
	});
}

describe('IdentityIntrospectionClient Support scope', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		undefined,
		'',
		'short',
		'change_me_support_token',
		'ci_support_token'
	])('fails closed for a missing or placeholder pairwise token', value => {
		expect(() => new IdentityIntrospectionClient(config(value))).toThrow(
			'IDENTITY_SUPPORT_TOKEN'
		);
	});

	it('uses only the support service scope for introspection', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: '00000000-0000-4000-8000-000000000001',
					sessionId: '00000000-0000-4000-8000-000000000002',
					roles: ['ADMIN']
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);

		await expect(
			new IdentityIntrospectionClient(config(token)).introspect(
				'Bearer access-token'
			)
		).resolves.toMatchObject({ active: true, roles: ['ADMIN'] });
		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://127.0.0.1:4900/internal/v1/auth/introspect'
		);
		expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
			authorization: 'Bearer access-token',
			'x-winwidget-service': 'support',
			'x-winwidget-internal-token': token
		});
	});
});
