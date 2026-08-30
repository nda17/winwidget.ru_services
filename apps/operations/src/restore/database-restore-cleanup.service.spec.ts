import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';

describe('DatabaseRestoreCleanupService', () => {
	it('selects only terminal jobs whose artifacts are safe to clean', async () => {
		const findMany = jest.fn().mockResolvedValue([]);
		const service = new DatabaseRestoreCleanupService({
			databaseRestoreJob: { findMany }
		} as never);

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

	it('deletes only the source after verified success and persists evidence', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-cleanup-'));
		const source = join(directory, 'job.dump');
		const safety = `${source}.safety`;
		await writeFile(source, 'source');
		await writeFile(safety, 'safety');
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const service = new DatabaseRestoreCleanupService({
			databaseRestoreJob: { updateMany }
		} as never);

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
		const service = new DatabaseRestoreCleanupService({
			databaseRestoreJob: { updateMany }
		} as never);

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
		const service = new DatabaseRestoreCleanupService({
			databaseRestoreJob: { updateMany }
		} as never);

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
		const service = new DatabaseRestoreCleanupService({
			databaseRestoreJob: { updateMany }
		} as never);

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
});
