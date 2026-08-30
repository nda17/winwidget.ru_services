import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreService } from './database-restore.service';
import { DatabaseRestoreWorkerService } from './database-restore-worker.service';

const message = (overrides: Record<string, unknown> = {}) => {
	const eventId = randomUUID();
	const jobId = randomUUID();
	const payload = {
		schemaVersion: 1,
		eventId,
		jobId,
		target: 'reporting',
		...overrides
	};
	return {
		content: Buffer.from(JSON.stringify(payload)),
		properties: {
			type: 'operations.database-restore.requested.v1',
			messageId: payload.eventId
		}
	};
};

const restoreConfig = (values: Record<string, string>) =>
	({ get: (key: string) => values[key] }) as ConfigService;

const worker = (dependencies: {
	control?: unknown;
	state?: unknown;
	recovery?: unknown;
	executor?: unknown;
	cleanup?: unknown;
	runtime?: unknown;
	rabbit?: unknown;
}) =>
	new DatabaseRestoreWorkerService(
		(dependencies.runtime ?? {}) as never,
		(dependencies.rabbit ?? {}) as never,
		(dependencies.control ?? {}) as never,
		(dependencies.state ?? {}) as never,
		(dependencies.recovery ?? {}) as never,
		(dependencies.executor ?? {}) as never,
		(dependencies.cleanup ?? {}) as never
	);

