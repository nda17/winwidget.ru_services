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
	target: 'reporting',
	expectedServicesSha: 'a'.repeat(40),
	migrationManifestSha: 'b'.repeat(64)
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
	const executionLeaseUpdateMany = jest
		.fn()
		.mockResolvedValue({ count: 1 });
	const transaction = {
		databaseRestoreJob: { updateMany },
		databaseRestoreExecutionLease: {
			updateMany: executionLeaseUpdateMany
		},
		databaseRestoreTerminalReceipt: {
			findUnique: jest.fn().mockResolvedValue({ id: randomUUID() })
		},
		databaseRestoreReleaseAuthorization: {
			findFirst: jest.fn().mockResolvedValue({
				payloadSha256: 'f'.repeat(64)
			})
		}
	};
	return {
		transaction,
		executionLeaseUpdateMany,
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
	it('never shortens an exact lease when an older renewal finishes later', async () => {
		const value = lease();
		const laterExpiry = new Date(Date.now() + 120_000);
		const executionLeaseUpdateMany = jest
			.fn()
			.mockResolvedValue({ count: 0 });
		const jobUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
		const transaction = {
			databaseRestoreExecutionLease: {
				updateMany: executionLeaseUpdateMany,
				findFirst: jest.fn().mockResolvedValue({
					leaseExpiresAt: laterExpiry
				})
			},
			databaseRestoreJob: {
				updateMany: jobUpdateMany,
				findFirst: jest.fn().mockResolvedValue({
					leaseExpiresAt: laterExpiry
				})
			}
		};
		const service = new DatabaseRestoreStateService(
			{
				$transaction: jest.fn(
					(callback: (client: typeof transaction) => unknown) =>
						callback(transaction)
				)
			} as never,
			{} as never
		);

		await expect(service.renew(value)).resolves.toBe(true);
		expect(value.leaseExpiresAt).toEqual(laterExpiry);
		expect(executionLeaseUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					leaseExpiresAt: expect.objectContaining({
						lt: expect.any(Date)
					})
				})
			})
		);
		expect(jobUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					leaseExpiresAt: expect.objectContaining({
						lt: expect.any(Date)
					})
				})
			})
		);
	});

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
				expectedServicesSha: value.expectedServicesSha,
				migrationManifestSha: value.migrationManifestSha,
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

	it('does not steal an expired singleton before the recovery sweep re-fences it', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const { prisma, executionLeaseUpdateMany } =
			transactionPrisma(updateMany);
		executionLeaseUpdateMany.mockResolvedValue({ count: 0 });
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);

		await expect(service.claim(event())).resolves.toEqual({
			state: 'busy'
		});
		expect(executionLeaseUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'singleton', leaseExpiresAt: null }
			})
		);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it('persists every checkpoint by exact phase and lease before advancing memory state', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const { prisma } = transactionPrisma(updateMany);
		const service = new DatabaseRestoreStateService(
			prisma as never,
			{} as never
		);
		const value = lease(DatabaseRestoreJobPhase.FENCED);

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
				phase: DatabaseRestoreJobPhase.FENCED,
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
		const value = lease(DatabaseRestoreJobPhase.FENCED);

		await expect(
			service.checkpoint(value, {
				phase: 'SAFETY_READY',
				safetyBackupFileName: 'job.dump.safety',
				safetyBackupSha256: 'b'.repeat(64)
			})
		).rejects.toThrow('checkpoint could not be persisted');
		expect(value.phase).toBe(DatabaseRestoreJobPhase.FENCED);
	});

	it.each([
		[DatabaseRestoreJobPhase.PREPARING, DatabaseRestoreJobStatus.FAILED],
		[
			DatabaseRestoreJobPhase.SAFETY_READY,
			DatabaseRestoreJobStatus.RECOVERY_REQUIRED
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
			alerts as never,
			{} as never,
			{
				assertRestore: jest.fn().mockResolvedValue({
					payloadSha256: 'f'.repeat(64)
				})
			} as never
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
			alerts as never,
			{} as never,
			{
				assertRestore: jest.fn().mockResolvedValue({
					payloadSha256: 'f'.repeat(64)
				})
			} as never
		);
		const value = lease(DatabaseRestoreJobPhase.UNFENCED);

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
		[
			DatabaseRestoreJobPhase.UNFENCED,
			DatabaseRestoreJobStatus.RECOVERY_REQUIRED
		],
		[null, DatabaseRestoreJobStatus.RECOVERY_REQUIRED]
	])(
		'reserves and recovers an expired %s lease to %s with an atomic alert',
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
				eventId: randomUUID(),
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64),
				status: DatabaseRestoreJobStatus.PROCESSING,
				phase,
				leaseToken: randomUUID(),
				leaseExpiresAt: new Date(Date.now() - 1)
			};

			const reserved = await service.reserveExpiredJob(job);
			expect(reserved).toEqual({
				...job,
				leaseToken: expect.any(String),
				leaseExpiresAt: expect.any(Date)
			});
			expect(reserved?.leaseToken).not.toBe(job.leaseToken);

			await expect(
				service.recoverReservedExpiredJob(reserved!)
			).resolves.toEqual({
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

	it('atomically closes the one-shot permit and creates a signed immutable terminal receipt', async () => {
		const previousKey =
			process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64;
		const previousKeyId = process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID;
		process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64 = Buffer.alloc(
			32,
			7
		).toString('base64');
		process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID =
			'operations-restore-v1';
		const jobId = randomUUID();
		const permitId = randomUUID();
		const completedAt = new Date('2026-08-30T18:00:00.000Z');
		const permitCreatedAt = new Date('2026-08-30T17:50:00.000Z');
		const permitApprovedAt = new Date('2026-08-30T17:51:00.000Z');
		const permitConsumedAt = new Date('2026-08-30T17:52:00.000Z');
		const permitExpiresAt = new Date('2026-08-30T18:01:00.000Z');
		const createReceipt = jest.fn().mockResolvedValue({});
		const closePermit = jest.fn().mockResolvedValue({ count: 1 });
		const transaction = {
			databaseRestoreTerminalReceipt: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: createReceipt
			},
			databaseRestoreJob: {
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					id: jobId,
					permitId,
					requestedById: 'requester',
					permit: {
						id: permitId,
						jobId,
						status: 'CONSUMED',
						requestedById: 'requester',
						approvedById: 'approver',
						createdAt: permitCreatedAt,
						approvedAt: permitApprovedAt,
						expiresAt: permitExpiresAt,
						consumedAt: permitConsumedAt
					},
					target: 'reporting',
					status: DatabaseRestoreJobStatus.SUCCEEDED,
					phase: DatabaseRestoreJobPhase.UNFENCED,
					writerFenceRoles: [
						'winwidget_reporting_runtime',
						'winwidget_reporting_migration',
						'winwidget_reporting_backup'
					],
					writerFenceRequestedAt: completedAt,
					writerFenceAppliedAt: completedAt,
					writerFenceReleasedAt: completedAt,
					writerFenceEvidenceSha256: 'e'.repeat(64),
					writerFenceReleaseEvidenceSha256: 'f'.repeat(64),
					sourceSha256: 'a'.repeat(64),
					safetyBackupSha256: 'b'.repeat(64),
					expectedServicesSha: 'c'.repeat(40),
					migrationManifestSha: 'd'.repeat(64),
					result: { verified: true },
					lastError: null,
					finishedAt: completedAt
				})
			},
			databaseRestorePermit: { updateMany: closePermit },
			databaseRestoreReleaseAuthorization: {
				findFirst: jest.fn().mockResolvedValue({
					payloadSha256: 'g'.repeat(64)
				})
			}
		};
		const service = new DatabaseRestoreStateService(
			{} as never,
			{} as never
		);

		try {
			await service.createTerminalReceiptInTransaction(
				transaction as never,
				jobId
			);
			expect(closePermit).toHaveBeenCalledWith({
				where: expect.objectContaining({
					id: permitId,
					jobId,
					status: 'CONSUMED'
				}),
				data: {
					status: 'CLOSED',
					closedAt: completedAt,
					closeReason: 'TERMINAL_SUCCEEDED'
				}
			});
			expect(createReceipt).toHaveBeenCalledWith({
				data: expect.objectContaining({
					jobId,
					permitId,
					permitRequestedById: 'requester',
					permitApprovedById: 'approver',
					permitCreatedAt,
					permitApprovedAt,
					permitExpiresAt,
					permitConsumedAt,
					terminalStatus: DatabaseRestoreJobStatus.SUCCEEDED,
					payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
					signatureHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
					signatureKeyId: 'operations-restore-v1'
				})
			});
		} finally {
			if (previousKey === undefined) {
				delete process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64;
			} else {
				process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64 = previousKey;
			}
			if (previousKeyId === undefined) {
				delete process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID;
			} else {
				process.env.DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID = previousKeyId;
			}
		}
	});
});
