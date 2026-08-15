import {
	ConflictException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	AvatarCleanupKind,
	AvatarCleanupStatus,
	Prisma,
	Role
} from '@prisma/identity-client';
import type { Request } from 'express';
import { AvatarService } from './avatar.service';

const USER_ID = 'user-1';
const OLD_KEY =
	'identity/avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/00000000-0000-4000-8000-000000000001.webp';
const NEW_KEY =
	'identity/avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/00000000-0000-4000-8000-000000000002.webp';

function transactionConflict() {
	return new Prisma.PrismaClientKnownRequestError(
		'SERIALIZABLE transaction conflict',
		{ code: 'P2034', clientVersion: '5.22.0' }
	);
}

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
		avatarPath: 'https://cdn.example.test/old.webp',
		avatarObjectKey: OLD_KEY,
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

function setup(overrides: Record<string, unknown> = {}) {
	const tx = {
		$queryRaw: jest
			.fn()
			.mockResolvedValue([{ pg_advisory_xact_lock: '' }]),
		user: {
			findUnique: jest.fn().mockResolvedValue(target()),
			update: jest.fn().mockResolvedValue(target()),
			findMany: jest.fn().mockResolvedValue([])
		},
		avatarCleanupJob: {
			deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
			createMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		...overrides
	};
	const prisma = {
		user: {
			findUnique: jest.fn().mockResolvedValue(target())
		},
		avatarCleanupJob: {
			create: jest.fn().mockResolvedValue({ id: 'staging-1' })
		},
		$transaction: jest.fn(
			async (callback: (value: typeof tx) => unknown) => callback(tx)
		)
	};
	const events = {
		emitUserChanged: jest.fn().mockResolvedValue(undefined),
		emitAudit: jest.fn().mockResolvedValue(undefined)
	};
	const storage = {
		prepare: jest.fn().mockResolvedValue({
			objectKey: NEW_KEY,
			ownerFingerprint:
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			publicUrl: 'https://cdn.example.test/new.webp',
			body: Buffer.from('normalized')
		}),
		upload: jest.fn().mockResolvedValue(undefined)
	};
	const ownership = {
		assertActive: jest.fn().mockResolvedValue(undefined)
	};
	const service = new AvatarService(
		prisma as any,
		events as any,
		storage as any,
		ownership as any
	);
	return { service, prisma, tx, events, storage, ownership };
}

describe('AvatarService durable ownership transaction', () => {
	it('blocks upload and delete before avatar ownership is ACTIVE', async () => {
		const value = setup();
		value.ownership.assertActive.mockRejectedValue(
			new ServiceUnavailableException(
				'Avatar media ownership is not active'
			)
		);
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toThrow('Avatar media ownership is not active');
		await expect(
			value.service.deleteSelf(USER_ID, request())
		).rejects.toThrow('Avatar media ownership is not active');
		expect(value.prisma.user.findUnique).not.toHaveBeenCalled();
		expect(value.prisma.avatarCleanupJob.create).not.toHaveBeenCalled();
		expect(value.storage.prepare).not.toHaveBeenCalled();
		expect(value.storage.upload).not.toHaveBeenCalled();
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('creates STAGING before Put, consumes it in Serializable tx and retires the old key', async () => {
		const value = setup();
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).resolves.toEqual({
			avatarPath: 'https://cdn.example.test/new.webp'
		});

		expect(
			value.prisma.avatarCleanupJob.create.mock.invocationCallOrder[0]
		).toBeLessThan(value.storage.upload.mock.invocationCallOrder[0]);
		expect(value.prisma.avatarCleanupJob.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				objectKey: NEW_KEY,
				kind: AvatarCleanupKind.STAGING,
				status: AvatarCleanupStatus.PENDING,
				availableAt: expect.any(Date)
			})
		});
		expect(value.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' })
		);
		expect(value.tx.avatarCleanupJob.deleteMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'staging-1',
				objectKey: NEW_KEY,
				status: AvatarCleanupStatus.PENDING,
				leaseToken: null
			})
		});
		expect(value.tx.avatarCleanupJob.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({
					objectKey: OLD_KEY,
					kind: AvatarCleanupKind.RETIRED
				})
			],
			skipDuplicates: true
		});
		expect(value.tx.user.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: {
				avatarPath: 'https://cdn.example.test/new.webp',
				avatarObjectKey: NEW_KEY
			}
		});
		expect(value.events.emitUserChanged).toHaveBeenCalled();
		expect(value.events.emitAudit).not.toHaveBeenCalled();
	});

	it('retries a commit-time P2034 with the same staging and without another S3 Put', async () => {
		const value = setup();
		value.prisma.$transaction.mockImplementationOnce(
			async (callback: (transaction: typeof value.tx) => unknown) => {
				await callback(value.tx);
				throw transactionConflict();
			}
		);

		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).resolves.toEqual({
			avatarPath: 'https://cdn.example.test/new.webp'
		});
		expect(value.prisma.user.findUnique).toHaveBeenCalledTimes(1);
		expect(value.storage.prepare).toHaveBeenCalledTimes(1);
		expect(value.prisma.avatarCleanupJob.create).toHaveBeenCalledTimes(1);
		expect(value.storage.upload).toHaveBeenCalledTimes(1);
		expect(value.prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(value.tx.avatarCleanupJob.deleteMany).toHaveBeenCalledTimes(2);
		for (const call of value.tx.avatarCleanupJob.deleteMany.mock.calls) {
			expect(call[0]).toEqual({
				where: expect.objectContaining({
					id: 'staging-1',
					objectKey: NEW_KEY
				})
			});
		}
	});

	it('bounds persistent P2034 retries at three and returns a recoverable 503', async () => {
		const value = setup();
		value.prisma.$transaction.mockRejectedValue(transactionConflict());

		const operation = value.service.uploadSelf(
			USER_ID,
			{} as Express.Multer.File,
			request()
		);
		await expect(operation).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		await expect(operation).rejects.toThrow(
			'Avatar update is temporarily unavailable'
		);
		expect(value.prisma.$transaction).toHaveBeenCalledTimes(3);
		expect(value.storage.prepare).toHaveBeenCalledTimes(1);
		expect(value.prisma.avatarCleanupJob.create).toHaveBeenCalledTimes(1);
		expect(value.storage.upload).toHaveBeenCalledTimes(1);
		expect(value.tx.avatarCleanupJob.deleteMany).not.toHaveBeenCalled();
	});

	it('retries a delete P2034 in a fresh Serializable transaction', async () => {
		const value = setup();
		value.prisma.$transaction.mockImplementationOnce(
			async (callback: (transaction: typeof value.tx) => unknown) => {
				await callback(value.tx);
				throw transactionConflict();
			}
		);

		await expect(
			value.service.deleteSelf(USER_ID, request())
		).resolves.toEqual({ avatarPath: null });
		expect(value.prisma.$transaction).toHaveBeenCalledTimes(2);
		expect(value.tx.user.update).toHaveBeenCalledTimes(2);
		expect(value.storage.prepare).not.toHaveBeenCalled();
		expect(value.prisma.avatarCleanupJob.create).not.toHaveBeenCalled();
		expect(value.storage.upload).not.toHaveBeenCalled();
	});

	it('keeps the durable STAGING row when S3 Put fails', async () => {
		const value = setup();
		value.storage.upload.mockRejectedValueOnce(new Error('storage down'));
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(value.prisma.avatarCleanupJob.create).toHaveBeenCalledTimes(1);
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('does not retry staging 409 or another non-P2034 error', async () => {
		const value = setup();
		value.tx.avatarCleanupJob.deleteMany.mockResolvedValueOnce({
			count: 0
		});
		await expect(
			value.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(value.tx.user.update).not.toHaveBeenCalled();
		expect(value.events.emitUserChanged).not.toHaveBeenCalled();
		expect(value.prisma.avatarCleanupJob.create).toHaveBeenCalledTimes(1);
		expect(value.prisma.$transaction).toHaveBeenCalledTimes(1);

		const other = setup();
		other.prisma.$transaction.mockRejectedValueOnce(
			new Error('not retryable')
		);
		await expect(
			other.service.uploadSelf(
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toThrow('not retryable');
		expect(other.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it('never derives a cleanup key from an OAuth or legacy URL', async () => {
		const value = setup();
		value.tx.user.findUnique.mockResolvedValueOnce(
			target({
				avatarPath: 'https://oauth.example.test/avatar?id=1',
				avatarObjectKey: null
			})
		);
		await expect(
			value.service.deleteSelf(USER_ID, request())
		).resolves.toEqual({ avatarPath: null });
		expect(value.tx.avatarCleanupJob.createMany).not.toHaveBeenCalled();
		expect(value.tx.user.update).toHaveBeenCalledWith({
			where: { id: USER_ID },
			data: { avatarPath: null, avatarObjectKey: null }
		});
	});

	it('enforces DEV target protection and emits admin USER_UPDATE audit', async () => {
		const denied = setup();
		denied.prisma.user.findUnique.mockResolvedValueOnce(
			target({ rights: [Role.USER, Role.DEV] })
		);
		await expect(
			denied.service.uploadAdmin(
				'admin-1',
				[Role.ADMIN],
				USER_ID,
				{} as Express.Multer.File,
				request()
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(denied.prisma.avatarCleanupJob.create).not.toHaveBeenCalled();
		expect(denied.storage.prepare).not.toHaveBeenCalled();
		expect(denied.storage.upload).not.toHaveBeenCalled();
		expect(denied.tx.user.update).not.toHaveBeenCalled();

		const allowed = setup();
		await allowed.service.uploadAdmin(
			'dev-1',
			[Role.ADMIN, Role.DEV],
			USER_ID,
			{} as Express.Multer.File,
			request()
		);
		expect(allowed.events.emitAudit).toHaveBeenCalledWith(
			allowed.tx,
			expect.objectContaining({
				actorId: 'dev-1',
				action: 'USER_UPDATE',
				targetUserId: USER_ID,
				metadata: {
					changedFields: ['avatarPath'],
					passwordChanged: false
				}
			})
		);
	});

	it.each([
		['missing', null],
		['deleted', target({ deletedAt: new Date() })]
	])(
		'rejects a %s target before normalization, staging or S3 Put',
		async (_case, initialTarget) => {
			const value = setup();
			value.prisma.user.findUnique.mockResolvedValueOnce(initialTarget);
			await expect(
				value.service.uploadAdmin(
					'dev-1',
					[Role.ADMIN, Role.DEV],
					USER_ID,
					{} as Express.Multer.File,
					request()
				)
			).rejects.toThrow();
			expect(value.storage.prepare).not.toHaveBeenCalled();
			expect(value.prisma.avatarCleanupJob.create).not.toHaveBeenCalled();
			expect(value.storage.upload).not.toHaveBeenCalled();
			expect(value.prisma.$transaction).not.toHaveBeenCalled();
		}
	);
});
