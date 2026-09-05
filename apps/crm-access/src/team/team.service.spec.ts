import {
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-access-client';
import { CrmTeamService } from './team.service';
import { command, serializable, type TeamAuthority } from './team.util';

const workspaceId = randomUUID();
const owner: TeamAuthority = {
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	permissions: [
		'access:read-team',
		'access:manage-team',
		'access:revoke-access'
	]
};
const setup = (actor = owner) => {
	const prisma = {
		$executeRaw: jest.fn(),
		$transaction: jest.fn(),
		crmWorkspaceMember: { findUnique: jest.fn(), findFirst: jest.fn() },
		crmWorkspaceAccess: {
			findUniqueOrThrow: jest
				.fn()
				.mockResolvedValue({ activatedBySubject: 'owner' })
		},
		crmTeamCommandReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		},
		crmTeam: { count: jest.fn().mockResolvedValue(0) }
	};
	prisma.$transaction.mockImplementation(callback => callback(prisma));
	const auth = { authorize: jest.fn().mockResolvedValue(actor) };
	const service = new CrmTeamService(
		prisma as never,
		auth as never,
		{} as never,
		{} as never
	);
	return { service, prisma, auth };
};
describe('CRM team authorization and command binding', () => {
	it.each(['P2034', 'P2002'])(
		'retries %s with a fresh Serializable snapshot after a concurrent winner',
		async code => {
			const { prisma } = setup();
			const action = jest.fn().mockResolvedValue('ok');
			prisma.$transaction.mockRejectedValueOnce(
				new Prisma.PrismaClientKnownRequestError('Concurrent insert won', {
					code,
					clientVersion: '5.22.0'
				})
			);
			await expect(serializable(prisma as never, action)).resolves.toBe(
				'ok'
			);
			expect(prisma.$transaction).toHaveBeenCalledTimes(2);
		}
	);
	it.each(['MANAGER', 'TEAM_LEAD', 'ANALYST'])(
		'denies structure browsing to %s independently of frontend',
		async role => {
			const { service, prisma } = setup({ ...owner, role });
			await expect(
				service.teams('Bearer test', {
					workspaceId,
					page: 1,
					pageSize: 20
				})
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(prisma.$transaction).not.toHaveBeenCalled();
		}
	);
	it.each([
		'disable',
		'enable',
		'revokeInvitation',
		'changeRole',
		'setTeams'
	])(
		'denies %s during READ_ONLY until an explicit safe-revoke exception is agreed',
		async method => {
			const { service } = setup({ ...owner, state: 'READ_ONLY' });
			const dto = {
				schemaVersion: 1 as const,
				commandId: randomUUID(),
				workspaceId,
				expectedVersion: 1,
				role: 'MANAGER' as const,
				teamIds: []
			};
			await expect(
				service[method as 'disable']('Bearer test', randomUUID(), dto)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);
	it('never lets CRM_ADMIN grant or manage another CRM_ADMIN', () => {
		const { service } = setup();
		expect(() =>
			service.manageRole({ ...owner, role: 'CRM_ADMIN' }, 'CRM_ADMIN')
		).toThrow(ForbiddenException);
		expect(() => service.manageRole(owner, 'OWNER')).toThrow(
			ForbiddenException
		);
	});
	it('rejects cross-workspace team IDs before writing joins', async () => {
		const { service, prisma } = setup();
		await expect(
			service.requireTeams(prisma as never, workspaceId, [randomUUID()])
		).rejects.toThrow();
	});
	it('replays only exact actor/workspace/operation/body and revalidates a changed local administrator', async () => {
		const { prisma } = setup();
		const commandId = randomUUID();
		const action = jest
			.fn()
			.mockResolvedValue({ schemaVersion: 1, ok: true });
		const body = { role: 'MANAGER' };
		const first = await command(
			prisma as never,
			owner,
			commandId,
			'test',
			body,
			action
		);
		const receipt =
			prisma.crmTeamCommandReceipt.create.mock.calls[0][0].data;
		prisma.crmTeamCommandReceipt.findUnique.mockResolvedValue(receipt);
		await expect(
			command(prisma as never, owner, commandId, 'test', body, action)
		).resolves.toEqual(first);
		expect(action).toHaveBeenCalledTimes(1);
		for (const [actor, changedBody] of [
			[owner, { role: 'CRM_ADMIN' }],
			[{ ...owner, subject: 'another-owner' }, body],
			[{ ...owner, workspaceId: randomUUID() }, body]
		] as const)
			await expect(
				command(
					prisma as never,
					actor,
					commandId,
					'test',
					changedBody,
					action
				)
			).rejects.toBeInstanceOf(ConflictException);
		prisma.crmWorkspaceMember.findUnique.mockResolvedValue({
			role: 'MANAGER',
			disabledAt: null
		});
		await expect(
			command(
				prisma as never,
				{ ...owner, role: 'CRM_ADMIN' },
				randomUUID(),
				'test',
				body,
				action
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
	it('hides an unknown member instead of falling back to unscoped lookup', async () => {
		const { service, prisma } = setup();
		prisma.crmWorkspaceMember.findFirst.mockResolvedValue(null);
		await expect(
			service.disable('Bearer test', randomUUID(), {
				schemaVersion: 1,
				commandId: randomUUID(),
				workspaceId,
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(NotFoundException);
		expect(prisma.crmWorkspaceMember.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ workspaceId })
			})
		);
	});
});
