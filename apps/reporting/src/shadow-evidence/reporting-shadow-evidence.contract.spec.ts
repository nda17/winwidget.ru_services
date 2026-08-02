import {
	ReportingShadowEvidence,
	parseReportingShadowEvidence,
	reportingShadowSha256,
	serializeReportingShadowEvidence
} from './reporting-shadow-evidence.contract';

function evidence(): ReportingShadowEvidence {
	const emptyHash = reportingShadowSha256({});
	return {
		schema: 'winwidget.reporting.shadow-evidence',
		version: 2,
		algorithm: 'projection-and-metrics-v1',
		revision: '0123456789abcdef0123456789abcdef01234567',
		imageId: `sha256:${'a'.repeat(64)}`,
		comparedAt: '2026-08-01T00:00:00.000Z',
		periodPolicy: {
			asOf: '2026-08-01T00:00:00.000Z',
			dashboardTimezone: 'UTC',
			dailySummaryTimezone: 'Europe/Moscow'
		},
		source: {
			kind: 'core-postgresql',
			database: 'default_db',
			systemIdentifier: '1',
			snapshotId: '00000000-0000-4000-8000-000000000001',
			snapshotSha256: 'b'.repeat(64),
			recordCount: 0,
			watermarks: watermarks()
		},
		target: {
			kind: 'reporting-postgresql',
			database: 'winwidget_reporting',
			role: 'winwidget_reporting_backup',
			systemIdentifier: '2',
			backfillSnapshotId: '00000000-0000-4000-8000-000000000002',
			backfillSha256: 'c'.repeat(64),
			transactionSnapshotSha256: 'd'.repeat(64),
			watermarks: watermarks()
		},
		checks: ['counts', 'totals', 'periods', 'checksums'].map(name => ({
			name: name as 'counts' | 'totals' | 'periods' | 'checksums',
			coreValue: {},
			reportingValue: {},
			coreSha256: emptyHash,
			reportingSha256: emptyHash,
			match: true
		}))
	};
}

function watermarks() {
	return {
		identityUser: '0',
		billingPayment: '0',
		billingSubscription: '0',
		widget: '0',
		lead: '0',
		reportingSettings: '0'
	};
}

describe('Reporting shadow evidence v2 contract', () => {
	it('round-trips only canonical JSON with one final LF', () => {
		const serialized = serializeReportingShadowEvidence(evidence());
		expect(serialized.endsWith('\n')).toBe(true);
		expect(parseReportingShadowEvidence(serialized)).toEqual(evidence());
		expect(() => parseReportingShadowEvidence(serialized.trim())).toThrow(
			'canonical JSON'
		);
		expect(() => parseReportingShadowEvidence(` ${serialized}`)).toThrow(
			'canonical JSON'
		);
	});

	it('rejects a self-declared hash that was not recomputed from values', () => {
		const forged = evidence();
		forged.checks[0].coreValue = { users: 1 };
		expect(() =>
			parseReportingShadowEvidence(`${JSON.stringify(forged)}\n`)
		).toThrow();
	});

	it('rejects different real Core and Reporting values', () => {
		const forged = evidence();
		forged.checks[1].coreValue = { revenue: 10 };
		forged.checks[1].reportingValue = { revenue: 11 };
		forged.checks[1].coreSha256 = reportingShadowSha256(
			forged.checks[1].coreValue
		);
		forged.checks[1].reportingSha256 = reportingShadowSha256(
			forged.checks[1].reportingValue
		);
		expect(() => serializeReportingShadowEvidence(forged)).toThrow(
			'totals mismatch'
		);
	});

	it('rejects watermark drift and extra provenance keys', () => {
		const drifted = evidence();
		drifted.target.watermarks.lead = '1';
		expect(() => serializeReportingShadowEvidence(drifted)).toThrow(
			'watermarks differ'
		);

		const extra = evidence() as ReportingShadowEvidence & {
			token?: string;
		};
		extra.token = 'must-not-be-accepted';
		expect(() => serializeReportingShadowEvidence(extra)).toThrow(
			'object keys'
		);
	});
});
