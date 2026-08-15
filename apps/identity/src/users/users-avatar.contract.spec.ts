import {
	BadRequestException,
	RequestMethod,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	GUARDS_METADATA,
	INTERCEPTORS_METADATA,
	METHOD_METADATA,
	PATH_METADATA
} from '@nestjs/common/constants';
import { Role } from '@prisma/identity-client';
import { AvatarMediaOwnershipGuard } from '../avatar/avatar-media-ownership.service';
import { AvatarUploadAdmissionInterceptor } from '../avatar/avatar-upload-admission.service';
import { IDENTITY_ROLES, IdentityAuthGuard } from '../auth/auth.guard';
import {
	AVATAR_UPLOAD_OPTIONS,
	UsersController
} from './users.controller';

type AvatarHandler =
	| 'uploadProfileAvatar'
	| 'deleteProfileAvatar'
	| 'uploadUserAvatar'
	| 'deleteUserAvatar';

function metadata(handler: AvatarHandler) {
	const value = UsersController.prototype[handler];
	return {
		path: Reflect.getMetadata(PATH_METADATA, value),
		method: Reflect.getMetadata(METHOD_METADATA, value),
		roles: Reflect.getMetadata(IDENTITY_ROLES, value) as Role[],
		guards:
			(Reflect.getMetadata(GUARDS_METADATA, value) as unknown[]) || [],
		interceptors:
			(Reflect.getMetadata(INTERCEPTORS_METADATA, value) as unknown[]) ||
			[]
	};
}

describe('Identity avatar HTTP contract', () => {
	it('freezes exact self/admin POST+DELETE routes and roles', () => {
		expect(Reflect.getMetadata(PATH_METADATA, UsersController)).toBe(
			'users'
		);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, UsersController)
		).toContain(IdentityAuthGuard);
		expect(metadata('uploadProfileAvatar')).toMatchObject({
			path: 'profile/avatar',
			method: RequestMethod.POST,
			roles: [Role.USER]
		});
		expect(metadata('deleteProfileAvatar')).toMatchObject({
			path: 'profile/avatar',
			method: RequestMethod.DELETE,
			roles: [Role.USER]
		});
		expect(metadata('uploadUserAvatar')).toMatchObject({
			path: 'user/:id/avatar',
			method: RequestMethod.POST,
			roles: [Role.ADMIN]
		});
		expect(metadata('deleteUserAvatar')).toMatchObject({
			path: 'user/:id/avatar',
			method: RequestMethod.DELETE,
			roles: [Role.ADMIN]
		});
		expect(metadata('uploadProfileAvatar').interceptors).toHaveLength(2);
		expect(metadata('uploadUserAvatar').interceptors).toHaveLength(2);
		expect(metadata('uploadProfileAvatar').interceptors[0]).toBe(
			AvatarUploadAdmissionInterceptor
		);
		expect(metadata('uploadUserAvatar').interceptors[0]).toBe(
			AvatarUploadAdmissionInterceptor
		);
		expect(metadata('deleteProfileAvatar').interceptors).toHaveLength(0);
		expect(metadata('deleteUserAvatar').interceptors).toHaveLength(0);
		for (const handler of [
			'uploadProfileAvatar',
			'deleteProfileAvatar',
			'uploadUserAvatar',
			'deleteUserAvatar'
		] as const) {
			expect(metadata(handler).guards).toContain(
				AvatarMediaOwnershipGuard
			);
		}
	});

	it('rejects PREPARED before the multipart interceptor or handler phase', async () => {
		const ownership = {
			assertActive: jest
				.fn()
				.mockRejectedValue(
					new ServiceUnavailableException(
						'Avatar media ownership is not active'
					)
				)
		};
		const guard = new AvatarMediaOwnershipGuard(ownership as any);
		const handler = jest.fn();
		const interceptor = jest.fn();

		await expect(guard.canActivate()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(interceptor).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});

	it('freezes multipart field bounds and declared MIME allowlist', () => {
		expect(AVATAR_UPLOAD_OPTIONS.limits).toEqual({
			fileSize: 5 * 1024 * 1024,
			files: 1,
			fields: 0,
			parts: 1
		});
		const rejected = jest.fn();
		AVATAR_UPLOAD_OPTIONS.fileFilter(
			{} as Express.Request,
			{ mimetype: 'image/svg+xml' } as Express.Multer.File,
			rejected
		);
		expect(rejected).toHaveBeenCalledWith(
			expect.any(BadRequestException),
			false
		);

		const accepted = jest.fn();
		AVATAR_UPLOAD_OPTIONS.fileFilter(
			{} as Express.Request,
			{ mimetype: 'image/webp' } as Express.Multer.File,
			accepted
		);
		expect(accepted).toHaveBeenCalledWith(null, true);
	});

	it('passes through only the narrow avatar response contract', async () => {
		const avatars = {
			uploadSelf: jest.fn().mockResolvedValue({
				avatarPath: 'https://cdn.example.test/new.webp'
			}),
			deleteSelf: jest.fn().mockResolvedValue({ avatarPath: null })
		};
		const controller = new UsersController({} as any, avatars as any);
		await expect(
			controller.uploadProfileAvatar(
				'user-1',
				{} as Express.Multer.File,
				{} as any
			)
		).resolves.toEqual({
			avatarPath: 'https://cdn.example.test/new.webp'
		});
		await expect(
			controller.deleteProfileAvatar('user-1', {} as any)
		).resolves.toEqual({ avatarPath: null });
	});
});
