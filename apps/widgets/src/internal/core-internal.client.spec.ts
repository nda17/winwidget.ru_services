import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { CoreInternalClient } from './core-internal.client';

const TOKEN = 'widgets-identity-test-token-at-least-32-characters';

const createClient = (overrides: Record<string, string> = {}) => {
	const values = {
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		IDENTITY_WIDGETS_TOKEN: TOKEN,
		IDENTITY_INTERNAL_TIMEOUT_MS: '5000',
		...overrides
	};
	return new CoreInternalClient(
		{
			get: jest.fn((key: string) => values[key as keyof typeof values])
		} as unknown as ConfigService,
		{ apiEnabled: true } as never
	);
};

describe('Widgets Identity internal client', () => {
	afterEach(() => jest.restoreAllMocks());

	it('uses the Widgets-scoped credential for canonical introspection', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'owner-id',
					sessionId: '22222222-2222-4222-8222-222222222222',
					roles: ['USER']
				}),
				{ status: 200 }
			)
		);

		await createClient().introspect('Bearer access-token');
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer access-token',
					'x-winwidget-service': 'widgets',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('fails closed for malformed Identity responses', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'owner-id',
					sessionId: 'session-id',
					roles: ['USER'],
					email: 'must-not-cross-introspection@example.com'
				}),
				{ status: 200 }
			)
		);
		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('maps a rejected Widgets credential to 503 instead of user logout', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			createClient().introspect('Bearer access-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it.each([
		'short',
		'identity_widgets_token',
		'ci_identity_widgets_token_at_least_32_chars'
	])('rejects weak scoped token %s', token => {
		expect(() => createClient({ IDENTITY_WIDGETS_TOKEN: token })).toThrow(
			'IDENTITY_WIDGETS_TOKEN'
		);
	});
});
