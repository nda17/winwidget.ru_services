import 'reflect-metadata';

import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import type { UserIdentityBindingService } from '@/user/user-identity-binding.service';
import { UserController } from '@/user/user.controller';
import type { UserService } from '@/user/user.service';
import { Role, UserStatus } from '@prisma/client';
import type { Request } from 'express';

describe('UserController soft delete', () => {
	const request = {} as Request;
	const deletedAt = new Date('2026-07-28T09:00:00.000Z');

	const createFixture = () => {
		const deletedUser = {
			id: 'user-1',
			name: 'Пользователь',
			avatarPath: null,
			status: UserStatus.DEACTIVATED,
			personalDataConsentRevokedAt: deletedAt,
			deletedAt,
			rights: [Role.USER],
			createdAt: deletedAt,
			updatedAt: deletedAt,
			email: 'user@example.com',
			phone: null,
			isPhoneVerified: false,
			loginMethods: ['EMAIL']
		};
		const userService = {
			getUserList: jest.fn().mockResolvedValue({
				items: [],
				total: 0,
				page: 1,
				limit: 20,
				totalPages: 1
			}),
			updateUser: jest.fn().mockResolvedValue({
				...deletedUser,
				status: UserStatus.ACTIVE,
				deletedAt: null
			}),
			toggleUserActivation: jest.fn().mockResolvedValue({
				...deletedUser,
				status: UserStatus.ACTIVE,
				deletedAt: null
			}),
			deleteUser: jest.fn().mockResolvedValue(deletedUser),
			restoreUser: jest.fn().mockResolvedValue({
				...deletedUser,
				deletedAt: null
			})
		};
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue(undefined)
		};
		const controller = new UserController(
			userService as unknown as UserService,
			{} as UserIdentityBindingService,
			{} as TelegramBotService,
			adminEventLogService as unknown as AdminEventLogService
		);

		return {
			controller,
			userService,
			adminEventLogService
		};
	};

	it('passes includeDeleted and current rights to the list service', async () => {
		const { controller, userService } = createFixture();
		const rights = [Role.USER, Role.ADMIN, Role.DEV];

		await controller.getUserList(
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'true',
			undefined,
			rights
		);

		expect(userService.getUserList).toHaveBeenCalledWith(
			undefined,
			1,
			20,
			{
				role: undefined,
				registeredFrom: undefined,
				registeredTo: undefined,
				subscription: undefined,
				includeDeleted: true,
				deletedOnly: false
			},
			rights
		);
	});

	it('records USER_SOFT_DELETE without exposing the password', async () => {
		const { controller, userService, adminEventLogService } =
			createFixture();
		const rights = [Role.USER, Role.ADMIN];

		const result = await controller.deleteUser(
			'user-1',
			'admin-1',
			rights,
			request
		);

		expect(userService.deleteUser).toHaveBeenCalledWith(
			'user-1',
			'admin-1',
			rights
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				adminId: 'admin-1',
				action: 'USER_SOFT_DELETE',
				targetUserId: 'user-1',
				metadata: expect.objectContaining({
					deletedAt: deletedAt.toISOString()
				})
			})
		);
		expect(result).not.toHaveProperty('password');
	});

	it('passes the acting administrator to DEV-sensitive mutations', async () => {
		const { controller, userService } = createFixture();
		const rights = [Role.USER, Role.ADMIN, Role.DEV];

		await controller.updateUser(
			'user-1',
			{ isDev: false },
			'dev-1',
			rights,
			request
		);
		await controller.toggleUserActivation(
			'user-1',
			'dev-1',
			rights,
			request
		);

		expect(userService.updateUser).toHaveBeenCalledWith(
			'user-1',
			{ isDev: false },
			'dev-1',
			rights
		);
		expect(userService.toggleUserActivation).toHaveBeenCalledWith(
			'user-1',
			'dev-1',
			rights
		);
	});

	it('keeps restore DEV-only and records USER_RESTORE', async () => {
		const { controller, adminEventLogService } = createFixture();

		expect(
			Reflect.getMetadata('roles', UserController.prototype.restoreUser)
		).toEqual([Role.DEV]);

		const result = await controller.restoreUser(
			'user-1',
			'dev-1',
			request
		);

		expect(result.status).toBe(UserStatus.DEACTIVATED);
		expect(result.deletedAt).toBeNull();
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				adminId: 'dev-1',
				action: 'USER_RESTORE',
				targetUserId: 'user-1',
				metadata: {
					status: UserStatus.DEACTIVATED,
					deletedAt: null
				}
			})
		);
	});
});
