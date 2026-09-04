import { Prisma, Role, UserStatus } from '@prisma/identity-client';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IdentityInternalService } from './internal.service';

function service(session: unknown) {
	const prisma = {
		userSession: { findFirst: jest.fn().mockResolvedValue(session) },
		workspaceMember: {
			findMany: jest.fn().mockResolvedValue([]),
			findFirst: jest.fn().mockResolvedValue(null)
		}
	};
	const jwt = {
		verify: jest.fn().mockReturnValue({
			sub: 'user-id',
			sid: '00000000-0000-4000-8000-000000000001'
		})
	};
	return {
		value: new IdentityInternalService(
			prisma as any,
			jwt as any,
			{} as any
		),
		prisma,
		jwt
	};
}

describe('canonical Identity introspection', () => {
	it('resolves durable source authority without a JWT and without inactive users or memberships', async () => {
		const current = service(null);
		const workspaceId = '33333333-3333-4333-8333-333333333333';
		expect(
			await current.value.crmSourceContext(workspaceId, 'user-id')
		).toEqual({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-id',
			membership: null
		});
		expect(current.prisma.workspaceMember.findFirst).toHaveBeenCalledWith({
			where: {
				workspaceId,
				userId: 'user-id',
				status: 'ACTIVE',
				workspace: { status: 'ACTIVE' },
				user: { status: 'ACTIVE', deletedAt: null }
			},
			select: { id: true, workspaceId: true, role: true }
		});
		current.prisma.workspaceMember.findFirst.mockResolvedValue({
			id: 'membership-id',
			workspaceId,
			role: 'OWNER'
		});
		expect(
			await current.value.crmSourceContext(workspaceId, 'user-id')
		).toEqual({
			schemaVersion: 1,
			workspaceId,
			subject: 'user-id',
			membership: {
				membershipId: 'membership-id',
				workspaceId,
				role: 'OWNER'
			}
		});
		expect(current.jwt.verify).not.toHaveBeenCalled();
		expect(current.prisma.userSession.findFirst).not.toHaveBeenCalled();
	});
	it('distinguishes a missing/revoked session from an inactive user', async () => {
		const revoked = service(null);
		await expect(
			revoked.value.introspect('Bearer access-token')
		).rejects.toThrow('Invalid session');
		expect(revoked.prisma.userSession.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ revokedAt: null })
			})
		);

		await expect(
			service({
				id: '00000000-0000-4000-8000-000000000001',
				user: {
					id: 'user-id',
					rights: [Role.USER],
					status: UserStatus.DEACTIVATED,
					deletedAt: null
				}
			}).value.introspect('Bearer access-token')
		).rejects.toThrow('User is deactivated');
	});

	it('returns only the fail-closed active session contract with sorted roles', async () => {
		await expect(
			service({
				id: '00000000-0000-4000-8000-000000000001',
				user: {
					id: 'user-id',
					rights: [Role.USER, Role.DEV, Role.USER],
					status: UserStatus.ACTIVE,
					deletedAt: null
				}
			}).value.introspect('Bearer access-token')
		).resolves.toEqual({
			active: true,
			subject: 'user-id',
			sessionId: '00000000-0000-4000-8000-000000000001',
			roles: [Role.DEV, Role.USER]
		});
	});

	it('rejects missing and malformed bearer values before JWT verification', async () => {
		const current = service(null);
		await expect(current.value.introspect()).rejects.toThrow(
			'Access token not passed'
		);
		await expect(current.value.introspect('Basic token')).rejects.toThrow(
			'Invalid access token'
		);
		expect(current.jwt.verify).not.toHaveBeenCalled();
	});

	it('derives the CRM auth context from the bearer session and active memberships only', async () => {
		const current = service({
			id: '00000000-0000-4000-8000-000000000001',
			user: {
				id: 'user-id',
				rights: [Role.USER],
				status: UserStatus.ACTIVE,
				deletedAt: null
			}
		});
		current.prisma.workspaceMember.findMany.mockResolvedValue([
			{
				id: '00000000-0000-4000-8000-000000000010',
				workspaceId: '00000000-0000-4000-8000-000000000020',
				role: 'OWNER'
			}
		]);

		await expect(
			current.value.crmAccessAuthContext('Bearer access-token')
		).resolves.toEqual({
			schemaVersion: 1,
			subject: 'user-id',
			sessionId: '00000000-0000-4000-8000-000000000001',
			memberships: [
				{
					membershipId: '00000000-0000-4000-8000-000000000010',
					workspaceId: '00000000-0000-4000-8000-000000000020',
					role: 'OWNER'
				}
			]
		});
		expect(current.jwt.verify).toHaveBeenCalledWith('access-token');
		expect(current.prisma.workspaceMember.findMany).toHaveBeenCalledWith({
			where: {
				userId: 'user-id',
				status: 'ACTIVE',
				workspace: { status: 'ACTIVE' }
			},
			orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }],
			select: { id: true, workspaceId: true, role: true }
		});
	});

	it('does not query memberships when bearer session introspection fails', async () => {
		const current = service(null);
		await expect(
			current.value.crmAccessAuthContext('Bearer access-token')
		).rejects.toThrow('Invalid session');
		expect(current.prisma.workspaceMember.findMany).not.toHaveBeenCalled();
	});
});

