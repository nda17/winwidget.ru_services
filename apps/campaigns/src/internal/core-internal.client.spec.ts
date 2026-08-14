import { CoreInternalClient } from './core-internal.client';
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const TOKEN = 'campaigns-test-token-at-least-32-characters';
const BILLING_TOKEN =
	'billing-campaigns-test-token-at-least-32-characters';

function createConfig(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function createClient(
	overrides: Record<string, string> = {},
	runtime = { apiEnabled: true, workerEnabled: false }
) {
	return new CoreInternalClient(
		createConfig({
			IDENTITY_CAMPAIGNS_TOKEN: TOKEN,
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
			BILLING_CAMPAIGNS_TOKEN: BILLING_TOKEN,
			BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
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
				IDENTITY_INTERNAL_BASE_URL: url
			})
		).toThrow('IDENTITY_INTERNAL_BASE_URL');
	});

	it.each([
		'short',
		'XYZXYZXYZ',
		'campaigns_internal_token',
		'ci_identity_campaigns_token_at_least_32_chars',
		'ci_campaigns_internal_token_at_least_32_chars'
	])('rejects weak internal token %s', token => {
		expect(() =>
			createClient({ IDENTITY_CAMPAIGNS_TOKEN: token })
		).toThrow('at least 32 characters');
	});

	it('does not require an internal token in publisher-only role', () => {
		expect(() =>
			createClient(
				{ IDENTITY_CAMPAIGNS_TOKEN: '' },
				{ apiEnabled: false, workerEnabled: false }
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
			'http://127.0.0.1:4900/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer user-token',
					'x-winwidget-service': 'campaigns',
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

	it('maps a rejected Campaigns credential to 503 instead of user logout', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 403 }));
		await expect(
			createClient().introspect('Bearer user-token')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('uses a separate Campaigns-scoped Billing credential for subscriber snapshots', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response('{}\n', {
				status: 200,
				headers: { 'content-type': 'application/x-ndjson' }
			})
		);
		await createClient(
			{},
			{ apiEnabled: false, workerEnabled: true }
		).exportActiveSubscriberIds();
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4800/internal/v1/billing/campaigns/active-subscriber-ids',
			expect.objectContaining({
				headers: expect.objectContaining({
					'x-winwidget-service': 'campaigns',
					'x-winwidget-internal-token': BILLING_TOKEN
				})
			})
		);
	});
});
