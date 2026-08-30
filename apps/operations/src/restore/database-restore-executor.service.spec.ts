import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration,
	DatabaseRestoreTargetRegistryService
} from './database-restore-target-registry.service';

const target: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'OPERATIONS',
	database: 'winwidget_operations',
	schema: 'operations',
	adminRole: 'winwidget_operations_admin',
	migrationRole: 'winwidget_operations_migration',
	runtimeRole: 'winwidget_operations_runtime',
	backupRole: 'winwidget_operations_backup'
};
const connection: DatabaseRestoreConnection = {
	host: '127.0.0.1',
	port: 55441,
	user: target.adminRole,
	database: target.database,
	password: 'test-restore-password'
};
const input = {
	jobId: '0198c64e-a7a2-7244-9328-c769a42113f4',
	target: 'operations' as const,
	source: '/restore/job.dump',
	expectedSha256: 'source-sha'
};

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
		listDump: jest.fn(async () => {
			calls.push('toc');
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
		applyAcl: jest.fn(async () => {
			calls.push('acl');
		}),
		verifyMigrationLedger: jest.fn(async () => {
			calls.push('ledger');
			return true;
		})
	};
	const service = new DatabaseRestoreExecutorService(
		targets as unknown as DatabaseRestoreTargetRegistryService,
		artifacts as unknown as DatabaseRestoreArtifactValidatorService,
		process as unknown as DatabaseRestoreProcessService
	);
	return { service, targets, artifacts, process, calls };
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

		await expect(service.restore(input)).resolves.toEqual({
			target: 'operations',
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
			'safety-copy',
			'safety-sha',
			'recreate',
			'restore',
			'acl',
			'ledger'
		]);
		expect(process.createSafetyCopy).toHaveBeenCalledWith(
			connection,
			'operations',
			'/restore/job.dump.safety'
		);
		expect(artifacts.assertTableOfContents).toHaveBeenCalledWith(
			'toc',
			target
		);
	});

	it.each([
		['connection', 'connection', 'connection failed'],
		['source checksum', 'sha256', 'source hash failed'],
		['checksum validation', 'assertChecksum', 'checksum failed'],
		['TOC listing', 'listDump', 'toc failed'],
		['TOC validation', 'assertTableOfContents', 'toc invalid'],
		['safety copy', 'createSafetyCopy', 'safety failed'],
		['safety checksum', 'safetySha256', 'safety hash failed']
	])(
		'propagates a pre-destructive %s error without the safety wrapper',
		async (_label, point, message) => {
			const { service, targets, artifacts, process } = setup();
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
			if (point === 'createSafetyCopy')
				process.createSafetyCopy.mockRejectedValue(new Error(message));
			if (point === 'safetySha256')
				artifacts.sha256
					.mockResolvedValueOnce('source-sha')
					.mockRejectedValueOnce(new Error(message));

			const result = service.restore(input);
			await expect(result).rejects.toThrow(message);
			await expect(result).rejects.not.toThrow(
				'Database restore failed after safety backup'
			);
		}
	);

	it('does not create a safety copy or run destructive commands after TOC rejection', async () => {
		const { service, artifacts, process } = setup();
		artifacts.assertTableOfContents.mockImplementation(() => {
			throw new Error('toc invalid');
		});

		await expect(service.restore(input)).rejects.toThrow('toc invalid');
		expect(process.createSafetyCopy).not.toHaveBeenCalled();
		expect(process.recreateSchema).not.toHaveBeenCalled();
		expect(process.restoreSchema).not.toHaveBeenCalled();
		expect(process.applyAcl).not.toHaveBeenCalled();
		expect(process.verifyMigrationLedger).not.toHaveBeenCalled();
	});

	it.each([
		['schema recreation', 'recreateSchema', ['recreate']],
		['dump restore', 'restoreSchema', ['recreate', 'restore']],
		['ACL application', 'applyAcl', ['recreate', 'restore', 'acl']],
		[
			'ledger query',
			'verifyMigrationLedger',
			['recreate', 'restore', 'acl', 'ledger']
		]
	])(
		'wraps a %s failure with the safety SHA and stops the sequence',
		async (_label, method, destructiveCalls) => {
			const { service, process, calls } = setup();
			(
				process[method as keyof typeof process] as jest.Mock
			).mockImplementation(async () => {
				calls.push(destructiveCalls[destructiveCalls.length - 1]);
				throw new Error('destructive failure');
			});

			await expect(service.restore(input)).rejects.toThrow(
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

		await expect(service.restore(input)).rejects.toThrow(
			'Database restore failed after safety backup safety-sha: Restored database migration ledger is missing'
		);
	});
});
