import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IdentityInternalClient } from './identity-internal.client';

const TOKEN = 'core-identity-test-token-at-least-32-characters';

const createClient = (overrides: Record<string, string> = {}) => {
	const values = {
		IDENTITY_CORE_TOKEN: TOKEN,
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		...overrides
	};
	return new IdentityInternalClient({
		get: jest.fn((key: string) => values[key as keyof typeof values])
	} as unknown as ConfigService);
};

describe('IdentityInternalClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		'https://127.0.0.1:4900',
		'http://identity:4900',
		'http://10.0.0.4:4900',
		'http://127.0.0.1:4900/path'
	])('rejects unsafe internal origin %s', value => {
		expect(() =>
			createClient({ IDENTITY_INTERNAL_BASE_URL: value })
		).toThrow('exact private loopback');
	});

	it.each(['short', 'change_me', 'identity_core_token'])(
		'rejects weak scoped credential %s',
		value => {
			expect(() => createClient({ IDENTITY_CORE_TOKEN: value })).toThrow(
				'non-placeholder secret'
			);
		}
	);

	it('sends the Core-scoped credential and validates exact actor schema', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					active: true,
					subject: 'user-id',
					sessionId: '22222222-2222-4222-8222-222222222222',
					roles: ['ADMIN']
				}),
				{ status: 200 }
			)
		);

		await expect(
			createClient().introspect('Bearer access-token')
		).resolves.toMatchObject({ subject: 'user-id', roles: ['ADMIN'] });
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/auth/introspect',
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: 'Bearer access-token',
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('preserves frozen session errors and maps credential/schema failures to 503', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						statusCode: 401,
						message: 'Invalid session',
						error: 'Unauthorized',
						code: 'http_error'
					}),
					{ status: 401 }
				)
			)
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ active: true, subject: 'expanded' }),
					{
						status: 200
					}
				)
			);
		await expect(
			createClient().introspect('Bearer invalid')
		).rejects.toMatchObject({ response: { message: 'Invalid session' } });
		await expect(
			createClient().introspect('Bearer valid')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			createClient().introspect('Bearer valid')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('does not expose an invalid scoped credential as a user-auth failure', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					statusCode: 401,
					message: 'Invalid internal credentials',
					error: 'Unauthorized'
				}),
				{ status: 401 }
			)
		);
		await expect(
			createClient().introspect('Bearer valid')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('loads ordered audit snapshots through the Core-scoped directory', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{ id: 'admin-id', name: 'Admin', email: 'admin@example.com' },
						{ id: 'target-id', name: null, email: null }
					]
				}),
				{ status: 200 }
			)
		);

		await expect(
			createClient().getAuditSnapshots(['admin-id', 'target-id'])
		).resolves.toEqual(
			new Map([
				[
					'admin-id',
					{ id: 'admin-id', name: 'Admin', email: 'admin@example.com' }
				],
				['target-id', { id: 'target-id', name: null, email: null }]
			])
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/core/audit-snapshots',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userIds: ['admin-id', 'target-id'] }),
				headers: expect.objectContaining({
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('rejects reordered or expanded audit snapshot responses', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{ id: 'target-id', name: null, email: null },
						{ id: 'admin-id', name: null, email: null }
					]
				}),
				{ status: 200 }
			)
		);

		await expect(
			createClient().getAuditSnapshots(['admin-id', 'target-id'])
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('loads provider health through the Core-scoped bounded endpoint', async () => {
		const checks = [
			{
				id: 'smtp',
				title: 'Email SMTP',
				status: 'ok',
				message: 'Подключение работает',
				latencyMs: 12
			},
			{
				id: 'smsaero',
				title: 'SMS Aero',
				status: 'warning',
				message: 'SMS Aero не настроен'
			},
			{
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'disabled',
				message: 'reCAPTCHA отключена настройками'
			}
		];
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ service: 'identity', checks }), {
				status: 200
			})
		);

		await expect(createClient().getProviderHealth()).resolves.toEqual(
			checks
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/core/admin-health',
			expect.objectContaining({
				headers: expect.objectContaining({
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': TOKEN
				})
			})
		);
	});

	it('rejects oversized, reordered, or expanded provider health responses', async () => {
		const validChecks = [
			{
				id: 'smtp',
				title: 'Email SMTP',
				status: 'ok',
				message: 'Подключение работает'
			},
			{
				id: 'smsaero',
				title: 'SMS Aero',
				status: 'ok',
				message: 'Подключение работает'
			},
			{
				id: 'recaptcha',
				title: 'reCAPTCHA',
				status: 'ok',
				message: 'Ключ настроен'
			}
		];
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(
				new Response('', {
					status: 200,
					headers: { 'content-length': String(16 * 1024 + 1) }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						service: 'identity',
						checks: [...validChecks].reverse()
					}),
					{ status: 200 }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						service: 'identity',
						checks: validChecks.map((check, index) =>
							index === 0 ? { ...check, secret: 'not-allowed' } : check
						)
					}),
					{ status: 200 }
				)
			);

		await expect(
			createClient().getProviderHealth()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			createClient().getProviderHealth()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			createClient().getProviderHealth()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
