import { DatabaseRestoreRecoveryActionType } from '@prisma/operations-client';
import { DatabaseRestoreRecoveryExecutorService } from './database-restore-recovery-executor.service';
import { DatabaseRestoreRecoveryCheckpoint } from './database-restore-recovery-state.service';

const target = {
	environmentPrefix: 'REPORTING',
	database: 'winwidget_reporting',
	schema: 'reporting',
	adminRole: 'winwidget_reporting_admin',
	migrationRole: 'winwidget_reporting_migration',
	runtimeRole: 'winwidget_reporting_runtime',
	backupRole: 'winwidget_reporting_backup',
	acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
};

const setup = () => {
	const calls: string[] = [];
	const connection = {
		host: '127.0.0.1' as const,
		port: 5432,
		user: target.adminRole,
		database: target.database,
		password: 'test-password'
	};
	const targets = {
		get: jest.fn(() => target),
		connection: jest.fn(async () => connection)
	};
	const artifacts = {
		sha256: jest.fn(async () => {
			calls.push('artifact-sha');
			return 'a'.repeat(64);
		}),
		assertChecksum: jest.fn(() => calls.push('artifact-checksum')),
		assertTableOfContents: jest.fn(() => calls.push('toc-check'))
	};
	const process = {
		listDump: jest.fn(async () => {
			calls.push('toc-read');
			return 'TOC';
		}),
		extractMigrationLedger: jest.fn(async () => {
			calls.push('dump-ledger-read');
			return 'dump-ledger';
		}),
		recreateSchema: jest.fn(async () => calls.push('recreate')),
		restoreSchema: jest.fn(async () => calls.push('restore')),
		readMigrationLedger: jest.fn(async () => {
			calls.push('database-ledger-read');
			return 'database-ledger';
		})
	};
	const acl = {
		reconcileAndVerify: jest.fn(async () => calls.push('acl-reconcile')),
		verify: jest.fn(async () => calls.push('acl-verify'))
	};
	const manifests = {
		assertBinding: jest.fn(() => calls.push('manifest-binding')),
		assertDumpLedger: jest.fn(() => calls.push('dump-ledger-check')),
		assertDatabaseLedger: jest.fn(() =>
			calls.push('database-ledger-check')
		)
	};
	const writerFence = {
		apply: jest.fn(async () => {
			calls.push('fence');
			return {
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				] as [string, string, string],
				verifiedAt: new Date('2026-08-30T18:00:00.000Z'),
				evidenceSha256: 'b'.repeat(64)
			};
		}),
		verify: jest.fn(async () => calls.push('fence-verify')),
		release: jest.fn(async () => {
			calls.push('release');
			return {
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				] as [string, string, string],
				verifiedAt: new Date('2026-08-30T18:01:00.000Z'),
				evidenceSha256: 'c'.repeat(64)
			};
		})
	};
	const service = new DatabaseRestoreRecoveryExecutorService(
		targets as never,
		artifacts as never,
		process as never,
		acl as never,
		manifests as never,
		writerFence as never
	);
	return {
		service,
		calls,
		targets,
		artifacts,
		process,
		acl,
		manifests,
		writerFence,
		connection
	};
};

const input = (
	action: DatabaseRestoreRecoveryActionType,
	checkpoint: jest.Mock<
		Promise<void>,
		[DatabaseRestoreRecoveryCheckpoint]
	> = jest
		.fn<Promise<void>, [DatabaseRestoreRecoveryCheckpoint]>()
		.mockResolvedValue(undefined)
) => ({
	actionId: '22222222-2222-4222-8222-222222222222',
	action,
	target: 'reporting' as const,
	source: '/restore/job.dump',
	sourceSha256: 'a'.repeat(64),
	safetyBackupSha256: 'a'.repeat(64),
	migrationManifestSha: 'd'.repeat(64),
	signal: new AbortController().signal,
	checkpoint
});

describe('DatabaseRestoreRecoveryExecutorService', () => {
	it('verifies the live target under the fence without mutating for VERIFY_AS_IS', async () => {
		const { service, calls, artifacts, process, acl, writerFence } =
			setup();
		const restoreInput = input(
			DatabaseRestoreRecoveryActionType.VERIFY_AS_IS
		);

		await expect(service.execute(restoreInput)).resolves.toEqual(
			expect.objectContaining({
				result: expect.objectContaining({
					action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
					artifactSha256: null
				})
			})
		);
		expect(artifacts.sha256).not.toHaveBeenCalled();
		expect(process.recreateSchema).not.toHaveBeenCalled();
		expect(process.restoreSchema).not.toHaveBeenCalled();
		expect(acl.verify).toHaveBeenCalledTimes(2);
		expect(writerFence.verify).toHaveBeenCalledTimes(2);
		expect(calls.at(-1)).toBe('release');
	});

	it('validates the exact safety artifact and migration ledger before mutation', async () => {
		const {
			service,
			calls,
			process,
			acl,
			manifests,
			writerFence,
			connection
		} = setup();
		const restoreInput = input(
			DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY
		);

		await service.execute(restoreInput);
		expect(process.listDump).toHaveBeenCalledWith(
			'/restore/job.dump.safety',
			connection.password,
			restoreInput.signal
		);
		expect(manifests.assertDumpLedger).toHaveBeenCalledWith(
			'reporting',
			'reporting',
			'dump-ledger'
		);
		expect(acl.reconcileAndVerify).toHaveBeenCalledWith(
			connection,
			target,
			restoreInput.signal,
			'FENCED'
		);
		expect(calls.indexOf('fence')).toBeLessThan(
			calls.indexOf('dump-ledger-check')
		);
		expect(calls.indexOf('dump-ledger-check')).toBeLessThan(
			calls.indexOf('recreate')
		);
		expect(calls.indexOf('database-ledger-check')).toBeLessThan(
			calls.indexOf('release')
		);
		expect(writerFence.release).toHaveBeenCalledTimes(1);
	});

	it('never releases LOGIN when the durable UNFENCING checkpoint fails', async () => {
		const { service, process, writerFence } = setup();
		const restoreInput = input(
			DatabaseRestoreRecoveryActionType.ROLL_FORWARD_SOURCE,
			jest.fn(async ({ phase }: DatabaseRestoreRecoveryCheckpoint) => {
				if (phase === 'UNFENCING')
					throw new Error('checkpoint unavailable');
			})
		);

		await expect(service.execute(restoreInput)).rejects.toThrow(
			'checkpoint unavailable'
		);
		expect(process.restoreSchema).toHaveBeenCalledTimes(1);
		expect(writerFence.release).not.toHaveBeenCalled();
	});
});
