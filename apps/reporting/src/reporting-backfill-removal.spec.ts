import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('retired Reporting backfill data surface', () => {
	const schema = readFileSync(
		join(__dirname, '../prisma/schema.prisma'),
		'utf8'
	);
	const migration = readFileSync(
		join(
			__dirname,
			'../prisma/migrations/20260815000000_remove_retired_backfill_runs/migration.sql'
		),
		'utf8'
	);

	it('removes the backfill model and enum from the generated client', () => {
		expect(schema).not.toContain('model ReportingBackfillRun');
		expect(schema).not.toContain('enum ReportingBackfillStatus');
		expect(schema).not.toContain('@@map("backfill_runs")');
	});

	it('removes the retired data and role in one non-cascading transaction', () => {
		expect(migration).toContain(
			'DELETE FROM reporting."heartbeats" WHERE "role" = \'backfill\';'
		);
		expect(migration).toContain(
			'DROP TABLE IF EXISTS reporting."backfill_runs";'
		);
		expect(migration).toContain(
			'DROP TYPE IF EXISTS reporting."ReportingBackfillStatus";'
		);
		expect(migration).toContain(
			"\"role\" IN ('all', 'api', 'worker', 'publisher', 'scheduler')"
		);
		expect(migration).not.toContain("'backfill')");
		expect(migration.trim().startsWith('BEGIN;')).toBe(true);
		expect(migration.trim().endsWith('COMMIT;')).toBe(true);
		expect(migration).not.toContain('CASCADE');
	});
});
