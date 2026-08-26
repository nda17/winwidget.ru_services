import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
	REPORTING_PROCESS_ROLES,
	parseReportingProcessRole
} from './reporting-runtime.service';

describe('Reporting process roles', () => {
	it('contains only steady-state service roles', () => {
		expect(REPORTING_PROCESS_ROLES).toEqual([
			'all',
			'api',
			'worker',
			'publisher',
			'scheduler'
		]);
	});

	it('rejects the retired backfill role', () => {
		expect(() => parseReportingProcessRole('backfill')).toThrow(
			'REPORTING_PROCESS_ROLE'
		);
	});

	it('removes legacy backfill heartbeats before tightening the database role constraint', () => {
		const migration = readFileSync(
			resolve(
				process.cwd(),
				'prisma/migrations/20260826020000_remove_core_runtime_dependencies/migration.sql'
			),
			'utf8'
		);
		const cleanup = `DELETE FROM reporting."heartbeats"\nWHERE "role" = 'backfill';`;
		const constraint = 'ALTER TABLE reporting."heartbeats"';

		expect(migration).toContain(cleanup);
		expect(migration.indexOf(cleanup)).toBeLessThan(
			migration.indexOf(constraint)
		);
	});
});
