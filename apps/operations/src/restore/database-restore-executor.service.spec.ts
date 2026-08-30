import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration,
	DatabaseRestoreTargetRegistryService
} from './database-restore-target-registry.service';

const target: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'REPORTING',
	database: 'winwidget_reporting',
	schema: 'reporting',
	adminRole: 'winwidget_reporting_admin',
	migrationRole: 'winwidget_reporting_migration',
	runtimeRole: 'winwidget_reporting_runtime',
	backupRole: 'winwidget_reporting_backup',
	acl: {
		profile: 'standard',
		routines: ['reject_report_run_snapshot_mutation()'],
		runtimeRoutines: []
	}
};
const connection: DatabaseRestoreConnection = {
	host: '127.0.0.1',
	port: 55441,
	user: target.adminRole,
	database: target.database,
	password: 'test-restore-password'
};
const input = (calls: string[] = []) => ({
	jobId: '0198c64e-a7a2-7244-9328-c769a42113f4',
	target: 'reporting' as const,
	source: '/restore/job.dump',
	expectedSha256: 'source-sha',
	signal: new AbortController().signal,
	checkpoint: jest.fn(async ({ phase }: { phase: string }) => {
		calls.push(`checkpoint:${phase}`);
	})
});

const setup = () => {
	const calls: string[] = [];
	const targets = {
		get: jest.fn(() => {
			calls.push('target');
			return target;
		}),
		connection: jest.fn(async () => {
			calls.push('connection');
			return connection;
		})
	};
	const artifacts = {
		sha256: jest.fn(async (path: string) => {
			calls.push(path.endsWith('.safety') ? 'safety-sha' : 'source-sha');
			return path.endsWith('.safety') ? 'safety-sha' : 'source-sha';
		}),
		assertChecksum: jest.fn(() => calls.push('checksum')),
		assertTableOfContents: jest.fn(() => calls.push('toc-validation'))
	};
	const process = {
		listDump: jest.fn(async (path: string) => {
			calls.push(path.endsWith('.safety') ? 'safety-toc' : 'toc');
			return 'toc';
		}),
		createSafetyCopy: jest.fn(async () => {
			calls.push('safety-copy');
		}),
		recreateSchema: jest.fn(async () => {
			calls.push('recreate');
		}),
		restoreSchema: jest.fn(async () => {
			calls.push('restore');
		}),
		verifyMigrationLedger: jest.fn(async () => {
			calls.push('ledger');
			return true;
		})
	};
	const acl = {
		verify: jest.fn(async () => {
			calls.push('acl-preflight');
		}),
		reconcileAndVerify: jest.fn(async () => {
			calls.push('acl-reconcile');
		})
	};
	const service = new DatabaseRestoreExecutorService(
		targets as unknown as DatabaseRestoreTargetRegistryService,
		artifacts as unknown as DatabaseRestoreArtifactValidatorService,
		process as unknown as DatabaseRestoreProcessService,
		acl as unknown as DatabaseRestoreAclService
	);
	return { service, targets, artifacts, process, acl, calls };
};

