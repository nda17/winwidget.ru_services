import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	assertCustomersPermission,
	CustomersAuthorization,
	CustomersAuthorizationClient,
	parseCustomersAccessOrigin,
	parseCustomersAuthorization
} from './customers-authorization.client';

const workspaceId = randomUUID();
const context: CustomersAuthorization = {
	schemaVersion: 1,
	workspaceId,
	subject: 'identity-subject',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['customers:read', 'customers:write']
};

describe('Customers authorization boundary', () => {
	const originalEnv = { ...process.env };
	const originalFetch = global.fetch;
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL =
			'https://crm-internal.example.test';
		process.env.CRM_ACCESS_CRM_CUSTOMERS_TOKEN =
			'customer-pairwise-token-for-unit-tests-only';
		global.fetch = jest
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(context)));
	});
	afterEach(() => {
		process.env = { ...originalEnv };
		global.fetch = originalFetch;
	});

	it('forwards only the exact pairwise identity and fresh bearer request without redirects or caching', async () => {
		const client = new CustomersAuthorizationClient();
		await expect(
			client.authorize('Bearer user-token', workspaceId)
		).resolves.toEqual(context);
		(global.fetch as jest.Mock).mockResolvedValueOnce(
			new Response(JSON.stringify(context))
		);
		await client.authorize('Bearer rotated-token', workspaceId);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(global.fetch).toHaveBeenLastCalledWith(
			'https://crm-internal.example.test/internal/v1/crm-access/authorize',
			expect.objectContaining({
				redirect: 'error',
				method: 'POST',
				headers: expect.objectContaining({
					authorization: 'Bearer rotated-token',
					'x-winwidget-service': 'crm-customers'
				}),
				body: JSON.stringify({ schemaVersion: 1, workspaceId })
			})
		);
	});

	it.each([
		[401, UnauthorizedException],
		[403, ForbiddenException],
		[404, ServiceUnavailableException],
		[500, ServiceUnavailableException],
		[302, ServiceUnavailableException]
	] as const)(
		'fails closed for dependency HTTP %s',
		async (status, ErrorType) => {
			(global.fetch as jest.Mock).mockResolvedValue(
				new Response('{}', { status })
			);
			await expect(
				new CustomersAuthorizationClient().authorize(
					'Bearer token',
					workspaceId
				)
			).rejects.toBeInstanceOf(ErrorType);
		}
	);

	it.each([undefined, '', 'Basic user', 'Bearer token token'])(
		'does not call access for invalid bearer %s',
		async bearer => {
			await expect(
				new CustomersAuthorizationClient().authorize(bearer, workspaceId)
			).rejects.toBeInstanceOf(UnauthorizedException);
			expect(global.fetch).not.toHaveBeenCalled();
		}
	);

	it('rejects oversized, malformed and foreign-workspace responses', async () => {
		for (const body of [
			'x'.repeat(65537),
			'{invalid',
			JSON.stringify({ ...context, workspaceId: randomUUID() })
		]) {
			(global.fetch as jest.Mock).mockResolvedValueOnce(
				new Response(body)
			);
			await expect(
				new CustomersAuthorizationClient().authorize(
					'Bearer token',
					workspaceId
				)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	});

	it('redacts dependency exception details', async () => {
		(global.fetch as jest.Mock).mockRejectedValue(
			new Error('secret-token-and-internal-url')
		);
		await expect(
			new CustomersAuthorizationClient().authorize(
				'Bearer token',
				workspaceId
			)
		).rejects.toMatchObject({
			message: 'CRM access could not be confirmed'
		});
	});

	it.each([
		undefined,
		'http://crm-access:5300',
		'https://host.test/path',
		'https://user:secret@host.test',
		'https://host.test?query=1'
	])('rejects unsafe remote origin %s', value => {
		expect(() => parseCustomersAccessOrigin(value)).toThrow();
	});

	it.each([
		'http://localhost:5300',
		'http://127.0.0.1:5300',
		'https://private.example.test'
	])('accepts exact origin %s', value => {
		expect(parseCustomersAccessOrigin(value)).toBe(value);
	});

	it.each([
		undefined,
		'',
		'change_me_at_least_32_random_characters',
		'short'
	])('requires a concrete pairwise token', token => {
		if (token === undefined)
			delete process.env.CRM_ACCESS_CRM_CUSTOMERS_TOKEN;
		else process.env.CRM_ACCESS_CRM_CUSTOMERS_TOKEN = token;
		expect(() => new CustomersAuthorizationClient()).toThrow(
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN'
		);
	});

	it('rejects unknown fields and duplicate scopes and permissions', () => {
		for (const data of [
			{ ...context, extra: 1 },
			{ ...context, state: 'SUSPENDED' },
			{ ...context, permissions: ['customers:read', 'customers:read'] },
			{ ...context, teamIds: ['bad-id'] },
			{ ...context, subject: 'bad subject' }
		]) {
			expect(parseCustomersAuthorization(data, workspaceId)).toBeNull();
		}
	});

	it('requires independent action permission and writable subscription', () => {
		expect(() =>
			assertCustomersPermission(
				{ ...context, state: 'READ_ONLY' },
				'customers:read'
			)
		).not.toThrow();
		expect(() =>
			assertCustomersPermission(
				{ ...context, state: 'READ_ONLY' },
				'customers:write',
				true
			)
		).toThrow(ForbiddenException);
		expect(() =>
			assertCustomersPermission(
				{ ...context, permissions: [] },
				'customers:read'
			)
		).toThrow(ForbiddenException);
	});
});
