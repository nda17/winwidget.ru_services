import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import {
	DatabaseRestoreEventIdentity,
	DatabaseRestoreLease,
	DatabaseRestoreStateService
} from './database-restore-state.service';

const event = (): DatabaseRestoreEventIdentity => ({
	eventId: randomUUID(),
	jobId: randomUUID(),
	target: 'reporting'
});

const lease = (
	phase: DatabaseRestoreJobPhase = DatabaseRestoreJobPhase.PREPARING
): DatabaseRestoreLease => ({
	event: event(),
	leaseToken: randomUUID(),
	leaseExpiresAt: new Date(Date.now() + 60_000),
	phase
});

const transactionPrisma = (updateMany: jest.Mock) => {
	const transaction = { databaseRestoreJob: { updateMany } };
	return {
		transaction,
		prisma: {
			databaseRestoreJob: {
				updateMany,
				findFirstOrThrow: jest.fn(),
				findUnique: jest.fn(),
				findFirst: jest.fn(),
				findMany: jest.fn()
			},
			$transaction: jest.fn(
				(callback: (value: typeof transaction) => unknown) =>
					callback(transaction)
			)
		}
	};
};

describe('DatabaseRestoreStateService', () => {
	it('claims with event fencing, a lease, and an incremented attempt', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const { prisma } = transactionPrisma(updateMany);
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);
		const value = event();

		await expect(service.claim(value)).resolves.toEqual({
			state: 'claimed',
			lease: expect.objectContaining({
				event: value,
				leaseToken: expect.any(String),
				phase: DatabaseRestoreJobPhase.PREPARING
			})
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: value.jobId,
				target: value.target,
				eventId: value.eventId,
				status: DatabaseRestoreJobStatus.QUEUED
			},
			data: expect.objectContaining({
				status: DatabaseRestoreJobStatus.PROCESSING,
				phase: DatabaseRestoreJobPhase.PREPARING,
				leaseOwner: expect.any(String),
				leaseToken: expect.any(String),
				leaseExpiresAt: expect.any(Date),
				attempts: { increment: 1 }
			})
		});
	});

	it('maps the singleton PROCESSING unique conflict to a busy claim', async () => {
		const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
		const updateMany = jest.fn().mockRejectedValue(conflict);
		const { prisma } = transactionPrisma(updateMany);
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);

		await expect(service.claim(event())).resolves.toEqual({
			state: 'busy'
		});
	});

	it('persists every checkpoint by exact phase and lease before advancing memory state', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const { prisma } = transactionPrisma(updateMany);
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);
		const value = lease();

		await service.checkpoint(value, {
			phase: 'SAFETY_READY',
			safetyBackupFileName: `${value.event.jobId}.dump.safety`,
			safetyBackupSha256: 'a'.repeat(64)
		});
		expect(value.phase).toBe(DatabaseRestoreJobPhase.SAFETY_READY);
		expect(updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: value.event.jobId,
				eventId: value.event.eventId,
				status: DatabaseRestoreJobStatus.PROCESSING,
				phase: DatabaseRestoreJobPhase.PREPARING,
				leaseToken: value.leaseToken,
				leaseExpiresAt: { gt: expect.any(Date) }
			}),
			data: expect.objectContaining({
				phase: DatabaseRestoreJobPhase.SAFETY_READY,
				safetyBackupFileName: `${value.event.jobId}.dump.safety`,
				safetyBackupSha256: 'a'.repeat(64)
			})
		});
	});

	it('does not advance a checkpoint when its CAS loses ownership', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 0 });
		const { prisma } = transactionPrisma(updateMany);
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);
		const value = lease();

		await expect(
			service.checkpoint(value, {
				phase: 'SAFETY_READY',
				safetyBackupFileName: 'job.dump.safety',
				safetyBackupSha256: 'b'.repeat(64)
			})
		).rejects.toThrow('checkpoint could not be persisted');
		expect(value.phase).toBe(DatabaseRestoreJobPhase.PREPARING);
	});

	it.each([
		[DatabaseRestoreJobPhase.PREPARING, DatabaseRestoreJobStatus.FAILED],
		[
			DatabaseRestoreJobPhase.SAFETY_READY,
			DatabaseRestoreJobStatus.FAILED
		],
		[
			DatabaseRestoreJobPhase.MUTATING,
			DatabaseRestoreJobStatus.RECOVERY_REQUIRED
		],
		[
			DatabaseRestoreJobPhase.VERIFIED,
			DatabaseRestoreJobStatus.RECOVERY_REQUIRED
		]
	])(
		'atomically maps %s failure to %s with its alert',
		async (phase, expectedStatus) => {
			const updateMany = jest.fn().mockResolvedValue({ count: 1 });
			const { prisma, transaction } = transactionPrisma(updateMany);
			const alerts = {
				recordInTransaction: jest.fn().mockResolvedValue({})
			};
			const service = new DatabaseRestoreStateService(
				prisma as never,
				alerts as never
			);
			const value = lease(phase);

			await expect(
				service.fail(value, new Error('restore failed\r\nnow'))
			).resolves.toBe(expectedStatus);
			expect(updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						phase,
						leaseToken: value.leaseToken
					}),
					data: expect.objectContaining({
						status: expectedStatus,
						lastError: 'restore failed now',
						leaseToken: null
					})
				})
			);
			expect(alerts.recordInTransaction).toHaveBeenCalledWith(
				transaction,
				expect.objectContaining({
					referenceId: value.event.jobId,
					severity: 'HIGH'
				})
			);
		}
	);

	it('does not alert or claim terminal responsibility when the CAS count is zero', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 0 });
		const { prisma } = transactionPrisma(updateMany);
		const alerts = { recordInTransaction: jest.fn() };
		const service = new DatabaseRestoreStateService(
			prisma as never,
			alerts as never
		);

		await expect(service.fail(lease(), new Error('failed'))).resolves.toBe(
			null
		);
		expect(alerts.recordInTransaction).not.toHaveBeenCalled();
	});

	it('persists success and alert resolution in the same transaction', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const { prisma, transaction } = transactionPrisma(updateMany);
		const alerts = {
			resolveInTransaction: jest.fn().mockResolvedValue({ count: 1 })
		};
		const service = new DatabaseRestoreStateService(
			prisma as never,
			alerts as never
		);
		const value = lease(DatabaseRestoreJobPhase.VERIFIED);

		await expect(
			service.succeed(value, { target: 'reporting' })
		).resolves.toBe(true);
		expect(alerts.resolveInTransaction).toHaveBeenCalledWith(
			transaction,
			'database-restore:reporting'
		);
	});

	it.each([
		[DatabaseRestoreJobPhase.PREPARING, DatabaseRestoreJobStatus.FAILED],
		[
			DatabaseRestoreJobPhase.MUTATING,
			DatabaseRestoreJobStatus.RECOVERY_REQUIRED
		],
		[null, DatabaseRestoreJobStatus.RECOVERY_REQUIRED]
	])(
		'recovers an expired %s lease to %s with an atomic alert',
		async (phase, expectedStatus) => {
			const updateMany = jest.fn().mockResolvedValue({ count: 1 });
			const { prisma, transaction } = transactionPrisma(updateMany);
			const alerts = {
				recordInTransaction: jest.fn().mockResolvedValue({})
			};
			const service = new DatabaseRestoreStateService(
				prisma as never,
				alerts as never
			);
			const job = {
				id: randomUUID(),
				target: 'reporting',
				status: DatabaseRestoreJobStatus.PROCESSING,
				phase,
				leaseToken: randomUUID(),
				leaseExpiresAt: new Date(Date.now() - 1)
			};

			await expect(service.recoverExpiredJob(job)).resolves.toEqual({
				id: job.id,
				target: job.target,
				status: expectedStatus,
				phase
			});
			expect(alerts.recordInTransaction).toHaveBeenCalledWith(
				transaction,
				expect.objectContaining({ referenceId: job.id })
			);
		}
	);
});
