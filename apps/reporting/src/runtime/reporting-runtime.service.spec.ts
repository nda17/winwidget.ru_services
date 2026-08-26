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
});
