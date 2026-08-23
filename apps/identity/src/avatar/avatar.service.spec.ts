import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { AvatarMediaObjectStatus, Role } from '@prisma/identity-client';
import type { Request } from 'express';
import { AvatarService } from './avatar.service';

const USER_ID = 'user-1';
const OLD_ID = '123e4567-e89b-42d3-a456-426614174000';
const NEW_ID = '223e4567-e89b-42d3-a456-426614174000';
const OWNED_URL = `https://cdn.example.test/bucket/identity/avatars/user-1/${OLD_ID}`;
const NEW_URL = `https://cdn.example.test/bucket/identity/avatars/user-1/${NEW_ID}`;

function request(): Request {
	return {
		header: jest.fn((name: string) =>
			name === 'x-correlation-id' ? 'correlation-1' : undefined
		),
		get: jest.fn(),
		headers: {},
		socket: { remoteAddress: '127.0.0.1' }
	} as unknown as Request;
}

function target(overrides: Record<string, unknown> = {}) {
	return {
		id: USER_ID,
		name: 'User',
		password: 'hash',
		avatarPath: OWNED_URL,
		status: 'ACTIVE',
		personalDataConsentRevokedAt: null,
		deletedAt: null,
		rights: [Role.USER],
		createdAt: new Date(),
		updatedAt: new Date(),
		authIdentities: [],
		telegramNotificationChannel: null,
		...overrides
	};
}