describe('DatabaseRestoreService contract', () => {
	it('exposes only the currently approved non-Operations, non-Billing targets', () => {
		const service = new DatabaseRestoreService(
			restoreConfig({ DATABASE_RESTORE_ENABLED: 'false' }),
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		expect(service.getSettings()).toEqual(
			expect.objectContaining({
				enabled: false,
				approved: null,
				allowedFileExtension: '.dump',
				maxFileSizeBytes: 49 * 1024 * 1024,
				targets: expect.arrayContaining([
					expect.objectContaining({ id: 'reporting' })
				])
			})
		);
		expect(service.getSettings().targets.map(item => item.id)).toEqual([
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'identity',
			'platform',
			'support'
		]);
	});

	it('stores the outbox event id on the durable job in the same transaction', async () => {
		const storage = await mkdtemp(join(tmpdir(), 'operations-restore-'));
		const requestId = randomUUID();
		const now = new Date('2026-08-30T08:00:00.000Z');
		const create = jest.fn().mockImplementation(({ data }) => ({
			...data,
			status: DatabaseRestoreJobStatus.QUEUED,
			attempts: 0,
			result: null,
			lastError: null,
			startedAt: null,
			finishedAt: null,
			createdAt: now,
			updatedAt: now
		}));
		const transaction = { databaseRestoreJob: { create } };
		const prisma = {
			databaseRestoreJob: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const audit = { recordInTransaction: jest.fn().mockResolvedValue({}) };
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STORAGE_DIR: storage
			}),
			prisma as never,
			outbox as never,
			audit as never,
			{} as never
		);

		try {
			await expect(
				service.enqueue({
					target: 'reporting',
					file: {
						originalname: 'reporting.dump',
						size: 6,
						buffer: Buffer.from('PGDMP1')
					},
					confirmation: 'ВОССТАНОВИТЬ REPORTING',
					requestId,
					actorId: 'admin-42',
					ip: null,
					userAgent: null
				})
			).resolves.toEqual(
				expect.objectContaining({ jobId: requestId, attempt: 0 })
			);
			const eventId = create.mock.calls[0][0].data.eventId;
			expect(eventId).toEqual(expect.any(String));
			expect(outbox.enqueue).toHaveBeenCalledWith(
				transaction,
				expect.objectContaining({
					eventId,
					aggregateId: requestId,
					payload: expect.objectContaining({
						eventId,
						jobId: requestId,
						target: 'reporting'
					})
				})
			);
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it('exposes recovery-required state and the durable attempt count', async () => {
		const now = new Date('2026-08-30T08:00:00.000Z');
		const service = new DatabaseRestoreService(
			restoreConfig({}),
			{
				databaseRestoreJob: {
					findUnique: jest.fn().mockResolvedValue({
						id: randomUUID(),
						target: 'reporting',
						status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
						attempts: 2,
						sourceFileName: 'reporting.dump',
						sourceSha256: 'a'.repeat(64),
						sourceSize: 10n,
						result: null,
						lastError: 'manual recovery required',
						startedAt: now,
						finishedAt: now,
						createdAt: now
					})
				}
			} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await expect(service.getJob(randomUUID())).resolves.toEqual(
			expect.objectContaining({
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				attempt: 2,
				error: {
					code: 'RESTORE_RECOVERY_REQUIRED',
					message: 'manual recovery required'
				}
			})
		);
	});

	it('returns 409 and removes the upload when the target fence conflicts', async () => {
		const storage = await mkdtemp(join(tmpdir(), 'operations-restore-'));
		const requestId = randomUUID();
		const conflict = Object.assign(new Error('unique target fence'), {
			code: 'P2002'
		});
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STORAGE_DIR: storage
			}),
			{
				databaseRestoreJob: {
					findUnique: jest.fn().mockResolvedValue(null)
				},
				$transaction: jest.fn().mockRejectedValue(conflict)
			} as never,
			{} as never,
			{} as never,
			{} as never
		);

		try {
			await expect(
				service.enqueue({
					target: 'reporting',
					file: {
						originalname: 'reporting.dump',
						size: 6,
						buffer: Buffer.from('PGDMP1')
					},
					confirmation: 'ВОССТАНОВИТЬ REPORTING',
					requestId,
					actorId: 'admin-42',
					ip: null,
					userAgent: null
				})
			).rejects.toBeInstanceOf(ConflictException);
			await expect(
				access(join(storage, `${requestId}.dump`))
			).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});
});

describe('DatabaseRestoreWorkerService orchestration', () => {
	it('recovers expired state and pending cleanup before consuming', async () => {
		const calls: string[] = [];
		const restoreWorker = worker({
			runtime: { restoreWorkerEnabled: true },
			rabbit: {
				consumeDatabaseRestoreJobs: jest.fn(async () => {
					calls.push('consume');
				})
			},
			recovery: {
				recoverExpired: jest.fn(async () => {
					calls.push('recover');
					return [];
				})
			},
			cleanup: {
				pending: jest.fn(async () => {
					calls.push('pending-cleanup');
					return [];
				})
			}
		});

		await restoreWorker.onModuleInit();
		expect(calls).toEqual(['recover', 'pending-cleanup', 'consume']);
		expect(restoreWorker.isReady()).toBe(true);
		await restoreWorker.onApplicationShutdown();
	});

	it.each(['operations', 'billing'])(
		'rejects the excluded %s target before any source access',
		async target => {
			const resolveSourcePath = jest.fn();
			const restoreWorker = worker({ control: { resolveSourcePath } });

			await expect(
				restoreWorker.handleMessage(message({ target }) as never)
			).resolves.toBe('reject');
			expect(resolveSourcePath).not.toHaveBeenCalled();
		}
	);

	it('persists VERIFIED success before cleanup and acknowledges', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: { eventId, jobId, target: 'reporting' as const },
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.PREPARING
		};
		const calls: string[] = [];
		const state = {
			claim: jest.fn().mockResolvedValue({ state: 'claimed', lease }),
			loadClaimedJob: jest
				.fn()
				.mockResolvedValue({ id: jobId, sourceSha256: 'a'.repeat(64) }),
			checkpoint: jest.fn(async (_lease, checkpoint) => {
				lease.phase = checkpoint.phase;
				calls.push(`checkpoint:${checkpoint.phase}`);
			}),
			succeed: jest.fn(async () => {
				calls.push('terminal');
				return true;
			}),
			fail: jest.fn(),
			renew: jest.fn()
		};
		const executor = {
			restore: jest.fn(async input => {
				await input.checkpoint({
					phase: 'SAFETY_READY',
					safetyBackupFileName: `${jobId}.dump.safety`,
					safetyBackupSha256: 'b'.repeat(64)
				});
				await input.checkpoint({ phase: 'MUTATING' });
				await input.checkpoint({ phase: 'VERIFIED' });
				return { target: 'reporting' };
			})
		};
		const cleanup = {
			cleanup: jest.fn(async () => calls.push('cleanup'))
		};
		const restoreWorker = worker({
			control: {
				resolveSourcePath: jest.fn().mockResolvedValue('/job.dump')
			},
			state,
			recovery: {},
			executor,
			cleanup
		});

		await expect(
			restoreWorker.handleMessage(
				message({ eventId, jobId, target: 'reporting' }) as never
			)
		).resolves.toBe('ack');
		expect(calls).toEqual([
			'checkpoint:SAFETY_READY',
			'checkpoint:MUTATING',
			'checkpoint:VERIFIED',
			'terminal',
			'cleanup'
		]);
		expect(state.fail).not.toHaveBeenCalled();
	});

	it('does not ack or clean when failure terminal persistence is unconfirmed', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: { eventId, jobId, target: 'reporting' as const },
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.PREPARING
		};
		const cleanup = { cleanup: jest.fn() };
		const restoreWorker = worker({
			control: {
				resolveSourcePath: jest.fn().mockResolvedValue('/job.dump')
			},
			state: {
				claim: jest.fn().mockResolvedValue({ state: 'claimed', lease }),
				loadClaimedJob: jest
					.fn()
					.mockResolvedValue({ id: jobId, sourceSha256: 'a'.repeat(64) }),
				fail: jest.fn().mockResolvedValue(null),
				renew: jest.fn()
			},
			recovery: {},
			executor: {
				restore: jest.fn().mockRejectedValue(new Error('executor failed'))
			},
			cleanup
		});

		await expect(
			restoreWorker.handleMessage(
				message({ eventId, jobId, target: 'reporting' }) as never
			)
		).rejects.toThrow(
			'Database restore failure checkpoint could not be persisted'
		);
		expect(cleanup.cleanup).not.toHaveBeenCalled();
	});

	it('does not ack or clean when the terminal transaction is unavailable', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: { eventId, jobId, target: 'reporting' as const },
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.PREPARING
		};
		const persistenceError = new Error('operations database unavailable');
		const cleanup = { cleanup: jest.fn() };
		const restoreWorker = worker({
			control: {
				resolveSourcePath: jest.fn().mockResolvedValue('/job.dump')
			},
			state: {
				claim: jest.fn().mockResolvedValue({ state: 'claimed', lease }),
				loadClaimedJob: jest
					.fn()
					.mockResolvedValue({ id: jobId, sourceSha256: 'a'.repeat(64) }),
				fail: jest.fn().mockRejectedValue(persistenceError),
				renew: jest.fn()
			},
			recovery: {},
			executor: {
				restore: jest.fn().mockRejectedValue(new Error('executor failed'))
			},
			cleanup
		});

		await expect(
			restoreWorker.handleMessage(
				message({ eventId, jobId, target: 'reporting' }) as never
			)
		).rejects.toBe(persistenceError);
		expect(cleanup.cleanup).not.toHaveBeenCalled();
	});

	it('holds a redelivery until bounded settlement and requeues an active lease', async () => {
		const waitForEventSettlement = jest.fn().mockResolvedValue({
			state: 'processing',
			job: {
				leaseExpiresAt: new Date(Date.now() + 60_000)
			}
		});
		const waitForProcessingSlot = jest.fn().mockResolvedValue(false);
		const restoreWorker = worker({
			control: {
				resolveSourcePath: jest.fn().mockResolvedValue('/job.dump')
			},
			state: {
				claim: jest.fn().mockResolvedValue({ state: 'unclaimed' })
			},
			recovery: { waitForEventSettlement, waitForProcessingSlot }
		});

		await expect(
			restoreWorker.handleMessage(message() as never)
		).resolves.toBe('requeue');
		expect(waitForEventSettlement).toHaveBeenCalledWith(
			expect.any(Object),
			65_000
		);
		expect(waitForProcessingSlot).toHaveBeenCalledWith(
			'reporting',
			65_000
		);
	});
});
