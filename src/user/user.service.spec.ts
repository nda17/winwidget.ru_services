import type { PrismaService } from '@/prisma.service';
import { UserService } from '@/user/user.service';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException
} from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

describe('UserService soft delete', () => {
	const now = new Date('2026-07-28T09:00:00.000Z');

	const createUser = (overrides: Record<string, unknown> = {}) => ({
		id: 'user-1',
		name: 'Пользователь',
		password: 'password-hash',
		avatarPath: null,
		status: UserStatus.ACTIVE,
		personalDataConsentRevokedAt: null,
		deletedAt: null,
		rights: [Role.USER],
		createdAt: now,
		updatedAt: now,
		authIdentities: [],
		...overrides
	});

	const createFixture = () => {
		const createUpdateMany = () =>
			jest.fn().mockResolvedValue({ count: 1 });
		const transaction = {
			user: {
				findUnique: jest.fn(),
				count: jest.fn().mockResolvedValue(2),
				update: jest.fn(),
				updateMany: createUpdateMany()
			},
			userSession: { updateMany: createUpdateMany() },
			widget: { updateMany: createUpdateMany() },
			quiz: { updateMany: createUpdateMany() },
			callback: { updateMany: createUpdateMany() },
			countdownTimer: { updateMany: createUpdateMany() },
			stopOffer: { updateMany: createUpdateMany() },
			onlineConsultant: { updateMany: createUpdateMany() },
			calculator: { updateMany: createUpdateMany() }
		};
		const prisma = {
			user: {
				findMany: jest.fn().mockResolvedValue([]),
				count: jest.fn().mockResolvedValue(0),
				findUnique: jest.fn(),
				update: jest.fn()
			},
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const service = new UserService(prisma as unknown as PrismaService);

		return {
			service,
			prisma,
			transaction
		};
	};

	it('hides deleted users from the default admin list', async () => {
		const { service, prisma } = createFixture();
		prisma.user.findMany.mockResolvedValue([createUser()]);
		prisma.user.count.mockResolvedValue(1);

		const result = await service.getUserList();

		expect(prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [{ deletedAt: null }]
				}
			})
		);
		expect(prisma.user.count).toHaveBeenCalledWith({
			where: {
				AND: [{ deletedAt: null }]
			}
		});
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).not.toHaveProperty('password');
	});

	it('allows only DEV to include deleted users in the admin list', async () => {
		const { service, prisma } = createFixture();
		const deletedAt = new Date('2026-07-28T08:00:00.000Z');
		prisma.user.findMany.mockResolvedValue([
			createUser({
				status: UserStatus.DEACTIVATED,
				deletedAt
			})
		]);
		prisma.user.count.mockResolvedValue(1);

		await expect(
			service.getUserList(undefined, 1, 20, { includeDeleted: true }, [
				Role.USER,
				Role.ADMIN
			])
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.user.findMany).not.toHaveBeenCalled();

		const result = await service.getUserList(
			undefined,
			1,
			20,
			{ includeDeleted: true },
			[Role.USER, Role.ADMIN, Role.DEV]
		);

		expect(prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: undefined })
		);
		expect(result.items[0].deletedAt).toEqual(deletedAt);
	});

	it('returns only deleted users to DEV for the separate restore list', async () => {
		const { service, prisma } = createFixture();
		const deletedAt = new Date('2026-07-28T08:00:00.000Z');
		prisma.user.findMany.mockResolvedValue([
			createUser({
				status: UserStatus.DEACTIVATED,
				deletedAt
			})
		]);
		prisma.user.count.mockResolvedValue(1);

		await expect(
			service.getUserList(undefined, 1, 20, { deletedOnly: true }, [
				Role.USER,
				Role.ADMIN
			])
		).rejects.toBeInstanceOf(ForbiddenException);

		const result = await service.getUserList(
			undefined,
			1,
			20,
			{ deletedOnly: true },
			[Role.USER, Role.ADMIN, Role.DEV]
		);

		expect(prisma.user.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [{ deletedAt: { not: null } }]
				},
				orderBy: { deletedAt: 'desc' }
			})
		);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].deletedAt).toEqual(deletedAt);
	});

	it('soft deletes a user and deactivates all seven widget types', async () => {
		const { service, prisma, transaction } = createFixture();
		const user = createUser();
		transaction.user.findUnique.mockResolvedValue(user);
		transaction.user.update.mockImplementation(({ data }) =>
			Promise.resolve({
				...user,
				...data
			})
		);

		const result = await service.deleteUser(user.id, 'admin-1', [
			Role.USER,
			Role.ADMIN
		]);

		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
		expect(transaction.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: user.id },
				data: expect.objectContaining({
					status: UserStatus.DEACTIVATED,
					personalDataConsentRevokedAt: expect.any(Date),
					deletedAt: expect.any(Date)
				})
			})
		);
		expect(transaction.userSession.updateMany).toHaveBeenCalledWith({
			where: { userId: user.id, revokedAt: null },
			data: { revokedAt: expect.any(Date) }
		});

		for (const delegate of [
			transaction.widget,
			transaction.quiz,
			transaction.callback,
			transaction.countdownTimer,
			transaction.stopOffer,
			transaction.onlineConsultant,
			transaction.calculator
		]) {
			expect(delegate.updateMany).toHaveBeenCalledWith({
				where: { userId: user.id },
				data: { isActive: false }
			});
		}

		expect(result.status).toBe(UserStatus.DEACTIVATED);
		expect(result.deletedAt).toBeInstanceOf(Date);
		expect(result).not.toHaveProperty('password');
	});

	it('rejects self-delete, ADMIN deletion of DEV, and last active DEV deletion', async () => {
		const selfFixture = createFixture();

		await expect(
			selfFixture.service.deleteUser('admin-1', 'admin-1', [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(selfFixture.prisma.$transaction).not.toHaveBeenCalled();

		const adminFixture = createFixture();
		adminFixture.transaction.user.findUnique.mockResolvedValue(
			createUser({
				rights: [Role.USER, Role.ADMIN, Role.DEV]
			})
		);

		await expect(
			adminFixture.service.deleteUser('user-1', 'admin-1', [
				Role.USER,
				Role.ADMIN
			])
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(adminFixture.transaction.user.update).not.toHaveBeenCalled();

		const lastDevFixture = createFixture();
		lastDevFixture.transaction.user.findUnique.mockResolvedValue(
			createUser({
				rights: [Role.USER, Role.ADMIN, Role.DEV]
			})
		);
		lastDevFixture.transaction.user.count.mockResolvedValue(1);

		await expect(
			lastDevFixture.service.deleteUser('user-1', 'dev-2', [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(lastDevFixture.transaction.user.update).not.toHaveBeenCalled();
	});

	it('rejects self-demotion, ADMIN demotion of DEV, and last active DEV demotion', async () => {
		const devUser = createUser({
			rights: [Role.USER, Role.ADMIN, Role.DEV]
		});
		const selfFixture = createFixture();
		selfFixture.prisma.user.findUnique.mockResolvedValue(devUser);
		selfFixture.transaction.user.findUnique.mockResolvedValue(devUser);

		await expect(
			selfFixture.service.updateUser(
				devUser.id,
				{ isDev: false },
				devUser.id,
				[Role.USER, Role.ADMIN, Role.DEV]
			)
		).rejects.toThrow(
			'Нельзя снять роль DEV с собственной учётной записи'
		);
		expect(selfFixture.transaction.user.update).not.toHaveBeenCalled();

		const adminFixture = createFixture();
		adminFixture.prisma.user.findUnique.mockResolvedValue(devUser);
		adminFixture.transaction.user.findUnique.mockResolvedValue(devUser);

		await expect(
			adminFixture.service.updateUser(
				devUser.id,
				{ isDev: false },
				'admin-1',
				[Role.USER, Role.ADMIN]
			)
		).rejects.toThrow(
			'Роль DEV может менять только пользователь с ролью DEV'
		);
		expect(adminFixture.transaction.user.update).not.toHaveBeenCalled();

		const lastDevFixture = createFixture();
		lastDevFixture.prisma.user.findUnique.mockResolvedValue(devUser);
		lastDevFixture.transaction.user.findUnique.mockResolvedValue(devUser);
		lastDevFixture.transaction.user.count.mockResolvedValue(1);

		await expect(
			lastDevFixture.service.updateUser(
				devUser.id,
				{ isDev: false },
				'dev-2',
				[Role.USER, Role.ADMIN, Role.DEV]
			)
		).rejects.toThrow(
			'Нельзя снять роль DEV с последней активной DEV-учётной записи'
		);
		expect(lastDevFixture.transaction.user.update).not.toHaveBeenCalled();
	});

	it('demotes another DEV when another active DEV remains', async () => {
		const { service, prisma, transaction } = createFixture();
		const devUser = createUser({
			rights: [Role.USER, Role.ADMIN, Role.DEV]
		});
		const demotedUser = createUser({
			rights: [Role.USER, Role.ADMIN]
		});
		prisma.user.findUnique.mockResolvedValue(devUser);
		transaction.user.findUnique
			.mockResolvedValueOnce(devUser)
			.mockResolvedValueOnce(demotedUser);
		transaction.user.update.mockResolvedValue(demotedUser);

		const result = await service.updateUser(
			devUser.id,
			{ isDev: false },
			'dev-2',
			[Role.USER, Role.ADMIN, Role.DEV]
		);

		expect(transaction.user.count).toHaveBeenCalledWith({
			where: {
				status: UserStatus.ACTIVE,
				deletedAt: null,
				rights: {
					has: Role.DEV
				}
			}
		});
		expect(transaction.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: devUser.id },
				data: expect.objectContaining({
					rights: [Role.USER, Role.ADMIN]
				})
			})
		);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
		expect(result?.rights).toEqual([Role.USER, Role.ADMIN]);
	});

	it('maps a concurrent DEV demotion serialization conflict to 409', async () => {
		const { service, prisma } = createFixture();
		const devUser = createUser({
			rights: [Role.USER, Role.ADMIN, Role.DEV]
		});
		prisma.user.findUnique.mockResolvedValue(devUser);
		prisma.$transaction.mockRejectedValue({ code: 'P2034' });

		await expect(
			service.updateUser(devUser.id, { isDev: false }, 'dev-2', [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('restores a user as DEACTIVATED without restoring sessions or widgets', async () => {
		const { service, prisma, transaction } = createFixture();
		const consentRevokedAt = new Date('2026-07-27T08:00:00.000Z');
		const user = createUser({
			status: UserStatus.DEACTIVATED,
			personalDataConsentRevokedAt: consentRevokedAt,
			deletedAt: new Date('2026-07-28T08:00:00.000Z')
		});
		prisma.user.findUnique.mockResolvedValue(user);
		prisma.user.update.mockImplementation(({ data }) =>
			Promise.resolve({
				...user,
				...data
			})
		);

		const result = await service.restoreUser(user.id);

		expect(prisma.user.update).toHaveBeenCalledWith({
			where: { id: user.id },
			data: {
				deletedAt: null,
				status: UserStatus.DEACTIVATED
			},
			include: {
				authIdentities: true
			}
		});
		expect(result.deletedAt).toBeNull();
		expect(result.status).toBe(UserStatus.DEACTIVATED);
		expect(result.personalDataConsentRevokedAt).toEqual(consentRevokedAt);
		expect(transaction.userSession.updateMany).not.toHaveBeenCalled();
		expect(transaction.widget.updateMany).not.toHaveBeenCalled();
	});

	it('rejects changes and admin details for a deleted user until restore', async () => {
		const deletedUser = createUser({
			status: UserStatus.DEACTIVATED,
			deletedAt: new Date('2026-07-28T08:00:00.000Z')
		});

		const updateFixture = createFixture();
		updateFixture.prisma.user.findUnique.mockResolvedValue(deletedUser);
		await expect(
			updateFixture.service.updateUser(
				deletedUser.id,
				{
					name: 'Новое имя'
				},
				'admin-1',
				[Role.USER, Role.ADMIN]
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(updateFixture.prisma.$transaction).not.toHaveBeenCalled();

		const toggleFixture = createFixture();
		toggleFixture.prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.DEACTIVATED,
			deletedAt: deletedUser.deletedAt
		});
		await expect(
			toggleFixture.service.toggleUserActivation(
				deletedUser.id,
				'admin-1',
				[Role.USER, Role.ADMIN]
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(toggleFixture.prisma.$transaction).not.toHaveBeenCalled();

		const editFixture = createFixture();
		editFixture.prisma.user.findUnique.mockResolvedValue(deletedUser);
		await expect(
			editFixture.service.getAdminEditableUserById(deletedUser.id)
		).rejects.toBeInstanceOf(BadRequestException);

		const overviewFixture = createFixture();
		overviewFixture.prisma.user.findUnique.mockResolvedValue(deletedUser);
		await expect(
			overviewFixture.service.getAdminUserOverview(deletedUser.id)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(overviewFixture.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('deactivation revokes sessions and disables online consultant with the other widgets', async () => {
		const { service, prisma, transaction } = createFixture();
		const user = createUser();
		prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.ACTIVE,
			deletedAt: null
		});
		transaction.user.findUnique
			.mockResolvedValueOnce(user)
			.mockResolvedValueOnce({
				...user,
				status: UserStatus.DEACTIVATED,
				personalDataConsentRevokedAt: now
			});

		await service.toggleUserActivation(user.id, 'admin-1', [
			Role.USER,
			Role.ADMIN
		]);

		expect(transaction.user.updateMany).toHaveBeenCalledWith({
			where: {
				id: user.id,
				status: UserStatus.ACTIVE,
				deletedAt: null
			},
			data: {
				status: UserStatus.DEACTIVATED,
				personalDataConsentRevokedAt: expect.any(Date)
			}
		});
		expect(transaction.userSession.updateMany).toHaveBeenCalledTimes(1);
		for (const delegate of [
			transaction.widget,
			transaction.quiz,
			transaction.callback,
			transaction.countdownTimer,
			transaction.stopOffer,
			transaction.onlineConsultant,
			transaction.calculator
		]) {
			expect(delegate.updateMany).toHaveBeenCalledTimes(1);
		}
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	});

	it('rejects self-deactivation, ADMIN status changes for DEV, and last active DEV deactivation', async () => {
		const devUser = createUser({
			rights: [Role.USER, Role.ADMIN, Role.DEV]
		});
		const selfFixture = createFixture();
		selfFixture.prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.ACTIVE,
			deletedAt: null
		});
		selfFixture.transaction.user.findUnique.mockResolvedValue(devUser);

		await expect(
			selfFixture.service.toggleUserActivation(devUser.id, devUser.id, [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toThrow('Нельзя деактивировать собственную учётную запись');
		expect(selfFixture.transaction.user.updateMany).not.toHaveBeenCalled();

		const adminFixture = createFixture();
		adminFixture.prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.ACTIVE,
			deletedAt: null
		});
		adminFixture.transaction.user.findUnique.mockResolvedValue(devUser);

		await expect(
			adminFixture.service.toggleUserActivation(devUser.id, 'admin-1', [
				Role.USER,
				Role.ADMIN
			])
		).rejects.toThrow(
			'Изменять статус пользователя с ролью DEV может только DEV'
		);
		expect(
			adminFixture.transaction.user.updateMany
		).not.toHaveBeenCalled();

		const lastDevFixture = createFixture();
		lastDevFixture.prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.ACTIVE,
			deletedAt: null
		});
		lastDevFixture.transaction.user.findUnique.mockResolvedValue(devUser);
		lastDevFixture.transaction.user.count.mockResolvedValue(1);

		await expect(
			lastDevFixture.service.toggleUserActivation(devUser.id, 'dev-2', [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toThrow(
			'Нельзя деактивировать последнюю активную DEV-учётную запись'
		);
		expect(
			lastDevFixture.transaction.user.updateMany
		).not.toHaveBeenCalled();
	});

	it('maps a concurrent DEV deactivation serialization conflict to 409', async () => {
		const { service, prisma } = createFixture();
		prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.ACTIVE,
			deletedAt: null
		});
		prisma.$transaction.mockRejectedValue({ code: 'P2034' });

		await expect(
			service.toggleUserActivation('dev-1', 'dev-2', [
				Role.USER,
				Role.ADMIN,
				Role.DEV
			])
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('does not reactivate a user when soft delete wins the activation race', async () => {
		const { service, prisma, transaction } = createFixture();
		const user = createUser({
			status: UserStatus.DEACTIVATED
		});
		prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.DEACTIVATED,
			deletedAt: null
		});
		transaction.user.findUnique.mockResolvedValue(user);
		transaction.user.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			service.toggleUserActivation(user.id, 'admin-1', [
				Role.USER,
				Role.ADMIN
			])
		).rejects.toBeInstanceOf(ConflictException);

		expect(transaction.user.updateMany).toHaveBeenCalledWith({
			where: {
				id: user.id,
				status: UserStatus.DEACTIVATED,
				deletedAt: null
			},
			data: {
				status: UserStatus.ACTIVE,
				personalDataConsentRevokedAt: null
			}
		});
		expect(transaction.user.findUnique).toHaveBeenCalledTimes(1);
	});

	it('keeps all widgets disabled when a restored user is activated', async () => {
		const { service, prisma, transaction } = createFixture();
		const user = createUser({
			status: UserStatus.DEACTIVATED
		});
		prisma.user.findUnique.mockResolvedValue({
			status: UserStatus.DEACTIVATED,
			deletedAt: null
		});
		transaction.user.findUnique
			.mockResolvedValueOnce(user)
			.mockResolvedValueOnce({
				...user,
				status: UserStatus.ACTIVE
			});

		await service.toggleUserActivation(user.id, 'admin-1', [
			Role.USER,
			Role.ADMIN
		]);

		expect(transaction.userSession.updateMany).not.toHaveBeenCalled();
		for (const delegate of [
			transaction.widget,
			transaction.quiz,
			transaction.callback,
			transaction.countdownTimer,
			transaction.stopOffer,
			transaction.onlineConsultant,
			transaction.calculator
		]) {
			expect(delegate.updateMany).toHaveBeenCalledWith({
				where: { userId: user.id },
				data: { isActive: false }
			});
		}
	});
});
