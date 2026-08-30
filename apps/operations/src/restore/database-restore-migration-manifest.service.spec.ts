import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATABASE_RESTORE_TARGETS } from './database-restore.contract';
import {
	DatabaseRestoreMigrationManifestService,
	parseDatabaseRestoreMigrationManifests
} from './database-restore-migration-manifest.service';

const manifestPath = join(
	__dirname,
	'..',
	'..',
	'restore-manifests',
	'database-restore-migrations.json'
);
const generatorPath = join(
	__dirname,
	'..',
	'..',
	'scripts',
	'database-restore-migration-manifests.mjs'
);

const databaseRows = (service: DatabaseRestoreMigrationManifestService) =>
	service.get('reporting').migrations.map(migration => ({
		migrationName: migration.name,
		checksum: migration.checksum,
		finished: true,
		rolledBack: false,
		appliedStepsCount: 1
	}));

const dumpLedger = (service: DatabaseRestoreMigrationManifestService) => {
	const rows = service
		.get('reporting')
		.migrations.map(
			(migration, index) =>
				`${index}\t${migration.checksum}\t2026-08-30 10:00:00+00\t${migration.name}\t\\N\t\\N\t2026-08-30 09:59:00+00\t1`
		)
		.join('\n');
	return [
		'-- PostgreSQL database dump',
		'COPY reporting._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;',
		rows,
		'\\.',
		'-- PostgreSQL database dump complete',
		''
	].join('\n');
};

describe('DatabaseRestoreMigrationManifestService', () => {
	it('keeps the generated manifest synchronized with all seven service-owned migration directories', () => {
		const result = spawnSync(
			process.execPath,
			[generatorPath, '--check'],
			{
				encoding: 'utf8'
			}
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const service = new DatabaseRestoreMigrationManifestService();
		expect(
			DATABASE_RESTORE_TARGETS.map(target => service.get(target).target)
		).toEqual(DATABASE_RESTORE_TARGETS);
	});

	it('rejects a generated manifest whose migration checksum drifts', () => {
		const value = JSON.parse(readFileSync(manifestPath, 'utf8'));
		value.targets.reporting.migrations[0].checksum = 'f'.repeat(64);

		expect(() => parseDatabaseRestoreMigrationManifests(value)).toThrow(
			'Migration manifest SHA-256 for reporting is invalid'
		);
	});

	it('binds jobs to the exact target manifest SHA', () => {
		const service = new DatabaseRestoreMigrationManifestService();

		expect(() =>
			service.assertBinding('reporting', service.sha256('reporting'))
		).not.toThrow();
		expect(() =>
			service.assertBinding('reporting', 'f'.repeat(64))
		).toThrow('does not match this Operations revision');
	});

	it('accepts exact successful source and restored ledgers', () => {
		const service = new DatabaseRestoreMigrationManifestService();

		expect(() =>
			service.assertDumpLedger(
				'reporting',
				'reporting',
				dumpLedger(service)
			)
		).not.toThrow();
		expect(() =>
			service.assertDatabaseLedger(
				'reporting',
				JSON.stringify(databaseRows(service))
			)
		).not.toThrow();
	});

	it('allows fully rolled-back history but requires the exact successful set', () => {
		const service = new DatabaseRestoreMigrationManifestService();
		const rows = databaseRows(service);
		rows.push({
			migrationName: '20260830000000_rolled_back_attempt',
			checksum: 'e'.repeat(64),
			finished: false,
			rolledBack: true,
			appliedStepsCount: 0
		});

		expect(() =>
			service.assertDatabaseLedger('reporting', JSON.stringify(rows))
		).not.toThrow();
	});

	it.each([
		[
			'checksum drift',
			(rows: ReturnType<typeof databaseRows>) => {
				rows[0].checksum = 'f'.repeat(64);
			}
		],
		[
			'missing migration',
			(rows: ReturnType<typeof databaseRows>) => {
				rows.pop();
			}
		],
		[
			'unexpected migration',
			(rows: ReturnType<typeof databaseRows>) => {
				rows.push({
					migrationName: '20260830120000_untrusted',
					checksum: 'e'.repeat(64),
					finished: true,
					rolledBack: false,
					appliedStepsCount: 1
				});
			}
		],
		[
			'duplicate successful migration',
			(rows: ReturnType<typeof databaseRows>) => {
				rows.push({ ...rows[0] });
			}
		],
		[
			'unresolved migration',
			(rows: ReturnType<typeof databaseRows>) => {
				rows[0].finished = false;
			}
		]
	])('rejects restored ledger %s', (_label, mutate) => {
		const service = new DatabaseRestoreMigrationManifestService();
		const rows = databaseRows(service);
		mutate(rows);

		expect(() =>
			service.assertDatabaseLedger('reporting', JSON.stringify(rows))
		).toThrow(/Migration ledger for reporting/);
	});

	it('fails closed when source ledger COPY is missing, duplicated, or incomplete', () => {
		const service = new DatabaseRestoreMigrationManifestService();
		const valid = dumpLedger(service);

		expect(() =>
			service.assertDumpLedger('reporting', 'reporting', '-- no ledger')
		).toThrow('exactly one');
		expect(() =>
			service.assertDumpLedger(
				'reporting',
				'reporting',
				`${valid}\n${valid}`
			)
		).toThrow('exactly one');
		expect(() =>
			service.assertDumpLedger(
				'reporting',
				'reporting',
				valid.slice(0, valid.indexOf('\\.\n')).trimEnd()
			)
		).toThrow('COPY block is incomplete');
	});
});
