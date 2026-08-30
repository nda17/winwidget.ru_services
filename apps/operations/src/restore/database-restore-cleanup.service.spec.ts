import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import {
	access,
	mkdir,
	mkdtemp,
	rm,
	utimes,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';

describe('DatabaseRestoreCleanupService', () => {
	it('selects only terminal jobs whose artifacts are safe to clean', async () => {
		const findMany = jest.fn().mockResolvedValue([]);
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { findMany }
			} as never,
			{} as never
		);

		await expect(service.pending(25)).resolves.toEqual([]);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: [
						{
							status: DatabaseRestoreJobStatus.SUCCEEDED,
							sourceDeletedAt: null
						},
						{
							status: DatabaseRestoreJobStatus.SUCCEEDED,
							safetyDeletedAt: null,
							artifactRetainUntil: { lte: expect.any(Date) }
						},
						{
							status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
							recoveryResolvedAt: { not: null },
							artifactRetainUntil: { lte: expect.any(Date) },
							OR: [{ sourceDeletedAt: null }, { safetyDeletedAt: null }]
						},
						{
							AND: [
								{
									OR: [
										{
											status: DatabaseRestoreJobStatus.FAILED,
											phase: {
												in: [
													DatabaseRestoreJobPhase.PREPARING,
													DatabaseRestoreJobPhase.SAFETY_READY
												]
											}
										},
										{
											status: DatabaseRestoreJobStatus.CANCELLED
										}
									]
								},
								{
									OR: [
										{ sourceDeletedAt: null },
										{ safetyDeletedAt: null }
									]
								}
							]
						}
					]
				}
			})
		);
	});

	it('deletes the retained safety artifact only after successful-job retention expires', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(safety, 'safety');
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { updateMany }
			} as never,
			{} as never
		);
		const artifactRetainUntil = new Date(Date.now() - 1_000);
		const sourceDeletedAt = new Date(Date.now() - 2_000);

		try {
			await service.cleanup({
				id: 'job-retained-safety',
				status: DatabaseRestoreJobStatus.SUCCEEDED,
				phase: DatabaseRestoreJobPhase.VERIFIED,
				artifactRetainUntil,
				sourceDeletedAt,
				source
			});
			await expect(access(safety)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			expect(updateMany).toHaveBeenCalledWith({
				where: {
					id: 'job-retained-safety',
					status: DatabaseRestoreJobStatus.SUCCEEDED,
					artifactRetainUntil: { lte: expect.any(Date) }
				},
				data: {
					safetyDeletedAt: expect.any(Date),
					cleanupError: null
				}
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('deletes only the source after verified success and persists evidence', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(source, 'source');
		await writeFile(safety, 'safety');
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { updateMany }
			} as never,
			{} as never
		);

		try {
			await service.cleanup({
				id: 'job-1',
				status: DatabaseRestoreJobStatus.SUCCEEDED,
				phase: DatabaseRestoreJobPhase.VERIFIED,
				source
			});
			await expect(access(source)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			await expect(access(safety)).resolves.toBeUndefined();
			expect(updateMany).toHaveBeenCalledWith({
				where: {
					id: 'job-1',
					status: DatabaseRestoreJobStatus.SUCCEEDED
				},
				data: {
					sourceDeletedAt: expect.any(Date),
					cleanupError: null
				}
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('deletes source and safety only after a safe pre-mutation failure', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(source, 'source');
		await writeFile(safety, 'safety');
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { updateMany }
			} as never,
			{} as never
		);

		try {
			await service.cleanup({
				id: 'job-2',
				status: DatabaseRestoreJobStatus.FAILED,
				phase: DatabaseRestoreJobPhase.SAFETY_READY,
				source
			});
			await expect(access(source)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			await expect(access(safety)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			expect(updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: {
						sourceDeletedAt: expect.any(Date),
						safetyDeletedAt: expect.any(Date),
						cleanupError: null
					}
				})
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('retains both artifacts for RECOVERY_REQUIRED and writes no cleanup evidence', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(source, 'source');
		await writeFile(safety, 'safety');
		const updateMany = jest.fn();
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { updateMany }
			} as never,
			{} as never
		);

		try {
			await service.cleanup({
				id: 'job-3',
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				phase: DatabaseRestoreJobPhase.MUTATING,
				source
			});
			await expect(access(source)).resolves.toBeUndefined();
			await expect(access(safety)).resolves.toBeUndefined();
			expect(updateMany).not.toHaveBeenCalled();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('retains legacy FAILED artifacts when the pre-mutation phase is not proven', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(source, 'source');
		await writeFile(safety, 'safety');
		const updateMany = jest.fn();
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: { updateMany }
			} as never,
			{} as never
		);

		try {
			await service.cleanup({
				id: 'legacy-job',
				status: DatabaseRestoreJobStatus.FAILED,
				phase: null,
				source
			});
			await expect(access(source)).resolves.toBeUndefined();
			await expect(access(safety)).resolves.toBeUndefined();
			expect(updateMany).not.toHaveBeenCalled();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('retains no-DB durable source bytes and removes stale worker temp files', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'restore-orphan-cleanup-')
		);
		const staging = join(directory, 'staging');
		const sealed = join(directory, 'sealed');
		await Promise.all([mkdir(staging), mkdir(sealed)]);
		const orphanJobId = randomUUID();
		const retainedJobId = randomUUID();
		const terminalJobId = randomUUID();
		const orphan = join(staging, `${orphanJobId}.dump`);
		const retained = join(sealed, `${retainedJobId}.dump`);
		const staleTemporary = join(
			sealed,
			`${terminalJobId}.dump.${randomUUID()}.tmp`
		);
		await Promise.all([
			writeFile(orphan, 'orphan'),
			writeFile(retained, 'retained'),
			writeFile(staleTemporary, 'temporary')
		]);
		const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1_000);
		await Promise.all([
			utimes(orphan, old, old),
			utimes(retained, old, old),
			utimes(staleTemporary, old, old)
		]);
		const findMany = jest.fn().mockResolvedValue([
			{
				id: retainedJobId,
				status: DatabaseRestoreJobStatus.QUEUED,
				phase: null,
				recoveryResolvedAt: null,
				artifactRetainUntil: null,
				sourceDeletedAt: null,
				safetyDeletedAt: null
			},
			{
				id: terminalJobId,
				status: DatabaseRestoreJobStatus.SUCCEEDED,
				phase: DatabaseRestoreJobPhase.UNFENCED,
				recoveryResolvedAt: null,
				artifactRetainUntil: new Date(Date.now() + 60_000),
				sourceDeletedAt: new Date(),
				safetyDeletedAt: null
			}
		]);
		const service = new DatabaseRestoreCleanupService(
			{ databaseRestoreJob: { findMany } } as never,
			{
				get: (key: string) =>
					key === 'DATABASE_RESTORE_STAGING_DIR' ? staging : sealed
			} as never
		);

		try {
			await expect(service.sweepOrphans(25)).resolves.toBe(1);
			await expect(access(orphan)).resolves.toBeUndefined();
			await expect(access(staleTemporary)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			await expect(access(retained)).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('removes durable bytes when deletion evidence already exists', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'restore-orphan-evidence-')
		);
		const staging = join(directory, 'staging');
		const sealed = join(directory, 'sealed');
		await Promise.all([mkdir(staging), mkdir(sealed)]);
		const jobId = randomUUID();
		const source = join(sealed, `${jobId}.dump`);
		const safety = `${source}.safety`;
		await Promise.all([
			writeFile(source, 'source'),
			writeFile(safety, 'safety')
		]);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
		await Promise.all([
			utimes(source, old, old),
			utimes(safety, old, old)
		]);
		const findMany = jest.fn().mockResolvedValue([
			{
				id: jobId,
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				phase: DatabaseRestoreJobPhase.MUTATING,
				recoveryResolvedAt: null,
				artifactRetainUntil: new Date(Date.now() + 60_000),
				sourceDeletedAt: new Date(),
				safetyDeletedAt: null
			}
		]);
		const service = new DatabaseRestoreCleanupService(
			{ databaseRestoreJob: { findMany } } as never,
			{
				get: (key: string) =>
					key === 'DATABASE_RESTORE_STAGING_DIR' ? staging : sealed
			} as never
		);

		try {
			await expect(service.sweepOrphans(25)).resolves.toBe(1);
			await expect(access(source)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			await expect(access(safety)).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('does not let retained candidates starve later removable orphans', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'restore-orphan-starvation-')
		);
		const staging = join(directory, 'staging');
		const sealed = join(directory, 'sealed');
		await Promise.all([mkdir(staging), mkdir(sealed)]);
		const retainedIds = [
			'00000000-0000-4000-8000-000000000001',
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000003'
		];
		const orphanId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
		const retained = retainedIds.map(id => join(staging, `${id}.dump`));
		const orphan = join(sealed, `${orphanId}.dump.${randomUUID()}.tmp`);
		await Promise.all(
			[...retained, orphan].map(path => writeFile(path, 'artifact'))
		);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
		await Promise.all(
			[...retained, orphan].map(path => utimes(path, old, old))
		);
		const findMany = jest.fn().mockResolvedValue(
			retainedIds.map(id => ({
				id,
				status: DatabaseRestoreJobStatus.QUEUED,
				phase: null,
				recoveryResolvedAt: null,
				artifactRetainUntil: null,
				sourceDeletedAt: null,
				safetyDeletedAt: null
			}))
		);
		const service = new DatabaseRestoreCleanupService(
			{ databaseRestoreJob: { findMany } } as never,
			{
				get: (key: string) =>
					key === 'DATABASE_RESTORE_STAGING_DIR' ? staging : sealed
			} as never
		);

		try {
			await expect(service.sweepOrphans(1)).resolves.toBe(1);
			await expect(access(orphan)).rejects.toMatchObject({
				code: 'ENOENT'
			});
			for (const path of retained) {
				await expect(access(path)).resolves.toBeUndefined();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('keeps aged orphan bytes when the Operations DB absence check is unavailable', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-orphan-db-'));
		const staging = join(directory, 'staging');
		const sealed = join(directory, 'sealed');
		await Promise.all([mkdir(staging), mkdir(sealed)]);
		const orphan = join(staging, `${randomUUID()}.dump`);
		await writeFile(orphan, 'orphan');
		const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
		await utimes(orphan, old, old);
		const service = new DatabaseRestoreCleanupService(
			{
				databaseRestoreJob: {
					findMany: jest
						.fn()
						.mockRejectedValue(new Error('DB unavailable'))
				}
			} as never,
			{
				get: (key: string) =>
					key === 'DATABASE_RESTORE_STAGING_DIR' ? staging : sealed
			} as never
		);

		try {
			await expect(service.sweepOrphans(25)).rejects.toThrow(
				'DB unavailable'
			);
			await expect(access(orphan)).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
