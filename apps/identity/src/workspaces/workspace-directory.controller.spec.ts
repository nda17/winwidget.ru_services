import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WorkspaceDirectoryController } from './workspace-directory.controller';

describe('Scoped WinCRM member directory', () => {
	const workspaceId = randomUUID();
	const membershipId = randomUUID();
	const setup = () => {
		const prisma = {
			workspace: {
				findFirst: jest.fn().mockResolvedValue({ id: workspaceId })
			},
			workspaceMember: {
				findMany: jest.fn().mockResolvedValue([
					{
						id: membershipId,
						userId: 'subject',
						user: {
							name: 'Имя',
							status: 'ACTIVE',
							deletedAt: null,
							authIdentities: [{ value: 'verified@example.test' }]
						}
					}
				])
			}
		};
		return {
			prisma,
			controller: new WorkspaceDirectoryController(prisma as never)
		};
	};
	it('returns only exact page IDs and verified EMAIL, never general user profiles', async () => {
		const { prisma, controller } = setup();
		await expect(
			controller.directory(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId]
			})
		).resolves.toEqual({
			schemaVersion: 1,
			workspaceId,
			items: [
				{
					membershipId,
					subject: 'subject',
					displayName: 'Имя',
					verifiedEmail: 'verified@example.test'
				}
			]
		});
		expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { workspaceId, id: { in: [membershipId] } },
				select: expect.objectContaining({
					user: {
						select: {
							name: true,
							status: true,
							deletedAt: true,
							authIdentities: {
								where: { type: 'EMAIL', verifiedAt: { not: null } },
								select: { value: true },
								take: 1
							}
						}
					}
				})
			})
		);
	});
	it('fails whole request when any requested ID is missing or belongs to a different workspace', async () => {
		const { controller } = setup();
		await expect(
			controller.directory(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId, randomUUID()]
			})
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('does not reveal stale profile fields for a disabled Identity user', async () => {
		const { prisma, controller } = setup();
		prisma.workspaceMember.findMany.mockResolvedValueOnce([
			{
				id: membershipId,
				userId: 'subject',
				user: {
					name: 'Hidden',
					status: 'BLOCKED',
					deletedAt: null,
					authIdentities: [{ value: 'hidden@example.test' }]
				}
			}
		]);
		await expect(
			controller.directory(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId]
			})
		).resolves.toMatchObject({
			items: [{ displayName: null, verifiedEmail: null }]
		});
	});
});
