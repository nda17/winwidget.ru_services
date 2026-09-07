import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DATABASE_RESTORE_TARGETS,
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
} from '../restore/database-restore.contract';
import { parseDatabaseRestoreMigrationManifests } from '../restore/database-restore-migration-manifest.service';
import {
	DATABASE_BACKUP_TARGETS,
	DATABASE_BACKUP_DELAY_MINUTES,
	databaseBackupJobType
} from '../scheduled-jobs/scheduled-jobs.types';
import {
	DATABASE_BACKUP_MAX_FILE_SIZE_BYTES,
	DATABASE_BACKUP_PROVENANCE_TARGETS
} from './database-backup.contract';
import {
	DatabaseBackupMigrationManifestService,
	parseDatabaseBackupMigrationManifests
} from './database-backup-migration-manifest.service';

const appDirectory = join(__dirname, '..', '..');
const backupPath = join(
	appDirectory,
	'backup-manifests',
	'database-backup-migrations.json'
);
const restorePath = join(
	appDirectory,
	'restore-manifests',
	'database-restore-migrations.json'
);
type RawManifest = {
	schemaVersion: number;
	targets: Record<
		string,
		{
			manifestSha256: string;
			migrations: Array<{
				name: string;
				checksum: string;
				extra?: boolean;
			}>;
		}
	>;
	extra?: boolean;
};
const read = (path: string): RawManifest =>
	JSON.parse(readFileSync(path, 'utf8')) as RawManifest;

describe('backup-only target and migration registry', () => {
	it('preserves nine job types and offsets, appending four CRM targets', () => {
		expect(DATABASE_BACKUP_TARGETS).toEqual([
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform',
			'support',
			'operations',
			'crm-access',
			'crm-intake',
			'crm-customers',
			'crm-sales'
		]);
		expect(
			DATABASE_BACKUP_TARGETS.map(
				target => DATABASE_BACKUP_DELAY_MINUTES[target]
			)
		).toEqual([15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195]);
		expect(DATABASE_BACKUP_TARGETS.map(databaseBackupJobType)).toEqual([
			'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
			'CAMPAIGNS_DATABASE_BACKUP',
			'REPORTING_DATABASE_BACKUP',
			'WIDGETS_DATABASE_BACKUP',
			'BILLING_DATABASE_BACKUP',
			'IDENTITY_DATABASE_BACKUP',
			'PLATFORM_DATABASE_BACKUP',
			'SUPPORT_DATABASE_BACKUP',
			'OPERATIONS_DATABASE_BACKUP',
			'CRM_ACCESS_DATABASE_BACKUP',
			'CRM_INTAKE_DATABASE_BACKUP',
			'CRM_CUSTOMERS_DATABASE_BACKUP',
			'CRM_SALES_DATABASE_BACKUP'
		]);
	});

	it('keeps exactly seven restore targets and eleven independently signed targets', () => {
		expect(DATABASE_RESTORE_TARGETS).toEqual([
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'identity',
			'platform',
			'support'
		]);
		expect(DATABASE_BACKUP_PROVENANCE_TARGETS).toEqual([
			...DATABASE_RESTORE_TARGETS,
			'crm-access',
			'crm-intake',
			'crm-customers',
			'crm-sales'
		]);
		expect(DATABASE_BACKUP_MAX_FILE_SIZE_BYTES).toBe(
			DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
		);
		expect(() =>
			parseDatabaseRestoreMigrationManifests(read(backupPath))
		).toThrow('targets has an invalid shape');
	});

	it('preserves every legacy manifest digest and migration byte checksum', () => {
		const restore = parseDatabaseRestoreMigrationManifests(
			read(restorePath)
		);
		const backup = parseDatabaseBackupMigrationManifests(read(backupPath));
		for (const target of DATABASE_RESTORE_TARGETS)
			expect(backup[target]).toEqual(restore[target]);
		for (const target of DATABASE_BACKUP_PROVENANCE_TARGETS) {
			for (const migration of backup[target].migrations) {
				const source = readFileSync(
					join(
						appDirectory,
						'..',
						target,
						'prisma',
						'migrations',
						migration.name,
						'migration.sql'
					)
				);
				expect(migration.checksum).toBe(
					createHash('sha256').update(source).digest('hex')
				);
				expect(Object.isFrozen(migration)).toBe(true);
			}
			expect(
				new DatabaseBackupMigrationManifestService().sha256(target)
			).toBe(backup[target].manifestSha256);
			expect(Object.isFrozen(backup[target].migrations)).toBe(true);
		}
		expect(Object.isFrozen(backup)).toBe(true);
	});

	it('runs both existing and new CLI checks without rewriting either artifact', () => {
		const before = [readFileSync(restorePath), readFileSync(backupPath)];
		for (const kind of ['restore', 'backup']) {
			const script = join(
				appDirectory,
				'scripts',
				`database-${kind}-migration-manifests.mjs`
			);
			expect(
				execFileSync(process.execPath, [script, '--check'], {
					encoding: 'utf8'
				})
			).toBe('');
			expect(
				execFileSync(process.execPath, [script], { encoding: 'utf8' })
			).toBe('');
		}
		expect(readFileSync(restorePath)).toEqual(before[0]);
		expect(readFileSync(backupPath)).toEqual(before[1]);
	});

	it.each([
		[
			'unknown root field',
			(value: RawManifest) => {
				value.extra = true;
			}
		],
		[
			'version drift',
			(value: RawManifest) => {
				value.schemaVersion = 2;
			}
		],
		[
			'missing CRM target',
			(value: RawManifest) => {
				delete value.targets['crm-sales'];
			}
		],
		[
			'unsigned target',
			(value: RawManifest) => {
				value.targets.billing = value.targets.widgets;
			}
		],
		[
			'empty entries',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations = [];
			}
		],
		[
			'unknown entry field',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations[0].extra = true;
			}
		],
		[
			'unsafe name',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations[0].name = '../migration.sql';
			}
		],
		[
			'invalid checksum',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations[0].checksum = '0';
			}
		],
		[
			'changed source digest',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations[0].checksum = 'f'.repeat(64);
			}
		],
		[
			'changed manifest digest',
			(value: RawManifest) => {
				value.targets['crm-sales'].manifestSha256 = 'f'.repeat(64);
			}
		],
		[
			'duplicate migration',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations.push(
					value.targets['crm-sales'].migrations[0]
				);
			}
		],
		[
			'reordered migrations',
			(value: RawManifest) => {
				value.targets['crm-sales'].migrations.reverse();
			}
		],
		[
			'swapped target',
			(value: RawManifest) => {
				value.targets['crm-access'] = value.targets['crm-sales'];
			}
		]
	])('rejects %s', (_label, mutate) => {
		const invalid = read(backupPath);
		mutate(invalid);
		expect(() => parseDatabaseBackupMigrationManifests(invalid)).toThrow();
	});
});
