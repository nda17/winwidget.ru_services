import {
	BadRequestException,
	INestApplication,
	RequestMethod
} from '@nestjs/common';
import {
	GUARDS_METADATA,
	METHOD_METADATA,
	PATH_METADATA
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/identity-client';
import request from 'supertest';
import { AVATAR_MAX_UPLOAD_BYTES } from '../avatar/avatar-storage.service';
import { AvatarService } from '../avatar/avatar.service';
import { IDENTITY_ROLES, IdentityAuthGuard } from '../auth/auth.guard';
import {
	AVATAR_UPLOAD_OPTIONS,
	transformAvatarUploadException,
	UsersController
} from './users.controller';
import { UsersService } from './users.service';

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(4),
	Buffer.from('IHDR'),
	Buffer.alloc(8)
]);

describe('Identity avatar HTTP contract', () => {
	let app: INestApplication;
	const avatars = {
		uploadSelf: jest.fn(),
		uploadAdmin: jest.fn(),
		deleteSelf: jest.fn(),
		deleteAdmin: jest.fn()
	};

	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [UsersController],
			providers: [
				{ provide: UsersService, useValue: {} },
				{ provide: AvatarService, useValue: avatars }
			]
		})
			.overrideGuard(IdentityAuthGuard)
			.useValue({
				canActivate: (context: any) => {
					context.switchToHttp().getRequest().identityActor = {
						id: 'user-1',
						sessionId: 'session-1',
						rights: [Role.USER, Role.ADMIN]
					};
					return true;
				}
			})
			.compile();
		app = module.createNestApplication();
		app.setGlobalPrefix('api/v1');
		await app.init();
	});

	afterAll(() => app?.close());

	beforeEach(() => {
		jest.clearAllMocks();
		avatars.uploadSelf.mockResolvedValue({
			avatarPath: 'https://cdn/avatar'
		});
		avatars.uploadAdmin.mockResolvedValue({
			avatarPath: 'https://cdn/avatar'
		});
		avatars.deleteSelf.mockResolvedValue({ avatarPath: null });
		avatars.deleteAdmin.mockResolvedValue({ avatarPath: null });
	});

	it('serves exact self PUT/DELETE multipart endpoints', async () => {
		const response = await request(app.getHttpServer())
			.put('/api/v1/users/profile/avatar')
			.attach('file', PNG, {
				filename: 'avatar.png',
				contentType: 'image/png'
			});
		expect({ status: response.status, body: response.body }).toEqual({
			status: 200,
			body: { avatarPath: 'https://cdn/avatar' }
		});
		expect(avatars.uploadSelf).toHaveBeenCalledWith(
			'user-1',
			expect.objectContaining({ mimetype: 'image/png', size: PNG.length }),
			expect.anything()
		);
		await request(app.getHttpServer())
			.delete('/api/v1/users/profile/avatar')
			.expect(200, { avatarPath: null });
	});

	it('serves exact admin PUT/DELETE multipart endpoints', async () => {
		await request(app.getHttpServer())
			.put('/api/v1/users/user/target-1/avatar')
			.attach('file', PNG, {
				filename: 'avatar.png',
				contentType: 'image/png'
			})
			.expect(200, { avatarPath: 'https://cdn/avatar' });
		expect(avatars.uploadAdmin).toHaveBeenCalledWith(
			'user-1',
			[Role.USER, Role.ADMIN],
			'target-1',
			expect.objectContaining({ mimetype: 'image/png' }),
			expect.anything()
		);
		await request(app.getHttpServer())
			.delete('/api/v1/users/user/target-1/avatar')
			.expect(200, { avatarPath: null });
	});

	it('rejects a declared MIME outside the allowlist before the service', async () => {
		await request(app.getHttpServer())
			.put('/api/v1/users/profile/avatar')
			.attach('file', Buffer.from('<svg/>'), {
				filename: 'avatar.svg',
				contentType: 'image/svg+xml'
			})
			.expect(400);
		expect(avatars.uploadSelf).not.toHaveBeenCalled();
	});

	it('rejects multipart text fields before the service', async () => {
		await request(app.getHttpServer())
			.put('/api/v1/users/profile/avatar')
			.field('profile[name]', 'attacker-controlled')
			.attach('file', PNG, {
				filename: 'avatar.png',
				contentType: 'image/png'
			})
			.expect(400);
		expect(avatars.uploadSelf).not.toHaveBeenCalled();
	});

	it('rejects an oversized avatar before the service', async () => {
		await request(app.getHttpServer())
			.put('/api/v1/users/profile/avatar')
			.attach('file', Buffer.alloc(AVATAR_MAX_UPLOAD_BYTES + 1), {
				filename: 'avatar.png',
				contentType: 'image/png'
			})
			.expect(413);
		expect(avatars.uploadSelf).not.toHaveBeenCalled();
	});

	it('sets finite multipart limits for both avatar endpoints', () => {
		expect(AVATAR_UPLOAD_OPTIONS.limits).toEqual({
			fieldNameSize: 64,
			fieldSize: 64,
			fileSize: AVATAR_MAX_UPLOAD_BYTES,
			files: 1,
			fields: 0,
			parts: 2,
			fieldNestingDepth: 0
		});
	});

	it('maps Multer field nesting errors to HTTP 400', () => {
		const error = Object.assign(new Error('Field name nesting too deep'), {
			code: 'LIMIT_FIELD_NESTING'
		});

		const transformed = transformAvatarUploadException(error);

		expect(transformed).toBeInstanceOf(BadRequestException);
		expect((transformed as BadRequestException).getStatus()).toBe(400);
	});

	it('does not hide unrelated upload errors', () => {
		const error = new Error('Unexpected upload failure');

		expect(transformAvatarUploadException(error)).toBe(error);
	});

	it('freezes PUT methods, paths, roles and the Identity auth guard', () => {
		const self = UsersController.prototype.uploadProfileAvatar;
		const admin = UsersController.prototype.uploadUserAvatar;
		expect(Reflect.getMetadata(PATH_METADATA, UsersController)).toBe(
			'users'
		);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, UsersController)
		).toContain(IdentityAuthGuard);
		expect(Reflect.getMetadata(PATH_METADATA, self)).toBe(
			'profile/avatar'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, self)).toBe(
			RequestMethod.PUT
		);
		expect(Reflect.getMetadata(IDENTITY_ROLES, self)).toEqual([Role.USER]);
		expect(Reflect.getMetadata(PATH_METADATA, admin)).toBe(
			'user/:id/avatar'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, admin)).toBe(
			RequestMethod.PUT
		);
		expect(Reflect.getMetadata(IDENTITY_ROLES, admin)).toEqual([
			Role.ADMIN
		]);
	});
});
