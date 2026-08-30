import { ConfigService } from '@nestjs/config';
import {
	ConflictException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	OutboxStatus
} from '@prisma/operations-client';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	access,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreService } from './database-restore.service';
import { DatabaseRestoreWorkerService } from './database-restore-worker.service';

const SERVICES_SHA = 'a'.repeat(40);
const MIGRATION_MANIFEST_SHA = 'b'.repeat(64);
const ORIGINAL_APP_REVISION = process.env.APP_REVISION;

beforeAll(() => {
	process.env.APP_REVISION = SERVICES_SHA;
});

afterAll(() => {
	if (ORIGINAL_APP_REVISION === undefined) delete process.env.APP_REVISION;
	else process.env.APP_REVISION = ORIGINAL_APP_REVISION;
});

const message = (overrides: Record<string, unknown> = {}) => {
	const eventId = randomUUID();
	const jobId = randomUUID();
	const payload = {
		schemaVersion: 2,
		eventId,
		jobId,
		target: 'reporting',
		expectedServicesSha: SERVICES_SHA,
		migrationManifestSha: MIGRATION_MANIFEST_SHA,
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
const manifestRegistry = () => ({
	sha256: jest.fn().mockReturnValue(MIGRATION_MANIFEST_SHA)
});

const worker = (dependencies: {
	control?: unknown;
	state?: unknown;
	recovery?: unknown;
	executor?: unknown;
	cleanup?: unknown;
	runtime?: unknown;
	rabbit?: unknown;
	manifests?: unknown;
	recoveryState?: unknown;
	recoveryExecutor?: unknown;
}) =>
	new DatabaseRestoreWorkerService(
		(dependencies.runtime ?? {}) as never,
		(dependencies.rabbit ?? {}) as never,
		{
			isExecutionEnabled: jest.fn(() => true),
			resolveSourcePath: jest.fn(
				async (id: string) => `/staging/${id}.dump`
			),
			resolveSealedSourcePath: jest.fn(
				async (id: string) => `/sealed/${id}.dump`
			),
			sealSourceArtifact: jest.fn(async (id: string) => ({
				stagingPath: `/staging/${id}.dump`,
				sealedPath: `/sealed/${id}.dump`
			})),
			...((dependencies.control ?? {}) as Record<string, unknown>)
		} as never,
		{
			confirmReleaseAuthorized: jest.fn().mockResolvedValue(null),
			confirmSucceeded: jest.fn().mockResolvedValue(false),
			...((dependencies.state ?? {}) as Record<string, unknown>)
		} as never,
		(dependencies.recovery ?? {}) as never,
		(dependencies.executor ?? {}) as never,
		(dependencies.cleanup ?? {}) as never,
		(dependencies.manifests ?? { assertBinding: jest.fn() }) as never,
		(dependencies.recoveryState ?? {
			recoverExpired: jest.fn(async () => 0)
		}) as never,
		(dependencies.recoveryExecutor ?? {}) as never
	);

describe('DatabaseRestoreService contract', () => {
	it('exposes only the currently approved non-Operations, non-Billing targets', async () => {
		const authorization = {
			getApprovedPermit: jest.fn().mockResolvedValue(null)
		};
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'false',
				APP_REVISION: SERVICES_SHA
			}),
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			authorization as never,
			{} as never,
			manifestRegistry() as never
		);

		await expect(service.getSettings()).resolves.toEqual(
			expect.objectContaining({
				enabled: false,
				approved: null,
				permitRequired: true,
				allowedFileExtension: '.dump',
				maxFileSizeBytes: 49 * 1024 * 1024,
				currentServicesSha: SERVICES_SHA,
				targets: expect.arrayContaining([
					expect.objectContaining({
						id: 'reporting',
						migrationManifestSha: MIGRATION_MANIFEST_SHA
					})
				])
			})
		);
		const settings = await service.getSettings();
		expect(settings.targets.map(item => item.id)).toEqual([
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'identity',
			'platform',
			'support'
		]);
	});

	it('fails settings closed without an exact running services SHA', async () => {
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'false',
				APP_REVISION: 'unknown'
			}),
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			manifestRegistry() as never
		);

		await expect(service.getSettings()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('seals the approved bytes outside staging before any pathname replacement', async () => {
		const storage = await mkdtemp(
			join(tmpdir(), 'operations-restore-seal-')
		);
		const staging = join(storage, 'staging');
		const sealed = join(storage, 'sealed');
		const jobId = randomUUID();
		const approved = Buffer.from('PGDMP-approved');
		const expectedSha256 = createHash('sha256')
			.update(approved)
			.digest('hex');
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_STAGING_DIR: staging,
				DATABASE_RESTORE_SEALED_DIR: sealed
			}),
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			manifestRegistry() as never
		);

		try {
			const stagingPath = await service.resolveSourcePath(jobId);
			await writeFile(stagingPath, approved, { mode: 0o600 });
			const paths = await service.sealSourceArtifact(
				jobId,
				expectedSha256,
				BigInt(approved.length)
			);
			await writeFile(stagingPath, Buffer.from('PGDMP-replaced'));

			expect(paths.stagingPath).toBe(stagingPath);
			expect(paths.sealedPath).not.toBe(stagingPath);
			await expect(readFile(paths.sealedPath)).resolves.toEqual(approved);
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it('durably removes a newly published seal when post-rename verification fails', async () => {
		const storage = await mkdtemp(
			join(tmpdir(), 'operations-restore-seal-rollback-')
		);
		const staging = join(storage, 'staging');
		const sealed = join(storage, 'sealed');
		const jobId = randomUUID();
		const approved = Buffer.from('PGDMP-approved');
		const expectedSha256 = createHash('sha256')
			.update(approved)
			.digest('hex');
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_STAGING_DIR: staging,
				DATABASE_RESTORE_SEALED_DIR: sealed
			}),
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			manifestRegistry() as never
		);

		try {
			const stagingPath = await service.resolveSourcePath(jobId);
			const sealedPath = await service.resolveSealedSourcePath(jobId);
			await writeFile(stagingPath, approved, { mode: 0o600 });
			const internals = service as unknown as {
				syncParentDirectory(path: string): Promise<void>;
			};
			const syncParentDirectory =
				internals.syncParentDirectory.bind(service);
			let rejectPublishedSync = true;
			internals.syncParentDirectory = jest.fn(async path => {
				if (path === sealedPath && rejectPublishedSync) {
					rejectPublishedSync = false;
					throw new Error('injected post-rename fsync failure');
				}
				await syncParentDirectory(path);
			});

			await expect(
				service.sealSourceArtifact(
					jobId,
					expectedSha256,
					BigInt(approved.length)
				)
			).rejects.toThrow('injected post-rename fsync failure');
			await expect(access(sealedPath)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			await expect(access(stagingPath)).resolves.toBeUndefined();
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it.each(['nested', 'symlink-alias'] as const)(
		'rejects a %s sealed directory that remains visible through staging',
		async boundary => {
			const storage = await mkdtemp(
				join(tmpdir(), 'operations-restore-boundary-')
			);
			const staging = join(storage, 'staging');
			const sealed =
				boundary === 'nested'
					? join(staging, 'sealed')
					: join(storage, 'sealed-alias');
			const jobId = randomUUID();
			const approved = Buffer.from('PGDMP-approved');
			const expectedSha256 = createHash('sha256')
				.update(approved)
				.digest('hex');
			const service = new DatabaseRestoreService(
				restoreConfig({
					DATABASE_RESTORE_STAGING_DIR: staging,
					DATABASE_RESTORE_SEALED_DIR: sealed
				}),
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				manifestRegistry() as never
			);

			try {
				const stagingPath = await service.resolveSourcePath(jobId);
				await writeFile(stagingPath, approved, { mode: 0o600 });
				if (boundary === 'symlink-alias') {
					await symlink(staging, sealed, 'dir');
				}
				await expect(
					service.sealSourceArtifact(
						jobId,
						expectedSha256,
						BigInt(approved.length)
					)
				).rejects.toThrow(
					boundary === 'symlink-alias'
						? 'must not share filesystem directory identity'
						: 'must be distinct non-nested paths'
				);
			} finally {
				await rm(storage, { recursive: true, force: true });
			}
		}
	);

	it.each(['symlink', 'fifo'] as const)(
		'rejects a %s staging artifact without following or blocking on it',
		async artifactType => {
			const storage = await mkdtemp(
				join(tmpdir(), 'operations-restore-special-file-')
			);
			const staging = join(storage, 'staging');
			const sealed = join(storage, 'sealed');
			const jobId = randomUUID();
			const approved = Buffer.from('PGDMP-approved');
			const expectedSha256 = createHash('sha256')
				.update(approved)
				.digest('hex');
			const service = new DatabaseRestoreService(
				restoreConfig({
					DATABASE_RESTORE_STAGING_DIR: staging,
					DATABASE_RESTORE_SEALED_DIR: sealed
				}),
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				manifestRegistry() as never
			);

			try {
				const stagingPath = await service.resolveSourcePath(jobId);
				if (artifactType === 'symlink') {
					const outside = join(storage, 'outside.dump');
					await writeFile(outside, approved, { mode: 0o600 });
					await symlink(outside, stagingPath);
				} else {
					execFileSync('mkfifo', [stagingPath]);
				}
				await expect(
					service.sealSourceArtifact(
						jobId,
						expectedSha256,
						BigInt(approved.length)
					)
				).rejects.toThrow();
			} finally {
				await rm(storage, { recursive: true, force: true });
			}
		}
	);

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
		const authorization = {
			closeExpiredPermits: jest.fn().mockResolvedValue(undefined),
			consumePermit: jest.fn().mockResolvedValue({
				id: randomUUID(),
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64)
			})
		};
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STAGING_DIR: storage,
				DATABASE_RESTORE_SEALED_DIR: join(storage, 'sealed')
			}),
			prisma as never,
			outbox as never,
			audit as never,
			{} as never,
			authorization as never,
			{} as never,
			manifestRegistry() as never
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
				expect.objectContaining({
					jobId: requestId,
					attempt: 0,
					publicationStatus: 'PENDING',
					publicationConfirmed: false
				})
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
						eventId: randomUUID(),
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
				},
				outboxEvent: {
					findUnique: jest.fn().mockResolvedValue({
						status: 'PUBLISHED'
					})
				}
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{
				closeExpiredPermits: jest.fn().mockResolvedValue(undefined)
			} as never,
			{} as never,
			manifestRegistry() as never
		);

		await expect(service.getJob(randomUUID())).resolves.toEqual(
			expect.objectContaining({
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				attempt: 2,
				publicationStatus: 'PUBLISHED',
				publicationConfirmed: true,
				error: {
					code: 'RESTORE_RECOVERY_REQUIRED',
					message: 'manual recovery required'
				}
			})
		);
	});

	it('returns 409 but retains the upload after an ambiguous target-fence transaction conflict', async () => {
		const storage = await mkdtemp(join(tmpdir(), 'operations-restore-'));
		const requestId = randomUUID();
		const conflict = Object.assign(new Error('unique target fence'), {
			code: 'P2002'
		});
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STAGING_DIR: storage,
				DATABASE_RESTORE_SEALED_DIR: join(storage, 'sealed')
			}),
			{
				databaseRestoreJob: {
					findUnique: jest.fn().mockResolvedValue(null)
				},
				$transaction: jest.fn().mockRejectedValue(conflict)
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{
				closeExpiredPermits: jest.fn().mockResolvedValue(undefined)
			} as never,
			{} as never,
			manifestRegistry() as never
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
			).resolves.toBeUndefined();
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it('keeps the upload and returns the exact job when the enqueue commit outcome is ambiguous', async () => {
		const storage = await mkdtemp(join(tmpdir(), 'operations-restore-'));
		const requestId = randomUUID();
		const actorId = 'admin-42';
		const now = new Date('2026-08-30T08:00:00.000Z');
		const committed = {
			id: requestId,
			eventId: randomUUID(),
			target: 'reporting',
			status: DatabaseRestoreJobStatus.QUEUED,
			attempts: 0,
			sourceFileName: 'reporting.dump',
			sourceSha256:
				'08d8bf3a4beea7e8b592896db112e37968ec2aa36d539b391acc6a69543b9f45',
			sourceSize: 6n,
			requestedById: actorId,
			expectedServicesSha: SERVICES_SHA,
			migrationManifestSha: MIGRATION_MANIFEST_SHA,
			result: null,
			lastError: null,
			startedAt: null,
			finishedAt: null,
			createdAt: now,
			terminalReceipt: null,
			recoveryResolutionReceipt: null,
			recoveryActions: []
		};
		const prisma = {
			databaseRestoreJob: {
				findUnique: jest
					.fn()
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(committed)
			},
			$transaction: jest
				.fn()
				.mockRejectedValue(new Error('transaction result was lost'))
		};
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STAGING_DIR: storage,
				DATABASE_RESTORE_SEALED_DIR: join(storage, 'sealed')
			}),
			prisma as never,
			{} as never,
			{} as never,
			{} as never,
			{
				closeExpiredPermits: jest.fn().mockResolvedValue(undefined)
			} as never,
			{} as never,
			manifestRegistry() as never
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
					actorId,
					ip: null,
					userAgent: null
				})
			).resolves.toEqual(
				expect.objectContaining({
					jobId: requestId,
					publicationStatus: OutboxStatus.PENDING,
					publicationConfirmed: false
				})
			);
			await expect(
				access(join(storage, `${requestId}.dump`))
			).resolves.toBeUndefined();
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it('reuses an exact durable staging artifact after an ambiguous rolled-back enqueue', async () => {
		const storage = await mkdtemp(
			join(tmpdir(), 'operations-restore-retry-')
		);
		const staging = join(storage, 'staging');
		const sealed = join(storage, 'sealed');
		const requestId = randomUUID();
		const actorId = 'admin-42';
		const transactionError = new Error('transaction outcome unavailable');
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
				findUnique: jest
					.fn()
					.mockResolvedValueOnce(null)
					.mockRejectedValueOnce(new Error('read-back unavailable'))
					.mockResolvedValueOnce(null)
			},
			$transaction: jest
				.fn()
				.mockRejectedValueOnce(transactionError)
				.mockImplementationOnce((callback: (value: unknown) => unknown) =>
					callback(transaction)
				)
		};
		const authorization = {
			closeExpiredPermits: jest.fn().mockResolvedValue(undefined),
			consumePermit: jest.fn().mockResolvedValue({
				id: randomUUID(),
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			})
		};
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STAGING_DIR: staging,
				DATABASE_RESTORE_SEALED_DIR: sealed
			}),
			prisma as never,
			{ enqueue: jest.fn().mockResolvedValue({}) } as never,
			{ recordInTransaction: jest.fn().mockResolvedValue({}) } as never,
			{} as never,
			authorization as never,
			{} as never,
			manifestRegistry() as never
		);
		const input = {
			target: 'reporting',
			file: {
				originalname: 'reporting.dump',
				size: 6,
				buffer: Buffer.from('PGDMP1')
			},
			confirmation: 'ВОССТАНОВИТЬ REPORTING',
			requestId,
			actorId,
			ip: null,
			userAgent: null
		};

		try {
			await expect(service.enqueue(input)).rejects.toBe(transactionError);
			await expect(service.enqueue(input)).resolves.toEqual(
				expect.objectContaining({
					jobId: requestId,
					publicationStatus: OutboxStatus.PENDING
				})
			);
			expect(create).toHaveBeenCalledTimes(1);
			await expect(
				readFile(join(staging, `${requestId}.dump`))
			).resolves.toEqual(Buffer.from('PGDMP1'));
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
				}),
				sweepOrphans: jest.fn(async () => calls.push('orphan-cleanup'))
			}
		});

		await restoreWorker.onModuleInit();
		expect(calls).toEqual([
			'recover',
			'pending-cleanup',
			'orphan-cleanup',
			'consume'
		]);
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

	it('terminalizes a queued event for a different services revision before source access', async () => {
		const resolveSourcePath = jest.fn();
		const failQueuedPermanent = jest.fn().mockResolvedValue(true);
		const restoreWorker = worker({
			control: { resolveSourcePath },
			state: { failQueuedPermanent },
			cleanup: { cleanup: jest.fn(), recordError: jest.fn() }
		});

		await expect(
			restoreWorker.handleMessage(
				message({ expectedServicesSha: 'f'.repeat(40) }) as never
			)
		).resolves.toBe('ack');
		expect(failQueuedPermanent).toHaveBeenCalledWith(
			expect.objectContaining({ expectedServicesSha: 'f'.repeat(40) }),
			expect.any(Error)
		);
	});

	it('terminalizes a queued event with a stale migration manifest', async () => {
		const resolveSourcePath = jest.fn();
		const failQueuedPermanent = jest.fn().mockResolvedValue(true);
		const assertBinding = jest.fn(() => {
			throw new Error('stale manifest');
		});
		const restoreWorker = worker({
			control: { resolveSourcePath },
			manifests: { assertBinding },
			state: { failQueuedPermanent },
			cleanup: { cleanup: jest.fn(), recordError: jest.fn() }
		});

		await expect(
			restoreWorker.handleMessage(message() as never)
		).resolves.toBe('ack');
		expect(assertBinding).toHaveBeenCalledWith(
			'reporting',
			MIGRATION_MANIFEST_SHA
		);
		expect(failQueuedPermanent).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ message: 'stale manifest' })
		);
	});

	it('persists VERIFIED success before cleanup and acknowledges', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: {
				eventId,
				jobId,
				target: 'reporting' as const,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			},
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
		expect(executor.restore).toHaveBeenCalledWith(
			expect.objectContaining({
				target: 'reporting',
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			})
		);
		expect(state.fail).not.toHaveBeenCalled();
	});

	it('does not ack or clean when failure terminal persistence is unconfirmed', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: {
				eventId,
				jobId,
				target: 'reporting' as const,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			},
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

	it('does not compensate an ambiguous post-LOGIN success persistence failure', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: {
				eventId,
				jobId,
				target: 'reporting' as const,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.UNFENCED
		};
		const reapplyFence = jest.fn().mockResolvedValue(undefined);
		const fail = jest
			.fn()
			.mockResolvedValue(DatabaseRestoreJobStatus.RECOVERY_REQUIRED);
		const restoreWorker = worker({
			control: {
				resolveSourcePath: jest.fn().mockResolvedValue('/job.dump')
			},
			state: {
				claim: jest.fn().mockResolvedValue({ state: 'claimed', lease }),
				loadClaimedJob: jest
					.fn()
					.mockResolvedValue({ id: jobId, sourceSha256: 'a'.repeat(64) }),
				succeed: jest.fn().mockResolvedValue(false),
				fail,
				renew: jest.fn()
			},
			recovery: {},
			executor: {
				restore: jest.fn().mockResolvedValue({ target: 'reporting' }),
				reapplyFence
			},
			cleanup: { cleanup: jest.fn() }
		});

		await expect(
			restoreWorker.handleMessage(
				message({ eventId, jobId, target: 'reporting' }) as never
			)
		).rejects.toThrow(
			'Database restore success checkpoint could not be persisted'
		);
		expect(reapplyFence).not.toHaveBeenCalled();
		expect(fail).not.toHaveBeenCalled();
	});

	it('does not ack or clean when the terminal transaction is unavailable', async () => {
		const eventId = randomUUID();
		const jobId = randomUUID();
		const lease = {
			event: {
				eventId,
				jobId,
				target: 'reporting' as const,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MIGRATION_MANIFEST_SHA
			},
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