function setup(current = target()) {
	const tx = {
		$queryRaw: jest.fn().mockResolvedValue([]),
		avatarMediaObject: {
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		user: {
			findUnique: jest.fn().mockResolvedValue(current),
			update: jest.fn().mockResolvedValue(current),
			findMany: jest.fn().mockResolvedValue([])
		}
	};
	const prisma = {
		user: { findUnique: jest.fn().mockResolvedValue(current) },
		avatarMediaObject: {
			create: jest.fn().mockResolvedValue({}),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		$transaction: jest.fn(
			async (callback: (transaction: typeof tx) => unknown) => callback(tx)
		)
	};
	const events = {
		emitUserChanged: jest.fn().mockResolvedValue(undefined),
		emitAudit: jest.fn().mockResolvedValue(undefined)
	};
	const storage = {
		prepare: jest.fn().mockReturnValue({
			id: NEW_ID,
			userId: USER_ID,
			objectKey: `identity/avatars/${USER_ID}/${NEW_ID}`,
			avatarPath: NEW_URL,
			body: Buffer.from('avatar'),
			contentType: 'image/png'
		}),
		upload: jest.fn().mockResolvedValue(undefined),
		ownedObject: jest.fn((_: string, value: string) =>
			value === OWNED_URL
				? {
						id: OLD_ID,
						objectKey: `identity/avatars/${USER_ID}/${OLD_ID}`
					}
				: null
		)
	};
	const cleanup = {
		kick: jest.fn(),
		deleteNow: jest.fn().mockResolvedValue(undefined)
	};
	const service = new AvatarService(
		prisma as any,
		events as any,
		storage as any,
		cleanup as any
	);
	return { service, prisma, tx, events, storage, cleanup };
}

describe('AvatarService', () => {
	it('uploads self avatar and changes avatarPath transactionally', async () => {
		const value = setup();
		const file = {} as Express.Multer.File;
		await expect(
			value.service.uploadSelf(USER_ID, file, request())
		).resolves.toEqual({
			avatarPath: NEW_URL
		});
		expect(value.storage.prepare).toHaveBeenCalledWith(USER_ID, file);
		expect(value.storage.upload).toHaveBeenCalledWith(
			expect.objectContaining({ id: NEW_ID, avatarPath: NEW_URL })
		);
		expect(value.prisma.avatarMediaObject.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				id: NEW_ID,
				userId: USER_ID,
				publicUrl: NEW_URL,
				status: AvatarMediaObjectStatus.PREPARED
			})
		});
		expect(value.tx.user.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { avatarPath: NEW_URL }
		});
		expect(value.events.emitUserChanged).toHaveBeenCalled();
		expect(value.cleanup.deleteNow).toHaveBeenCalledWith(OLD_ID);
	});

	it('emits the existing USER_UPDATE audit for an admin upload', async () => {
		const value = setup();
		await value.service.uploadAdmin(
			'admin-1',
			[Role.ADMIN],
			USER_ID,
			{} as Express.Multer.File,
			request()
		);
		expect(value.events.emitAudit).toHaveBeenCalledWith(
			value.tx,
			expect.objectContaining({
				actorId: 'admin-1',
				targetUserId: USER_ID,
				action: 'USER_UPDATE',
				metadata: {
					changedFields: ['avatarPath'],
					passwordChanged: false
				}
			})
		);
	});

	it('blocks non-DEV admins before storage access for a DEV target', async () => {
		const value = setup(target({ rights: [Role.USER, Role.DEV] }));
		await expect(
			value.service.uploadAdmin(
				'admin-1',
				[Role.ADMIN],
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(value.storage.upload).not.toHaveBeenCalled();
	});

	it('commits the clear before deleting the exact owned object', async () => {
		const value = setup();
		await expect(
			value.service.deleteSelf(USER_ID, request())
		).resolves.toEqual({
			avatarPath: null
		});
		expect(value.tx.avatarMediaObject.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: OLD_ID,
				status: AvatarMediaObjectStatus.ACTIVE
			}),
			data: expect.objectContaining({
				status: AvatarMediaObjectStatus.DELETE_PENDING
			})
		});
		expect(value.tx.user.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { avatarPath: null }
		});
		expect(value.cleanup.deleteNow).toHaveBeenCalledWith(OLD_ID);
	});

	it('clears an external OAuth URL without deleting any S3 object', async () => {
		const external = 'https://avatars.githubusercontent.com/u/1';
		const value = setup(target({ avatarPath: external }));
		value.storage.ownedObject.mockReturnValue(null);
		await value.service.deleteSelf(USER_ID, request());
		expect(value.storage.ownedObject).toHaveBeenCalledWith(
			USER_ID,
			external
		);
		expect(value.cleanup.deleteNow).not.toHaveBeenCalled();
		expect(value.tx.user.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { avatarPath: null }
		});
	});

	it('maps storage failures to a safe 503 without leaking provider errors', async () => {
		const value = setup();
		value.storage.upload.mockRejectedValue(
			new Error('secret provider error')
		);
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toEqual(
			new ServiceUnavailableException(
				'Avatar storage is temporarily unavailable'
			)
		);
		expect(value.prisma.avatarMediaObject.updateMany).toHaveBeenCalledWith(
			{
				where: { id: NEW_ID, status: AvatarMediaObjectStatus.PREPARED },
				data: expect.objectContaining({
					status: AvatarMediaObjectStatus.DELETE_PENDING,
					deletePasses: 0
				})
			}
		);
		expect(
			value.prisma.avatarMediaObject.updateMany.mock.calls.at(-1)?.[0].data
		).not.toHaveProperty('availableAt');
		expect(value.cleanup.kick).toHaveBeenCalled();
	});

	it('queues the immutable upload for cleanup when the DB transaction fails', async () => {
		const value = setup();
		value.prisma.$transaction.mockRejectedValueOnce(
			new Error('db failed')
		);
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toThrow('db failed');
		expect(value.storage.upload).toHaveBeenCalled();
		expect(value.prisma.avatarMediaObject.updateMany).toHaveBeenCalledWith(
			{
				where: { id: NEW_ID, status: AvatarMediaObjectStatus.PREPARED },
				data: expect.objectContaining({
					status: AvatarMediaObjectStatus.DELETE_PENDING
				})
			}
		);
		expect(value.cleanup.deleteNow).not.toHaveBeenCalled();
	});

	it('does not touch storage when delete DB/outbox transaction fails', async () => {
		const value = setup();
		value.events.emitUserChanged.mockRejectedValueOnce(
			new Error('outbox failed')
		);
		await expect(
			value.service.deleteSelf(USER_ID, request())
		).rejects.toThrow('outbox failed');
		expect(value.cleanup.deleteNow).not.toHaveBeenCalled();
	});
});
