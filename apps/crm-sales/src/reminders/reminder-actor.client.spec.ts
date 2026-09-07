import {
	ForbiddenException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SalesAccess } from '../sales/sales-access';
import { ReminderActorClient } from './reminder-actor.client';

const workspaceId = randomUUID(),
	membershipId = randomUUID();
const actor: SalesAccess = {
	schemaVersion: 1,
	workspaceId,
	subject: 'member',
	role: 'MANAGER',
	state: 'READ_ONLY',
	dataScope: 'OWN',
	teamIds: [],
	permissions: ['sales:read']
};
const response = (access = actor, id: string | null = membershipId) => ({
	schemaVersion: 1,
	workspaceId,
	subject: access.subject,
	items: [
		{
			binding: { subject: access.subject, membershipId: id },
			employee: {
				subject: access.subject,
				membershipId: membershipId,
				displayName: 'Employee',
				verifiedEmail: 'employee@example.invalid',
				role: access.role
			}
		}
	]
});

describe('ReminderActorClient exact read-only membership proof', () => {
	const oldFetch = global.fetch,
		oldOrigin = process.env.CRM_ACCESS_INTERNAL_BASE_URL;
	let fetchMock: jest.Mock;
	beforeEach(() => {
		process.env.CRM_ACCESS_INTERNAL_BASE_URL = 'http://127.0.0.1:5300';
		fetchMock = jest.fn().mockResolvedValue(
			new Response(JSON.stringify(response()), {
				headers: { 'content-type': 'application/json' }
			})
		);
		global.fetch = fetchMock;
	});
	afterEach(() => {
		global.fetch = oldFetch;
		if (oldOrigin === undefined)
			delete process.env.CRM_ACCESS_INTERNAL_BASE_URL;
		else process.env.CRM_ACCESS_INTERNAL_BASE_URL = oldOrigin;
	});
	const call = (access = actor, id: string | null = membershipId) =>
		new ReminderActorClient().verify('Bearer test', access, id);
	it('reuses existing one-pair read route in READ_ONLY without internal token or write-authorize call', async () => {
		await expect(call()).resolves.toEqual({
			subject: actor.subject,
			membershipId
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe(
			'http://127.0.0.1:5300/api/v1/crm/access/team/assignee-labels'
		);
		expect(options).toMatchObject({
			method: 'POST',
			redirect: 'error',
			cache: 'no-store',
			headers: {
				Authorization: 'Bearer test',
				'content-type': 'application/json'
			}
		});
		expect(JSON.parse(options.body)).toEqual({
			schemaVersion: 1,
			workspaceId,
			bindings: [{ subject: actor.subject, membershipId }]
		});
		expect(Object.keys(options.headers)).toHaveLength(2);
	});
	it('accepts owner null only when both current actor and returned employee prove OWNER', async () => {
		const owner = {
			...actor,
			subject: 'owner',
			role: 'OWNER' as const,
			dataScope: 'ALL' as const
		};
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify(response(owner, null)), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(call(owner, null)).resolves.toEqual({
			subject: 'owner',
			membershipId: null
		});
		await expect(call(actor, null)).rejects.toBeInstanceOf(
			ForbiddenException
		);
		await expect(call(owner, membershipId)).rejects.toBeInstanceOf(
			ForbiddenException
		);
	});
	it.each([
		[
			'foreign workspace',
			(r: any) => {
				r.workspaceId = randomUUID();
			}
		],
		[
			'foreign actor',
			(r: any) => {
				r.subject = 'other';
			}
		],
		[
			'foreign binding subject',
			(r: any) => {
				r.items[0].binding.subject = 'other';
			}
		],
		[
			'foreign binding membership',
			(r: any) => {
				r.items[0].binding.membershipId = randomUUID();
			}
		],
		[
			'extra employee',
			(r: any) => {
				r.items.push(r.items[0]);
			}
		],
		[
			'unknown field',
			(r: any) => {
				r.extra = true;
			}
		],
		[
			'foreign employee',
			(r: any) => {
				r.items[0].employee.subject = 'other';
			}
		],
		[
			'changed employee role',
			(r: any) => {
				r.items[0].employee.role = 'OWNER';
			}
		],
		[
			'missing membership',
			(r: any) => {
				r.items[0].employee.membershipId = null;
			}
		],
		[
			'malformed email extra field',
			(r: any) => {
				r.items[0].employee.extra = 'private';
			}
		]
	] as const)(
		'rejects malformed/foreign %s without returning directory PII',
		async (_name, mutate) => {
			const value = response();
			mutate(value);
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify(value), {
					headers: { 'content-type': 'application/json' }
				})
			);
			await expect(call()).rejects.toBeInstanceOf(
				ServiceUnavailableException
			);
		}
	);
	it('rejects absent or rejoined membership, not silently matching subject alone', async () => {
		for (const employee of [
			null,
			{ ...response().items[0].employee, membershipId: randomUUID() }
		]) {
			const value = response();
			(value.items[0] as any).employee = employee;
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify(value), {
					headers: { 'content-type': 'application/json' }
				})
			);
			await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
		}
	});
	it.each([
		[401, UnauthorizedException],
		[403, ForbiddenException],
		[404, ForbiddenException],
		[409, ForbiddenException],
		[500, ServiceUnavailableException]
	] as const)('maps HTTP %i safely', async (status, kind) => {
		fetchMock.mockResolvedValue(
			new Response('private upstream detail', { status })
		);
		try {
			await call();
			throw new Error('expected rejection');
		} catch (error) {
			expect(error).toBeInstanceOf(kind);
			expect(String(error)).not.toContain('private upstream detail');
		}
	});
	it('bounds JSON/body size and suppresses transport/parse failures', async () => {
		for (const value of [
			new Response('not-json', {
				headers: { 'content-type': 'application/json' }
			}),
			new Response('x'.repeat(32769), {
				headers: { 'content-type': 'application/json' }
			}),
			new Response('{}', { headers: { 'content-type': 'text/html' } })
		]) {
			fetchMock.mockResolvedValue(value);
			await expect(call()).rejects.toBeInstanceOf(
				ServiceUnavailableException
			);
		}
		fetchMock.mockRejectedValue(new Error('private transport'));
		await expect(call()).rejects.toThrow(
			'CRM reminder membership is temporarily unavailable'
		);
	});
	it('rejects invalid origin, token, ANALYST and wildcard member before network', async () => {
		await expect(
			new ReminderActorClient().verify('not-bearer', actor, membershipId)
		).rejects.toBeInstanceOf(UnauthorizedException);
		await expect(
			call({ ...actor, role: 'ANALYST' })
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(call(actor, null)).rejects.toBeInstanceOf(
			ForbiddenException
		);
		process.env.CRM_ACCESS_INTERNAL_BASE_URL =
			'https://username:password@example.invalid';
		await expect(call()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
