import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	assertIntakePermission,
	IntakeAuthorization,
	IntakeAuthorizationClient,
	parseIntakeAccessOrigin,
	parseIntakeAuthorization
} from './intake-authorization.client';

const workspaceId = randomUUID();
const context: IntakeAuthorization = {
	schemaVersion: 1,
	workspaceId,
	subject: 'identity-subject',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:read', 'intake:write']
};

describe('Intake authorization boundary', () => {
	const originalEnv = { ...process.env };
	const originalFetch = global.fetch;
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL =
			'https://crm-internal.example.test';
		process.env.CRM_ACCESS_CRM_INTAKE_TOKEN =
			'customer-pairwise-token-for-unit-tests-only';
		global.fetch = jest
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(context)));
	});
	afterEach(() => {
		process.env = { ...originalEnv };
		global.fetch = originalFetch;
	});
	it('uses fresh source authorization without forwarding a source secret as a user bearer', async () => {
		const sourceContext = {
			...context,
			permissions: ['intake:read', 'intake:write', 'intake:manage-sources']
		};
		(global.fetch as jest.Mock).mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(sourceContext)))
		);
		const client = new IntakeAuthorizationClient();
		for (let i = 0; i < 2; i++)
			expect(
				await client.authorizeSource(workspaceId, context.subject)
			).toEqual(sourceContext);
		expect(global.fetch).toHaveBeenCalledTimes(2);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://crm-internal.example.test/internal/v1/crm-access/authorize-source',
			expect.objectContaining({
				redirect: 'error',
				body: JSON.stringify({
					schemaVersion: 1,
					workspaceId,
					subject: context.subject
				}),
				headers: expect.not.objectContaining({
					authorization: expect.anything()
				})
			})
		);
	});
	it('accepts only fresh canonical owner from the scoped managed-source endpoint', async () => {
		const source = {
			...context,
			role: 'CRM_ADMIN',
			ownerSubject: 'canonical-owner',
			permissions: ['intake:read', 'intake:manage-sources']
		};
		(global.fetch as jest.Mock).mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify(source)))
		);
		const client = new IntakeAuthorizationClient();
		expect(
			await client.authorizeWidgetSource(workspaceId, context.subject)
		).toEqual(source);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://crm-internal.example.test/internal/v1/crm-access/authorize-widget-source',
			expect.objectContaining({
				body: JSON.stringify({
					schemaVersion: 1,
					workspaceId,
					subject: context.subject
				}),
				headers: expect.not.objectContaining({
					authorization: expect.anything()
				})
			})
		);
		for (const change of [
			{ ownerSubject: null },
			{ ownerSubject: '' },
			{ subject: 'changed' },
			{ state: 'READ_ONLY' },
			{ role: 'MANAGER' },
			{ unexpected: 'field' }
		]) {
			(global.fetch as jest.Mock).mockResolvedValue(
				new Response(JSON.stringify({ ...source, ...change }))
			);
			await expect(
				client.authorizeWidgetSource(workspaceId, context.subject)
			).rejects.toBeInstanceOf(Error);
		}
	});
	it('rejects changed subject, read-only/demoted authority and invalid pair credentials for sources', async () => {
		for (const change of [
			{ subject: 'other' },
			{ state: 'READ_ONLY' },
			{ role: 'MANAGER' },
			{ permissions: [] }
		]) {
			(global.fetch as jest.Mock).mockResolvedValue(
				new Response(
					JSON.stringify({
						...context,
						permissions: ['intake:manage-sources'],
						...change
					})
				)
			);
			await expect(
				new IntakeAuthorizationClient().authorizeSource(
					workspaceId,
					context.subject
				)
			).rejects.toBeInstanceOf(Error);
		}
		(global.fetch as jest.Mock).mockResolvedValue(
			new Response(null, { status: 401 })
		);
		await expect(
			new IntakeAuthorizationClient().authorizeSource(
				workspaceId,
				context.subject
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('forwards only the exact pairwise identity and fresh bearer request without redirects or caching', async () => {
		const client = new IntakeAuthorizationClient();
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
					'x-winwidget-service': 'crm-intake'
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
				new IntakeAuthorizationClient().authorize(
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
				new IntakeAuthorizationClient().authorize(bearer, workspaceId)
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
				new IntakeAuthorizationClient().authorize(
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
			new IntakeAuthorizationClient().authorize(
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
		expect(() => parseIntakeAccessOrigin(value)).toThrow();
	});

	it.each([
		'http://localhost:5300',
		'http://127.0.0.1:5300',
		'https://private.example.test'
	])('accepts exact origin %s', value => {
		expect(parseIntakeAccessOrigin(value)).toBe(value);
	});

	it.each([
		undefined,
		'',
		'change_me_at_least_32_random_characters',
		'short'
	])('requires a concrete pairwise token', token => {
		if (token === undefined)
			delete process.env.CRM_ACCESS_CRM_INTAKE_TOKEN;
		else process.env.CRM_ACCESS_CRM_INTAKE_TOKEN = token;
		expect(() => new IntakeAuthorizationClient()).toThrow(
			'CRM_ACCESS_CRM_INTAKE_TOKEN'
		);
	});

	it('rejects unknown fields and duplicate scopes and permissions', () => {
		for (const data of [
			{ ...context, extra: 1 },
			{ ...context, state: 'SUSPENDED' },
			{ ...context, permissions: ['intake:read', 'intake:read'] },
			{ ...context, teamIds: ['bad-id'] },
			{ ...context, subject: 'bad subject' }
		]) {
			expect(parseIntakeAuthorization(data, workspaceId)).toBeNull();
		}
	});

	it('requires independent action permission and writable subscription', () => {
		expect(() =>
			assertIntakePermission(
				{ ...context, state: 'READ_ONLY' },
				'intake:read'
			)
		).not.toThrow();
		expect(() =>
			assertIntakePermission(
				{ ...context, state: 'READ_ONLY' },
				'intake:write',
				true
			)
		).toThrow(ForbiddenException);
		expect(() =>
			assertIntakePermission(
				{ ...context, permissions: [] },
				'intake:read'
			)
		).toThrow(ForbiddenException);
	});
});
