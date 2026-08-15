import {
	AvatarCleanupKind,
	AvatarCleanupStatus
} from '@prisma/identity-client';
import {
	AvatarCleanupWorkerService,
	retryDelay
} from './avatar-cleanup-worker.service';
import {
	UnsafeAvatarObjectKeyError,
	UnsafeAvatarObjectVersionStateError
} from './avatar-storage.service';

const JOB = {
	id: '00000000-0000-4000-8000-000000000001',
	objectKey:
		'identity/avatars/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/00000000-0000-4000-8000-000000000002.webp',
	ownerFingerprint:
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	kind: AvatarCleanupKind.STAGING,
	attempts: 1,
	leaseToken: '00000000-0000-4000-8000-000000000003'
};

function setup() {
	const prisma = {
		$queryRaw: jest.fn().mockResolvedValue([JOB]),
		user: { count: jest.fn().mockResolvedValue(0) },
		avatarCleanupJob: {
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			findFirst: jest.fn().mockResolvedValue(null)
		}
	};
	const runtime = {
		workerEnabled: true,
		avatarCleanupLeaseMs: 60_000,
		avatarCleanupBatchSize: 10,
		avatarCleanupPollIntervalMs: 1_000
	};
	const ownership = { isActive: jest.fn().mockResolvedValue(true) };
	const storage = {
		delete: jest
			.fn()
			.mockImplementation(
				async (
					_objectKey: string,
					_ownerFingerprint: string,
					renewLease: () => Promise<void>
				) => renewLease()
			)
	};
	const service = new AvatarCleanupWorkerService(
		prisma as any,
		runtime as any,
		ownership as any,
		storage as any
	);
	return { service, prisma, runtime, ownership, storage };
}

describe('AvatarCleanupWorkerService durable cleanup', () => {
	it('claims with SKIP LOCKED/CAS lease and marks deletion delivered by lease token', async () => {
		const value = setup();
		await expect(value.service.runOnce(new Date())).resolves.toBe(1);
		const query = value.prisma.$queryRaw.mock.calls[0][0];
		expect(query.strings.join(' ')).toContain('FOR UPDATE SKIP LOCKED');
		expect(query.strings.join(' ')).toContain('"lease_token"');
		expect(query.strings.join(' ')).toContain('"lease_expires_at" <=');
		expect(value.storage.delete).toHaveBeenCalledWith(
			JOB.objectKey,
			JOB.ownerFingerprint,
			expect.any(Function)
		);
		expect(
			value.prisma.avatarCleanupJob.updateMany
		).toHaveBeenNthCalledWith(1, {
			where: {
				id: JOB.id,
				status: AvatarCleanupStatus.PROCESSING,
				leaseToken: JOB.leaseToken,
				leaseExpiresAt: { gt: expect.any(Date) }
			},
			data: {
				leaseExpiresAt: expect.any(Date),
				updatedAt: expect.any(Date)
			}
		});
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledWith({
			where: {
				id: JOB.id,
				status: AvatarCleanupStatus.PROCESSING,
				leaseToken: JOB.leaseToken
			},
			data: expect.objectContaining({
				status: AvatarCleanupStatus.DELIVERED,
				deliveredAt: expect.any(Date),
				leaseToken: null,
				leaseExpiresAt: null
			})
		});
	});

	it('stops external cleanup immediately when its renewable CAS lease is lost', async () => {
		const value = setup();
		value.prisma.avatarCleanupJob.updateMany.mockResolvedValueOnce({
			count: 0
		});

		await expect(value.service.runOnce(new Date())).resolves.toBe(1);

		expect(value.storage.delete).toHaveBeenCalledTimes(1);
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledTimes(
			1
		);
	});

	it('blocks a still-referenced object without issuing S3 Delete', async () => {
		const value = setup();
		value.prisma.user.count.mockResolvedValueOnce(1);
		await value.service.runOnce(new Date());
		expect(value.storage.delete).not.toHaveBeenCalled();
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ leaseToken: JOB.leaseToken }),
			data: expect.objectContaining({
				status: AvatarCleanupStatus.BLOCKED,
				lastError: expect.stringContaining('still referenced')
			})
		});
	});

	it('blocks unsafe keys and never retries them as an arbitrary delete', async () => {
		const value = setup();
		value.storage.delete.mockRejectedValueOnce(
			new UnsafeAvatarObjectKeyError()
		);
		await value.service.runOnce(new Date());
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ leaseToken: JOB.leaseToken }),
			data: expect.objectContaining({
				status: AvatarCleanupStatus.BLOCKED,
				lastError: expect.stringContaining('outside owned prefixes')
			})
		});
	});

	it('blocks an unsafe or unbounded object-version state', async () => {
		const value = setup();
		value.storage.delete.mockRejectedValueOnce(
			new UnsafeAvatarObjectVersionStateError()
		);
		await value.service.runOnce(new Date());
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ leaseToken: JOB.leaseToken }),
			data: expect.objectContaining({
				status: AvatarCleanupStatus.BLOCKED,
				lastError: expect.stringContaining('version state')
			})
		});
	});

	it('retries transient S3 failure indefinitely with bounded backoff', async () => {
		const value = setup();
		const now = new Date('2026-08-15T00:00:00.000Z');
		value.storage.delete.mockRejectedValueOnce(new Error('temporary'));
		await value.service.runOnce(now);
		expect(value.prisma.avatarCleanupJob.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ leaseToken: JOB.leaseToken }),
			data: expect.objectContaining({
				status: AvatarCleanupStatus.PENDING,
				availableAt: new Date(now.getTime() + 5_000),
				leaseToken: null,
				leaseExpiresAt: null
			})
		});
		expect(retryDelay(100)).toBe(60 * 60_000);
	});

	it('keeps worker readiness degraded until a persisted failed job recovers', async () => {
		const value = setup();
		value.storage.delete
			.mockRejectedValueOnce(new Error('temporary'))
			.mockResolvedValueOnce(undefined);
		value.prisma.avatarCleanupJob.findFirst
			.mockResolvedValueOnce({ status: AvatarCleanupStatus.PENDING })
			.mockResolvedValueOnce(null);
		try {
			await (value.service as any).tick();
			expect(value.service.isReady()).toBe(false);
			expect(value.service.health()).toMatchObject({
				ready: false,
				degradedStatus: AvatarCleanupStatus.PENDING
			});
			await (value.service as any).tick();
			expect(value.service.isReady()).toBe(true);
		} finally {
			value.service.onApplicationShutdown();
		}
	});
});
