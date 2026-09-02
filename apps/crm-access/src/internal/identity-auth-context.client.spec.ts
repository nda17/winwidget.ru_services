import {
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IdentityAuthContextClient } from './identity-auth-context.client';

const TOKEN = 'identity-crm-access-test-token-at-least-32-characters';
const CORRELATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function config(values: Record<string, string>) {
	return {
		get: jest.fn((key: string) => values[key])
	} as unknown as ConfigService;
}

function client(overrides: Record<string, string> = {}) {
	return new IdentityAuthContextClient(
		config({
			IDENTITY_CRM_ACCESS_TOKEN: TOKEN,
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
			IDENTITY_INTERNAL_TIMEOUT_MS: '10000',
			...overrides
		})
	);
}

const response = () => ({
	schemaVersion: 1,
	subject: 'user-1',
	sessionId: '11111111-1111-4111-8111-111111111111',
	memberships: [
		{
			membershipId: '22222222-2222-4222-8222-222222222222',
			workspaceId: '33333333-3333-4333-8333-333333333333',
			role: 'OWNER'
		}
	]
});

describe('IdentityAuthContextClient', () => {
	afterEach(() => jest.restoreAllMocks());

	it('passes the user Bearer token through to scoped Identity auth context', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(response()), { status: 200 })
			);
		await expect(
			client().authContext('Bearer access-token', CORRELATION_ID)
		).resolves.toEqual(response());
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/crm-access/auth-context',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					authorization: 'Bearer access-token',
					'x-winwidget-service': 'crm-access',
					'x-winwidget-internal-token': TOKEN,
					'x-correlation-id': CORRELATION_ID
				})
			})
		);
	});

	it('rejects a missing or malformed Bearer without calling Identity', async () => {
		const fetchMock = jest.spyOn(global, 'fetch');
		await expect(
			client().authContext(undefined, CORRELATION_ID)
		).rejects.toBeInstanceOf(UnauthorizedException);
		await expect(
			client().authContext('Basic token', CORRELATION_ID)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('maps Identity 401 to user authentication failure', async () => {
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(
			client().authContext('Bearer token', CORRELATION_ID)
		).rejects.toBeInstanceOf(UnauthorizedException);
	});

	it.each([
		[new Response(null, { status: 403 })],
		[new Response(null, { status: 500 })],
		[
			new Response(JSON.stringify({ ...response(), extra: true }), {
				status: 200
			})
		],
		[
			new Response(
				JSON.stringify({ ...response(), subject: ' user-1 ' }),
				{ status: 200 }
			)
		]
	])(
		'fails closed for rejected credentials, dependency errors or contract drift',
		async responseValue => {
			jest.spyOn(global, 'fetch').mockResolvedValue(responseValue);
			await expect(
				client().authContext('Bearer token', CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('fails closed when Identity is unreachable', async () => {
		jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
		await expect(
			client().authContext('Bearer token', CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