describe('Identity campaign contact export v2', () => {
	const createResponse = () => {
		const response = Object.assign(new EventEmitter(), {
			write: jest.fn().mockReturnValue(true),
			destroyed: false,
			writableEnded: false
		});
		return response as unknown as Response;
	};

	it('uses the RepeatableRead database timestamp and preserves every destination/user pair', async () => {
		const databaseAsOf = new Date('2026-08-14T09:15:00.000Z');
		const rows = [
			{ userId: 'user-a', destination: 'shared@example.com' },
			{ userId: 'user-b', destination: 'shared@example.com' }
		];
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			$queryRaw: jest
				.fn()
				.mockResolvedValueOnce([{ asOf: databaseAsOf }])
				.mockResolvedValueOnce(rows)
		};
		const prisma = {
			$transaction: jest.fn(
				(callback: (tx: typeof transaction) => Promise<void>) =>
					callback(transaction)
			)
		};
		const response = createResponse();
		const value = new IdentityInternalService(
			prisma as never,
			{} as never,
			{} as never
		);

		await value.streamCampaignContacts(
			'EMAIL',
			{ aborted: false } as Request,
			response
		);

		const records = (response.write as jest.Mock).mock.calls.map(
			([line]) => JSON.parse(String(line).trim())
		) as Array<Record<string, unknown>>;
		const sourceSha256 = createHash('sha256')
			.update(
				'EMAIL\u0000shared@example.com\u0000user-a\n' +
					'EMAIL\u0000shared@example.com\u0000user-b\n'
			)
			.digest('hex');
		expect(records).toEqual([
			expect.objectContaining({
				type: 'snapshot',
				schemaVersion: 2,
				asOf: databaseAsOf.toISOString(),
				criteria: { channel: 'EMAIL' }
			}),
			{ type: 'recipient', ...rows[0] },
			{ type: 'recipient', ...rows[1] },
			expect.objectContaining({
				type: 'complete',
				totalCount: 2,
				sha256: sourceSha256
			})
		]);
		expect(
			transaction.$executeRaw.mock.invocationCallOrder[0]
		).toBeLessThan(transaction.$queryRaw.mock.invocationCallOrder[0]);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
			})
		);
	});

	it('uses a composite destination/user cursor for stable pagination', async () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([])
		};
		const value = new IdentityInternalService(
			{} as never,
			{} as never,
			{} as never
		);

		await (
			value as unknown as {
				contactRows: (
					tx: typeof transaction,
					channel: 'EMAIL',
					cursor: { destination: string; userId: string }
				) => Promise<unknown>;
			}
		).contactRows(transaction, 'EMAIL', {
			destination: 'shared@example.com',
			userId: 'user-a'
		});

		const query = transaction.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
		expect(query.strings.join('')).toContain(
			'WHERE (destination, user_id) > (, )'
		);
		expect(query.strings.join('')).toContain(
			'ORDER BY destination ASC, user_id ASC'
		);
		expect(query.values).toEqual(['shared@example.com', 'user-a']);
	});
});
