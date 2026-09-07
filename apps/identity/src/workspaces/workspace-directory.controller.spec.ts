import {
	NotFoundException,
	RequestMethod,
	ServiceUnavailableException,
	ValidationPipe
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	AssigneeDirectoryDto,
	ReminderDirectoryDto,
	WorkspaceDirectoryController
} from './workspace-directory.controller';
import { IDENTITY_GLOBAL_PREFIX_EXCLUDES } from '../runtime/identity-http.config';

describe('Scoped WinCRM member directory', () => {
	const workspaceId = randomUUID();
	const membershipId = randomUUID();
	const setup = () => {
		const prisma = {
			$transaction: jest.fn(),
			$executeRawUnsafe: jest.fn().mockResolvedValue(0),
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
		prisma.$transaction.mockImplementation(callback => callback(prisma));
		return {
			prisma,
			controller: new WorkspaceDirectoryController(prisma as never)
		};
	};
	it('keeps reminder destinations private, exact and read-only', async () => {
		const { prisma, controller } = setup();
		prisma.workspaceMember.findMany.mockResolvedValueOnce([
			{
				id: membershipId,
				userId: 'subject',
				role: 'MEMBER',
				user: {
					authIdentities: [{ value: ' Verified@Example.test ' }],
					telegramNotificationChannel: {
						chatId: '12345',
						isActive: true,
						disabledAt: null
					}
				}
			}
		] as never);
		await expect(
			controller.reminderDirectory(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId],
				includeOwner: false
			})
		).resolves.toEqual({
			schemaVersion: 1,
			workspaceId,
			items: [
				{
					membershipId,
					subject: 'subject',
					workspaceRole: 'MEMBER',
					email: 'verified@example.test',
					telegramChatId: '12345'
				}
			]
		});
		expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
			'SET TRANSACTION READ ONLY'
		);
		expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId,
					status: 'ACTIVE',
					user: { status: 'ACTIVE', deletedAt: null },
					OR: [{ id: { in: [membershipId] } }]
				}
			})
		);
		expect(IDENTITY_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/crm-access/workspaces/:workspaceId/reminder-directory',
			method: RequestMethod.POST
		});
	});
	it.each([
		{ chatId: '12345', isActive: false, disabledAt: null },
		{ chatId: '12345', isActive: true, disabledAt: new Date() },
		{ chatId: '-12345', isActive: true, disabledAt: null },
		null
	])(
		'does not expose a disabled, missing or non-personal Telegram channel',
		async channel => {
			const { prisma, controller } = setup();
			prisma.workspaceMember.findMany.mockResolvedValueOnce([
				{
					id: membershipId,
					userId: 'subject',
					role: 'MEMBER',
					user: {
						authIdentities: [],
						telegramNotificationChannel: channel
					}
				}
			] as never);
			const result = await controller.reminderDirectory(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId],
				includeOwner: false
			});
			expect(result.items[0]).toMatchObject({
				email: null,
				telegramChatId: null
			});
		}
	);
	it('bounds reminder lookup and requires explicit owner selection', async () => {
		const pipe = new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true
		});
		await expect(
			pipe.transform(
				{ schemaVersion: 1, membershipIds: [], includeOwner: false },
				{ type: 'body', metatype: ReminderDirectoryDto }
			)
		).resolves.toBeInstanceOf(ReminderDirectoryDto);
		await expect(
			pipe.transform(
				{
					schemaVersion: 1,
					membershipIds: Array.from({ length: 101 }, () => randomUUID()),
					includeOwner: false
				},
				{ type: 'body', metatype: ReminderDirectoryDto }
			)
		).rejects.toBeDefined();
		await expect(
			pipe.transform(
				{ schemaVersion: 1, membershipIds: [] },
				{ type: 'body', metatype: ReminderDirectoryDto }
			)
		).rejects.toBeDefined();
	});
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
	it('reads only active eligible bindings and optionally the current owner in one snapshot', async () => {
		const { prisma, controller } = setup();
		prisma.workspaceMember.findMany.mockResolvedValueOnce([
			{
				id: membershipId,
				userId: 'owner',
				role: 'OWNER',
				user: { name: 'Владелец', authIdentities: [] }
			}
		] as never);
		expect(
			await controller.assignees(workspaceId, {
				schemaVersion: 1,
				membershipIds: [],
				includeOwner: true
			})
		).toEqual({
			schemaVersion: 1,
			workspaceId,
			items: [
				{
					membershipId,
					subject: 'owner',
					workspaceRole: 'OWNER',
					displayName: 'Владелец',
					verifiedEmail: null
				}
			]
		});
		expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId,
					status: 'ACTIVE',
					user: { status: 'ACTIVE', deletedAt: null },
					OR: [{ id: { in: [] } }, { role: 'OWNER' }]
				},
				take: 1002,
				select: expect.objectContaining({ role: true })
			})
		);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 2000 }
		);
		expect(IDENTITY_GLOBAL_PREFIX_EXCLUDES).toContainEqual({
			path: 'internal/v1/crm-access/workspaces/:workspaceId/assignee-directory',
			method: RequestMethod.POST
		});
	});
	it('omits revoked/missing assignees without changing the old exact-ID directory contract', async () => {
		const { prisma, controller } = setup();
		prisma.workspaceMember.findMany.mockResolvedValueOnce([]);
		expect(
			await controller.assignees(workspaceId, {
				schemaVersion: 1,
				membershipIds: [membershipId],
				includeOwner: false
			})
		).toMatchObject({ items: [] });
		expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [{ id: { in: [membershipId] } }]
				})
			})
		);
	});
	it('fails closed for an inactive workspace or ambiguous owners', async () => {
		const { prisma, controller } = setup();
		prisma.workspace.findFirst.mockResolvedValueOnce(null);
		await expect(
			controller.assignees(workspaceId, {
				schemaVersion: 1,
				membershipIds: [],
				includeOwner: true
			})
		).rejects.toBeInstanceOf(NotFoundException);
		expect(prisma.workspaceMember.findMany).not.toHaveBeenCalled();
		prisma.workspaceMember.findMany.mockResolvedValueOnce([
			{ role: 'OWNER' },
			{ role: 'OWNER' }
		] as never);
		await expect(
			controller.assignees(workspaceId, {
				schemaVersion: 1,
				membershipIds: [],
				includeOwner: true
			})
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
	it('strictly bounds assignee batches and owner opt-in', async () => {
		const pipe = new ValidationPipe({
			transform: true,
			whitelist: true,
			forbidNonWhitelisted: true
		});
		const body = {
			schemaVersion: 1,
			membershipIds: [membershipId],
			includeOwner: false
		};
		for (const patch of [
			{ includeOwner: 'true' },
			{ includeOwner: undefined },
			{ membershipIds: [membershipId, membershipId] },
			{ membershipIds: Array.from({ length: 1001 }, () => randomUUID()) },
			{ extra: true },
			{ membershipIds: ['other'] }
		])
			await expect(
				pipe.transform(
					{ ...body, ...patch },
					{ type: 'body', metatype: AssigneeDirectoryDto }
				)
			).rejects.toBeDefined();
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