describe('DatabaseRestoreExecutorService', () => {
	beforeEach(() => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
	});

	afterEach(() => jest.useRealTimers());

	it('preserves the complete validation, safety, restore, ACL, and ledger order', async () => {
		const { service, artifacts, calls, process } = setup();

		const restoreInput = input(calls);
		await expect(service.restore(restoreInput)).resolves.toEqual({
			target: 'reporting',
			safetyBackupFileName: 'job.dump.safety',
			safetyBackupSha256: 'safety-sha',
			restoredAt: '2026-08-30T12:00:00.000Z',
			verifiedAt: '2026-08-30T12:00:00.000Z'
		});
		expect(calls).toEqual([
			'target',
			'connection',
			'source-sha',
			'checksum',
			'toc',
			'toc-validation',
			'acl-preflight',
			'safety-copy',
			'safety-toc',
			'toc-validation',
			'safety-sha',
			'checkpoint:SAFETY_READY',
			'checkpoint:MUTATING',
			'recreate',
			'restore',
			'acl-reconcile',
			'ledger',
			'checkpoint:VERIFIED'
		]);
		expect(process.createSafetyCopy).toHaveBeenCalledWith(
			connection,
			'reporting',
			'/restore/job.dump.safety',
			restoreInput.signal
		);
		expect(artifacts.assertTableOfContents).toHaveBeenCalledWith(
			'toc',
			target
		);
		expect(artifacts.assertTableOfContents).toHaveBeenCalledTimes(2);
	});

	it.each([
		['connection', 'connection', 'connection failed'],
		['source checksum', 'sha256', 'source hash failed'],
		['checksum validation', 'assertChecksum', 'checksum failed'],
		['TOC listing', 'listDump', 'toc failed'],
		['TOC validation', 'assertTableOfContents', 'toc invalid'],
		['ACL preflight', 'aclVerify', 'acl preflight failed'],
		['safety copy', 'createSafetyCopy', 'safety failed'],
		['safety TOC listing', 'safetyListDump', 'safety toc failed'],
		[
			'safety TOC validation',
			'safetyTableOfContents',
			'safety toc invalid'
		],
		['safety checksum', 'safetySha256', 'safety hash failed']
	])(
		'propagates a pre-destructive %s error without the safety wrapper',
		async (_label, point, message) => {
			const { service, targets, artifacts, process, acl, calls } = setup();
			if (point === 'connection')
				targets.connection.mockRejectedValue(new Error(message));
			if (point === 'sha256')
				artifacts.sha256.mockRejectedValueOnce(new Error(message));
			if (point === 'assertChecksum')
				artifacts.assertChecksum.mockImplementation(() => {
					throw new Error(message);
				});
			if (point === 'listDump')
				process.listDump.mockRejectedValue(new Error(message));
			if (point === 'assertTableOfContents')
				artifacts.assertTableOfContents.mockImplementation(() => {
					throw new Error(message);
				});
			if (point === 'aclVerify')
				acl.verify.mockRejectedValue(new Error(message));
			if (point === 'createSafetyCopy')
				process.createSafetyCopy.mockRejectedValue(new Error(message));
			if (point === 'safetyListDump')
				process.listDump
					.mockResolvedValueOnce('toc')
					.mockRejectedValueOnce(new Error(message));
			if (point === 'safetyTableOfContents')
				artifacts.assertTableOfContents
					.mockImplementationOnce(() => calls.push('toc-validation'))
					.mockImplementationOnce(() => {
						calls.push('toc-validation');
						throw new Error(message);
					});
			if (point === 'safetySha256')
				artifacts.sha256
					.mockResolvedValueOnce('source-sha')
					.mockRejectedValueOnce(new Error(message));

			const restoreInput = input();
			const result = service.restore(restoreInput);
			await expect(result).rejects.toThrow(message);
			await expect(result).rejects.not.toThrow(
				'Database restore failed after safety backup'
			);
			expect(restoreInput.checkpoint).not.toHaveBeenCalled();
			if (
				[
					'connection',
					'sha256',
					'assertChecksum',
					'listDump',
					'assertTableOfContents',
					'aclVerify'
				].includes(point)
			) {
				expect(process.createSafetyCopy).not.toHaveBeenCalled();
			}
			expect(process.recreateSchema).not.toHaveBeenCalled();
			expect(acl.reconcileAndVerify).not.toHaveBeenCalled();
		}
	);

	it('does not create a safety copy or run destructive commands after TOC rejection', async () => {
		const { service, artifacts, process, acl } = setup();
		artifacts.assertTableOfContents.mockImplementation(() => {
			throw new Error('toc invalid');
		});

		await expect(service.restore(input())).rejects.toThrow('toc invalid');
		expect(process.createSafetyCopy).not.toHaveBeenCalled();
		expect(process.recreateSchema).not.toHaveBeenCalled();
		expect(process.restoreSchema).not.toHaveBeenCalled();
		expect(acl.verify).not.toHaveBeenCalled();
		expect(acl.reconcileAndVerify).not.toHaveBeenCalled();
		expect(process.verifyMigrationLedger).not.toHaveBeenCalled();
	});

	it('does not mutate the target when the MUTATING checkpoint is not durable', async () => {
		const { service, process, acl } = setup();
		const restoreInput = input();
		restoreInput.checkpoint.mockImplementation(async ({ phase }) => {
			if (phase === 'MUTATING') {
				throw new Error('checkpoint persistence unavailable');
			}
		});

		await expect(service.restore(restoreInput)).rejects.toThrow(
			'checkpoint persistence unavailable'
		);
		expect(process.recreateSchema).not.toHaveBeenCalled();
		expect(process.restoreSchema).not.toHaveBeenCalled();
		expect(acl.reconcileAndVerify).not.toHaveBeenCalled();
	});

	it.each([
		['schema recreation', 'recreateSchema', ['recreate']],
		['dump restore', 'restoreSchema', ['recreate', 'restore']],
		[
			'ACL reconciliation',
			'reconcileAcl',
			['recreate', 'restore', 'acl-reconcile']
		],
		[
			'ledger query',
			'verifyMigrationLedger',
			['recreate', 'restore', 'acl-reconcile', 'ledger']
		]
	])(
		'wraps a %s failure with the safety SHA and stops the sequence',
		async (_label, method, destructiveCalls) => {
			const { service, process, acl, calls } = setup();
			const failingMethod =
				method === 'reconcileAcl'
					? acl.reconcileAndVerify
					: (process[method as keyof typeof process] as jest.Mock);
			failingMethod.mockImplementation(async () => {
				calls.push(destructiveCalls[destructiveCalls.length - 1]);
				throw new Error('destructive failure');
			});

			await expect(service.restore(input())).rejects.toThrow(
				'Database restore failed after safety backup safety-sha: destructive failure'
			);
			expect(calls.slice(calls.indexOf('recreate'))).toEqual(
				destructiveCalls
			);
		}
	);

	it('wraps a missing migration ledger and stops successfully returning', async () => {
		const { service, process } = setup();
		process.verifyMigrationLedger.mockResolvedValue(false);

		await expect(service.restore(input())).rejects.toThrow(
			'Database restore failed after safety backup safety-sha: Restored database migration ledger is missing'
		);
	});
});
