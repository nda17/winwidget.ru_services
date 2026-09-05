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
	it('uses the independent exact owner-context endpoint without forwarding a user JWT', async () => {
		const membership = response().memberships[0];
		const value = {
			schemaVersion: 1,
			workspaceId: membership.workspaceId,
			subject: 'user-1',
			membership,
			ownerSubject: 'user-1'
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify(value)));
		expect(
			await client().widgetSourceContext(
				value.workspaceId,
				'user-1',
				CORRELATION_ID
			)
		).toEqual(value);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/crm-access/widget-source-context',
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				cache: 'no-store',
				headers: expect.objectContaining({
					'x-winwidget-service': 'crm-access',
					'x-winwidget-internal-token': TOKEN
				}),
				body: JSON.stringify({
					schemaVersion: 1,
					workspaceId: value.workspaceId,
					subject: 'user-1'
				})
			})
		);
		expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty(
			'authorization'
		);
	});
	it('accepts a distinct canonical owner for a delegated member and a null denial without leaking ownership', async () => {
		const member = { ...response().memberships[0], role: 'MEMBER' };
		const value = {
			schemaVersion: 1,
			workspaceId: member.workspaceId,
			subject: 'administrator',
			membership: member,
			ownerSubject: 'owner-😀'
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(value)));
		expect(
			await client().widgetSourceContext(
				value.workspaceId,
				value.subject,
				CORRELATION_ID
			)
		).toEqual(value);
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ ...value, membership: null, ownerSubject: null })
			)
		);
		expect(
			await client().widgetSourceContext(
				value.workspaceId,
				value.subject,
				CORRELATION_ID
			)
		).toMatchObject({ membership: null, ownerSubject: null });
	});
	it('rejects owner-context drift, cross-binding, unsupported scalar values, and hidden profile fields', async () => {
		const membership = response().memberships[0];
		const value = {
			schemaVersion: 1,
			workspaceId: membership.workspaceId,
			subject: 'user-1',
			membership,
			ownerSubject: 'user-1'
		};
		const fetchMock = jest.spyOn(global, 'fetch');
		for (const change of [
			{ schemaVersion: 2 },
			{ workspaceId: CORRELATION_ID },
			{ subject: 'foreign' },
			{ email: 'not-part-of-the-contract@example.test' },
			{ ownerSubject: undefined },
			{ ownerSubject: null },
			{ ownerSubject: 'foreign' },
			{ membership: null },
			{ membership: { ...membership, role: 'MEMBER' } },
			{
				membership: { ...membership, role: ['MEMBER'] },
				ownerSubject: 'other'
			},
			{
				membership: { ...membership, role: ['OWNER'] },
				ownerSubject: 'other'
			},
			{
				membership: { ...membership, role: { role: 'MEMBER' } },
				ownerSubject: 'other'
			},
			{ membership: { ...membership, workspaceId: CORRELATION_ID } },
			{ membership: { ...membership, membershipId: 'bad' } },
			...['', ' owner', 'a'.repeat(257), '\uFFFD', '\uD800', '\uDC00'].map(
				ownerSubject => ({
					membership: { ...membership, role: 'MEMBER' },
					ownerSubject
				})
			)
		]) {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ ...value, ...change }))
			);
			await expect(
				client().widgetSourceContext(
					value.workspaceId,
					value.subject,
					CORRELATION_ID
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	});
	it('bounds owner-context responses and fails closed on HTTP, network and invalid input errors', async () => {
		const workspaceId = response().memberships[0].workspaceId;
		const fetchMock = jest.spyOn(global, 'fetch');
		for (const status of [301, 401, 403, 404, 500]) {
			fetchMock.mockResolvedValueOnce(
				new Response('private-untrusted-body', { status })
			);
			await expect(
				client().widgetSourceContext(workspaceId, 'user-1', CORRELATION_ID)
			).rejects.toThrow('Widget source identity is unavailable');
		}
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ data: 'x'.repeat(1024 * 1024) }))
		);
		await expect(
			client().widgetSourceContext(workspaceId, 'user-1', CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		fetchMock.mockRejectedValueOnce(new Error('private-network-error'));
		await expect(
			client().widgetSourceContext(workspaceId, 'user-1', CORRELATION_ID)
		).rejects.toThrow('Widget source identity is unavailable');
		fetchMock.mockClear();
		await expect(
			client().widgetSourceContext('bad', 'user-1', CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		await expect(
			client().widgetSourceContext(workspaceId, '\uD800', CORRELATION_ID)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('uses only the scoped service credential for fresh source authority and validates its exact workspace/subject', async () => {
		const workspaceId = response().memberships[0].workspaceId;
		const result = {
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			membership: response().memberships[0]
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(result)));
		expect(
			await client().sourceContext(workspaceId, 'user-1', CORRELATION_ID)
		).toEqual(result);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4900/internal/v1/crm-access/source-context',
			expect.objectContaining({
				redirect: 'error',
				body: JSON.stringify({
					schemaVersion: 1,
					workspaceId,
					subject: 'user-1'
				}),
				headers: expect.not.objectContaining({
					authorization: expect.anything()
				})
			})
		);
		for (const change of [
			{ subject: 'other' },
			{ workspaceId: CORRELATION_ID },
			{ email: 'private@example.test' },
			{ membership: { ...result.membership, role: 'ADMIN' } }
		]) {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify({ ...result, ...change }))
			);
			await expect(
				client().sourceContext(workspaceId, 'user-1', CORRELATION_ID)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	});
	it('returns missing source membership as a denial decision, not a synthetic session', async () => {
		const workspaceId = response().memberships[0].workspaceId;
		const result = {
			schemaVersion: 1,
			workspaceId,
			subject: 'user-1',
			membership: null
		};
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(result)));
		expect(
			await client().sourceContext(workspaceId, 'user-1', CORRELATION_ID)
		).toEqual(result);
	});

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
