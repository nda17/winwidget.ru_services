import { AvatarMediaObjectStatus } from '@prisma/identity-client';
import { AvatarCleanupService } from './avatar-cleanup.service';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = 'user-1';
const OBJECT_KEY = `identity/avatars/${USER_ID}/${ID}`;
const PUBLIC_URL = `https://cdn.example.test/bucket/${OBJECT_KEY}`;

function setup(
	options: { referenced?: boolean; deleteFails?: boolean } = {}
) {
	const object = {
		id: ID,
		userId: USER_ID,
		objectKey: OBJECT_KEY,
		publicUrl: PUBLIC_URL,
		status: AvatarMediaObjectStatus.DELETING,
		attempts: 1,
		deletePasses: 0,
		availableAt: new Date(0),
		leaseToken: ID,
		leaseExpiresAt: new Date(Date.now() + 30_000),
		lastError: null,
		createdAt: new Date(0),
		updatedAt: new Date(0)
	};
	const prisma = {
		avatarMediaObject: {
			findFirst: jest
				.fn()
				.mockResolvedValueOnce({
					...object,
					status: AvatarMediaObjectStatus.DELETE_PENDING
				})
				.mockResolvedValue(null),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			findUniqueOrThrow: jest.fn().mockResolvedValue(object),
			deleteMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		user: {
			count: jest.fn().mockResolvedValue(options.referenced ? 1 : 0)
		}
	};
	const storage = {
		deleteObject: options.deleteFails
			? jest.fn().mockRejectedValue(new Error('provider failed'))
			: jest.fn().mockResolvedValue(undefined)
	};
	const service = new AvatarCleanupService(prisma as any, storage as any);
	return { service, prisma, storage, object };
}

describe('AvatarCleanupService', () => {
	it('keeps a tombstone for a delayed confirmation delete', async () => {
		const value = setup();
		await expect(value.service.runOnce()).resolves.toBe(1);
		expect(value.prisma.user.count).toHaveBeenCalledWith({
			where: { id: USER_ID, avatarPath: PUBLIC_URL }
		});
		expect(value.storage.deleteObject).toHaveBeenCalledWith(OBJECT_KEY);
		expect(
			value.prisma.avatarMediaObject.deleteMany
		).not.toHaveBeenCalled();
		expect(
			value.prisma.avatarMediaObject.updateMany
		).toHaveBeenLastCalledWith({
			where: expect.objectContaining({
				id: ID,
				status: AvatarMediaObjectStatus.DELETING
			}),
			data: expect.objectContaining({
				status: AvatarMediaObjectStatus.DELETE_PENDING,
				deletePasses: { increment: 1 },
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: null
			})
		});
	});

	it('removes metadata only after the delayed confirmation delete', async () => {
		const value = setup();
		value.prisma.avatarMediaObject.findUniqueOrThrow.mockResolvedValue({
			...value.object,
			deletePasses: 1
		});
		await expect(value.service.runOnce()).resolves.toBe(1);
		expect(value.storage.deleteObject).toHaveBeenCalledWith(OBJECT_KEY);
		expect(value.prisma.avatarMediaObject.deleteMany).toHaveBeenCalledWith(
			{
				where: expect.objectContaining({
					id: ID,
					status: AvatarMediaObjectStatus.DELETING
				})
			}
		);
	});

	it('never deletes an object that is still referenced by the user', async () => {
		const value = setup({ referenced: true });
		await expect(value.service.runOnce()).resolves.toBe(1);
		expect(value.storage.deleteObject).not.toHaveBeenCalled();
		expect(
			value.prisma.avatarMediaObject.updateMany
		).toHaveBeenLastCalledWith({
			where: expect.objectContaining({
				id: ID,
				status: AvatarMediaObjectStatus.DELETING
			}),
			data: {
				status: AvatarMediaObjectStatus.ACTIVE,
				deletePasses: 0,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: null
			}
		});
	});

	it('retains a durable retry when object deletion fails', async () => {
		const value = setup({ deleteFails: true });
		await expect(value.service.runOnce()).resolves.toBe(1);
		expect(
			value.prisma.avatarMediaObject.deleteMany
		).not.toHaveBeenCalled();
		expect(
			value.prisma.avatarMediaObject.updateMany
		).toHaveBeenLastCalledWith({
			where: expect.objectContaining({
				id: ID,
				status: AvatarMediaObjectStatus.DELETING
			}),
			data: expect.objectContaining({
				status: AvatarMediaObjectStatus.DELETE_PENDING,
				leaseToken: null,
				leaseExpiresAt: null
			})
		});
	});
});
