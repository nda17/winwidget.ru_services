import {
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { SalesAssigneeClient } from './sales-assignee.client';
import type { SalesAccess } from '../sales/sales-access';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const membershipId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const access: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['sales:write']
};
const target = {
	subject: 'manager',
	membershipId,
	role: 'MANAGER',
	dataScope: 'OWN',
	teamIds: [teamId]
};
const reply = () => ({
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	assignee: { ...target }
});
const originalEnv = {
	url: process.env.CRM_ACCESS_INTERNAL_BASE_URL,
	token: process.env.CRM_ACCESS_CRM_SALES_TOKEN
};
let fetchMock: jest.Mock;
beforeEach(() => {
	process.env.CRM_ACCESS_INTERNAL_BASE_URL = 'http://127.0.0.1:5300';
	process.env.CRM_ACCESS_CRM_SALES_TOKEN = 'test-'.repeat(10);
	fetchMock = jest
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async () => Response.json(reply())) as jest.Mock;
});
afterEach(() => {
	jest.restoreAllMocks();
	for (const [key, value] of Object.entries({
		CRM_ACCESS_INTERNAL_BASE_URL: originalEnv.url,
		CRM_ACCESS_CRM_SALES_TOKEN: originalEnv.token
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
const call = () =>
	new SalesAssigneeClient().authorize(
		'Bearer test',
		access,
		{ subject: target.subject, membershipId },
		teamId
	);
describe('Sales assignment authority client', () => {
	it('binds actor, target and workspace without cached grants', async () => {
		await expect(call()).resolves.toEqual(target);
		await call();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'http://127.0.0.1:5300/internal/v1/crm-access/authorize-assignee'
		);
		expect(options.redirect).toBe('error');
		expect(options.cache).toBe('no-store');
		expect(JSON.parse(options.body)).toEqual({
			schemaVersion: 1,
			purpose: 'SALES_ASSIGNMENT',
			workspaceId,
			subject: 'manager',
			membershipId,
			teamId
		});
		expect(options.headers.Authorization).toBe('Bearer test');
		expect(options.headers['x-winwidget-service']).toBe('crm-sales');
	});
	it.each([
		[401, UnauthorizedException],
		[403, ForbiddenException],
		[404, NotFoundException],
		[503, ServiceUnavailableException]
	])('preserves denial status %s', async (status, exception) => {
		fetchMock.mockResolvedValue(
			new Response('not forwarded', { status: status as number })
		);
		await expect(call()).rejects.toBeInstanceOf(exception);
	});
	it.each([
		{ ...reply(), workspaceId: membershipId },
		{ ...reply(), subject: 'another-actor' },
		{ ...reply(), extra: true },
		{ ...reply(), schemaVersion: 2 },
		{ ...reply(), assignee: { ...target, membershipId: teamId } },
		{ ...reply(), assignee: { ...target, subject: 'another-target' } },
		{ ...reply(), assignee: { ...target, role: 'ANALYST' } },
		{ ...reply(), assignee: { ...target, teamIds: [teamId, teamId] } },
		{ ...reply(), assignee: { ...target, teamIds: ['bad'] } },
		{ ...reply(), assignee: { ...target, dataScope: 'GLOBAL' } }
	])('rejects malformed authority %j', async response => {
		fetchMock.mockResolvedValue(Response.json(response));
		await expect(call()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
	it('bounds bodies and sanitizes transport errors', async () => {
		fetchMock.mockResolvedValue(
			new Response(' '.repeat(512 * 1024 + 1), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(call()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		fetchMock.mockRejectedValue(new Error('private upstream detail'));
		await expect(call()).rejects.toThrow(
			'Не удалось проверить ответственного'
		);
	});
	it('refuses credentials in origins and malformed user bearer before transport', async () => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL =
			'https://user:pass@example.invalid';
		await expect(call()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		await expect(
			new SalesAssigneeClient().authorize('', access, target)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
