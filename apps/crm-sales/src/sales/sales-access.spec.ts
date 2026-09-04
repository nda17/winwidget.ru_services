import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
	parseSalesAccess,
	SalesAccessClient,
	SalesAccessGuard,
	type SalesAccess
} from './sales-access';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner-1',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write', 'sales:analytics']
};

describe('Sales authorization boundary', () => {
	const priorFetch = global.fetch;
	const originalBase = process.env.CRM_ACCESS_INTERNAL_BASE_URL;
	const originalToken = process.env.CRM_ACCESS_CRM_SALES_TOKEN;
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL = 'http://127.0.0.1:5300';
		process.env.CRM_ACCESS_CRM_SALES_TOKEN = 't'.repeat(48);
	});
	afterEach(() => {
		global.fetch = priorFetch;
		if (originalBase === undefined)
			delete process.env.CRM_ACCESS_INTERNAL_BASE_URL;
		else process.env.CRM_ACCESS_INTERNAL_BASE_URL = originalBase;
		if (originalToken === undefined)
			delete process.env.CRM_ACCESS_CRM_SALES_TOKEN;
		else process.env.CRM_ACCESS_CRM_SALES_TOKEN = originalToken;
	});

	it.each([
		{ ...access, workspaceId: '22222222-2222-4222-8222-222222222222' },
		{ ...access, unknown: true },
		{ ...access, teamIds: ['invalid'] },
		{ ...access, subject: '' },
		{ ...access, state: 'ONBOARDING' }
	])('rejects unbound or malformed authorizer response', value => {
		expect(() => parseSalesAccess(value, workspaceId)).toThrow();
	});

	it('fetches fresh access with pairwise authentication for every call', async () => {
		global.fetch = jest
			.fn()
			.mockImplementation(
				async () => new Response(JSON.stringify(access), { status: 200 })
			);
		const client = new SalesAccessClient();
		await client.authorize('Bearer user-token', workspaceId);
		await client.authorize('Bearer user-token', workspaceId);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(global.fetch).toHaveBeenCalledWith(
			'http://127.0.0.1:5300/internal/v1/crm-access/authorize',
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				cache: 'no-store',
				body: JSON.stringify({ schemaVersion: 1, workspaceId }),
				headers: expect.objectContaining({
					Authorization: 'Bearer user-token',
					'x-winwidget-service': 'crm-sales',
					'x-winwidget-internal-token': 't'.repeat(48)
				})
			})
		);
	});

	it.each([
		['http://crm-access.internal', 't'.repeat(48)],
		['https://api.test/prefix', 't'.repeat(48)],
		['https://user:password@api.test', 't'.repeat(48)],
		['https://api.test', 'short']
	])(
		'fails closed for unsafe service configuration',
		async (origin, token) => {
			process.env.CRM_ACCESS_INTERNAL_BASE_URL = origin;
			process.env.CRM_ACCESS_CRM_SALES_TOKEN = token;
			global.fetch = jest.fn();
			await expect(
				new SalesAccessClient().authorize('Bearer user-token', workspaceId)
			).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(global.fetch).not.toHaveBeenCalled();
		}
	);

	it.each([
		[401, UnauthorizedException],
		[403, ForbiddenException],
		[500, ServiceUnavailableException]
	])(
		'handles authorizer status %s fail closed',
		async (status, errorType) => {
			global.fetch = jest
				.fn()
				.mockResolvedValue(
					new Response('{}', { status: status as number })
				);
			await expect(
				new SalesAccessClient().authorize('Bearer user-token', workspaceId)
			).rejects.toBeInstanceOf(errorType as never);
		}
	);

	it.each([
		['sales:write', { ...access, state: 'READ_ONLY' }],
		['sales:read', { ...access, role: 'ANALYST' }],
		['sales:write', { ...access, permissions: ['sales:read'] }]
	])(
		'blocks %s despite a valid session when role/state/permission denies it',
		async (permission, value) => {
			const reflector = {
				getAllAndOverride: jest.fn().mockReturnValue(permission)
			};
			const client = { authorize: jest.fn().mockResolvedValue(value) };
			const request = {
				method: 'POST',
				headers: { authorization: 'Bearer token' },
				body: { workspaceId }
			};
			const context = {
				switchToHttp: () => ({ getRequest: () => request }),
				getHandler: () => ({}),
				getClass: () => ({})
			};
			await expect(
				new SalesAccessGuard(
					reflector as unknown as Reflector,
					client as never
				).canActivate(context as never)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
});
