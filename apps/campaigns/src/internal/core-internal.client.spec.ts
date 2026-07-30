import { CoreInternalClient } from './core-internal.client';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';

const TOKEN = 'campaigns-test-token-at-least-32-characters';

function createClient(
	overrides: Record<string, string> = {},
	runtime = { apiEnabled: true, workerEnabled: false }
) {
	return new CoreInternalClient(
		new ConfigService({
			CAMPAIGNS_INTERNAL_TOKEN: TOKEN,
			CAMPAIGNS_CORE_INTERNAL_BASE_URL: 'http://127.0.0.1:4200',
			...overrides
		}),
		runtime as never
	);
}

describe('CoreInternalClient hardening', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it.each([
		'http://core:4200',
		'http://10.0.0.2:4200',
		'https://127.0.0.1:4200',
		'http://127.0.0.1:4200/base'
	])('rejects non-loopback or non-origin URL %s', url => {
		expect(() =>
			createClient({
				CAMPAIGNS_CORE_INTERNAL_BASE_URL: url
			})
		).toThrow('CAMPAIGNS_CORE_INTERNAL_BASE_URL');
	});

	it.each([
		'short',
		'XYZXYZXYZ',
		'campaigns_internal_token',
		'ci_campaigns_internal_token_at_least_32_chars'
	])('rejects weak internal token %s', token => {
		expect(() =>
			createClient({ CAMPAIGNS_INTERNAL_TOKEN: token })
		).toThrow('at least 32 characters');
	});

	it('does not require an internal token in publisher-only role', () => {
		expect(
			() =>
				new CoreInternalClient(
					new ConfigService({
						CAMPAIGNS_CORE_INTERNAL_BASE_URL: 'http://127.0.0.1:4200'
					}),
					{ apiEnabled: false, workerEnabled: false } as never
				)
		).not.toThrow();
	});

	it('forwards bearer and service credentials to introspection', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'admin-id',
					sessionId: 'session-id',
					roles: ['ADMIN']
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' }
				}
			)
		);
		await expect(
			createClient().introspect('Bearer user-token')
		).resolves.toEqual(expect.objectContaining({ subject: 'admin-id' }));
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4200/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer user-token',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('fails closed when introspection is unavailable', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockRejectedValue(new Error('connection refused'));
		await expect(
			createClient().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
