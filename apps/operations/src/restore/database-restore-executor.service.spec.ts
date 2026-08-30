import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration,
	DatabaseRestoreTargetRegistryService
} from './database-restore-target-registry.service';
import { DatabaseRestoreWriterFenceService } from './database-restore-writer-fence.service';

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
	migrationManifestSha: 'b'.repeat(64),
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
		extractMigrationLedger: jest.fn(async (path: string) => {
			const safety = path.endsWith('.safety');
			calls.push(safety ? 'safety-ledger' : 'source-ledger');
			return safety ? 'safety-ledger' : 'source-ledger';
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
		readMigrationLedger: jest
			.fn()
			.mockImplementationOnce(async () => {
				calls.push('target-ledger-read');
				return 'target-ledger';
			})
			.mockImplementation(async () => {
				calls.push('restored-ledger-read');
				return 'restored-ledger';
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
	const manifests = {
		assertBinding: jest.fn(() => calls.push('manifest-binding')),
		assertDumpLedger: jest.fn((_target, _schema, ledger) => {
			calls.push(
				ledger === 'safety-ledger'
					? 'safety-ledger-validation'
					: 'source-ledger-validation'
			);
		}),
		assertDatabaseLedger: jest.fn((_target, ledger) => {
			calls.push(
				ledger === 'target-ledger'
					? 'target-ledger-validation'
					: 'restored-ledger-validation'
			);
		})
	};
	const writerFence = {
		apply: jest.fn(async () => {
			calls.push('fence-apply');
			return {
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				],
				verifiedAt: new Date(),
				evidenceSha256: 'e'.repeat(64)
			};
		}),
		verify: jest.fn(async () => {
			calls.push('fence-verify');
			return {
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				],
				verifiedAt: new Date(),
				evidenceSha256: 'e'.repeat(64)
			};
		}),
		release: jest.fn(async () => {
			calls.push('fence-release');
			return {
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				],
				verifiedAt: new Date(),
				evidenceSha256: 'f'.repeat(64)
			};
		})
	};
	const service = new DatabaseRestoreExecutorService(
		targets as unknown as DatabaseRestoreTargetRegistryService,
		artifacts as unknown as DatabaseRestoreArtifactValidatorService,
		process as unknown as DatabaseRestoreProcessService,
		acl as unknown as DatabaseRestoreAclService,
		manifests as unknown as DatabaseRestoreMigrationManifestService,
		writerFence as unknown as DatabaseRestoreWriterFenceService
	);
	return {
		service,
		targets,
		artifacts,
		process,
		acl,
		manifests,
		writerFence,
		calls
	};
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
			verifiedAt: '2026-08-30T12:00:00.000Z',
			writerFenceAppliedAt: '2026-08-30T12:00:00.000Z',
			writerFenceReleasedAt: '2026-08-30T12:00:00.000Z'
		});
		expect(calls).toEqual([
			'target',
			'manifest-binding',
			'connection',
			'source-sha',
			'checksum',
			'toc',
			'toc-validation',
			'source-ledger',
			'source-ledger-validation',
			'acl-preflight',
			'checkpoint:FENCING',
			'fence-apply',
			'checkpoint:FENCED',
			'target-ledger-read',
			'target-ledger-validation',
			'safety-copy',
			'safety-toc',
			'toc-validation',
			'safety-ledger',
			'safety-ledger-validation',
			'safety-sha',
			'checkpoint:SAFETY_READY',
			'fence-verify',
			'checkpoint:MUTATING',
			'recreate',
			'restore',
			'acl-reconcile',
			'restored-ledger-read',
			'restored-ledger-validation',
			'checkpoint:VERIFIED',
			'restored-ledger-read',
			'restored-ledger-validation',
			'acl-preflight',
			'fence-verify',
			'checkpoint:UNFENCING',
			'fence-release',
			'checkpoint:UNFENCED'
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
		expect(process.extractMigrationLedger).toHaveBeenCalledWith(
			'/restore/job.dump.safety',
			target,
			restoreInput.signal
		);
	});

	it.each([
		['manifest binding', 'manifestBinding', 'manifest binding failed'],
		['connection', 'connection', 'connection failed'],
		['source checksum', 'sha256', 'source hash failed'],
		['checksum validation', 'assertChecksum', 'checksum failed'],
		['TOC listing', 'listDump', 'toc failed'],
		['TOC validation', 'assertTableOfContents', 'toc invalid'],
		[
			'source ledger extraction',
			'extractMigrationLedger',
			'ledger extract failed'
		],
		['source ledger validation', 'assertDumpLedger', 'ledger mismatch'],
		['ACL preflight', 'aclVerify', 'acl preflight failed'],
		[
			'current target ledger query',
			'targetLedger',
			'target ledger failed'
		],
		[
			'current target ledger validation',
			'targetLedgerValidation',
			'target ledger mismatch'
		],
		['safety copy', 'createSafetyCopy', 'safety failed'],
		['safety TOC listing', 'safetyListDump', 'safety toc failed'],
		[
			'safety TOC validation',
			'safetyTableOfContents',
			'safety toc invalid'
		],
		['safety ledger extraction', 'safetyLedger', 'safety ledger failed'],
		[
			'safety ledger validation',
			'safetyLedgerValidation',
			'safety ledger mismatch'
		],
		['safety checksum', 'safetySha256', 'safety hash failed']
	])(
		'propagates a pre-destructive %s error without the safety wrapper',
		async (_label, point, message) => {
			const {
				service,
				targets,
				artifacts,
				process,
				acl,
				manifests,
				calls
			} = setup();
			if (point === 'manifestBinding')
				manifests.assertBinding.mockImplementation(() => {
					throw new Error(message);
				});
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
			if (point === 'extractMigrationLedger')
				process.extractMigrationLedger.mockRejectedValue(
					new Error(message)
				);
			if (point === 'assertDumpLedger')
				manifests.assertDumpLedger.mockImplementation(() => {
					throw new Error(message);
				});
			if (point === 'aclVerify')
				acl.verify.mockRejectedValue(new Error(message));
			if (point === 'targetLedger')
				process.readMigrationLedger
					.mockReset()
					.mockRejectedValueOnce(new Error(message));
			if (point === 'targetLedgerValidation')
				manifests.assertDatabaseLedger.mockImplementationOnce(() => {
					throw new Error(message);
				});
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
			if (point === 'safetyLedger')
				process.extractMigrationLedger
					.mockResolvedValueOnce('source-ledger')
					.mockRejectedValueOnce(new Error(message));
			if (point === 'safetyLedgerValidation')
				manifests.assertDumpLedger
					.mockImplementationOnce(() => undefined)
					.mockImplementationOnce(() => {
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
			if (
				[
					'manifestBinding',
					'connection',
					'sha256',
					'assertChecksum',
					'listDump',
					'assertTableOfContents',
					'extractMigrationLedger',
					'assertDumpLedger',
					'aclVerify'
				].includes(point)
			) {
				expect(restoreInput.checkpoint).not.toHaveBeenCalled();
				expect(process.createSafetyCopy).not.toHaveBeenCalled();
			} else {
				expect(restoreInput.checkpoint).toHaveBeenCalledWith(
					expect.objectContaining({ phase: 'FENCING' })
				);
				expect(restoreInput.checkpoint).toHaveBeenCalledWith(
					expect.objectContaining({ phase: 'FENCED' })
				);
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
		expect(process.extractMigrationLedger).not.toHaveBeenCalled();
		expect(process.readMigrationLedger).not.toHaveBeenCalled();
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
			'readMigrationLedger',
			['recreate', 'restore', 'acl-reconcile', 'restored-ledger-read']
		],
		[
			'ledger validation',
			'assertDatabaseLedger',
			[
				'recreate',
				'restore',
				'acl-reconcile',
				'restored-ledger-read',
				'restored-ledger-validation'
			]
		]
	])(
		'wraps a %s failure with the safety SHA and stops the sequence',
		async (_label, method, destructiveCalls) => {
			const { service, process, acl, manifests, calls } = setup();
			const failingMethod = (
				method === 'reconcileAcl'
					? acl.reconcileAndVerify
					: method === 'assertDatabaseLedger'
						? manifests.assertDatabaseLedger
						: process[method as keyof typeof process]
			) as jest.Mock;
			if (method === 'assertDatabaseLedger') {
				failingMethod
					.mockImplementationOnce(() => {
						calls.push('target-ledger-validation');
					})
					.mockImplementation(() => {
						calls.push(destructiveCalls[destructiveCalls.length - 1]);
						throw new Error('destructive failure');
					});
			} else {
				failingMethod.mockImplementation(async () => {
					calls.push(destructiveCalls[destructiveCalls.length - 1]);
					throw new Error('destructive failure');
				});
			}

			await expect(service.restore(input())).rejects.toThrow(
				'Database restore failed after safety backup safety-sha: destructive failure'
			);
			expect(calls.slice(calls.indexOf('recreate'))).toEqual(
				destructiveCalls
			);
		}
	);

	it('rejects a source manifest mismatch before creating a safety copy', async () => {
		const { service, manifests, process } = setup();
		manifests.assertDumpLedger.mockImplementation(() => {
			throw new Error('source migration mismatch');
		});

		await expect(service.restore(input())).rejects.toThrow(
			'source migration mismatch'
		);
		expect(process.createSafetyCopy).not.toHaveBeenCalled();
		expect(process.recreateSchema).not.toHaveBeenCalled();
	});

	it('wraps a restored manifest mismatch with the safety SHA', async () => {
		const { service, manifests } = setup();
		manifests.assertDatabaseLedger
			.mockImplementationOnce(() => undefined)
			.mockImplementation(() => {
				throw new Error('restored migration mismatch');
			});

		await expect(service.restore(input())).rejects.toThrow(
			'Database restore failed after safety backup safety-sha: restored migration mismatch'
		);
	});

	it('does not re-apply the writer fence after the authorized LOGIN transition', async () => {
		const { service, writerFence } = setup();
		const restoreInput = input();
		restoreInput.checkpoint.mockImplementation(async ({ phase }) => {
			if (phase === 'UNFENCED') {
				throw new Error('unfenced checkpoint unavailable');
			}
		});

		await expect(service.restore(restoreInput)).rejects.toThrow(
			'unfenced checkpoint unavailable'
		);
		expect(writerFence.release).toHaveBeenCalledTimes(1);
		expect(writerFence.apply).toHaveBeenCalledTimes(1);
	});
});
