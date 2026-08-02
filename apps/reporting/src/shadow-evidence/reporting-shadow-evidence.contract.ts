import { REPORTING_PROJECTION_STREAMS } from '../projections/reporting-event.contract';
import type { ReportingProjectionStream } from '../projections/reporting-event.contract';
import { createHash } from 'node:crypto';

export const REPORTING_SHADOW_CHECK_NAMES = [
	'counts',
	'totals',
	'periods',
	'checksums'
] as const;

export type ReportingShadowCheckName =
	(typeof REPORTING_SHADOW_CHECK_NAMES)[number];

export type ReportingShadowJson =
	| null
	| boolean
	| number
	| string
	| ReportingShadowJson[]
	| { [key: string]: ReportingShadowJson };

export interface ReportingShadowCheck {
	name: ReportingShadowCheckName;
	coreValue: ReportingShadowJson;
	reportingValue: ReportingShadowJson;
	coreSha256: string;
	reportingSha256: string;
	match: true;
}

export interface ReportingShadowEvidence {
	schema: 'winwidget.reporting.shadow-evidence';
	version: 2;
	algorithm: 'projection-and-metrics-v1';
	revision: string;
	imageId: string;
	comparedAt: string;
	periodPolicy: {
		asOf: string;
		dashboardTimezone: 'UTC';
		dailySummaryTimezone: 'Europe/Moscow';
	};
	source: {
		kind: 'core-postgresql';
		database: 'default_db';
		systemIdentifier: string;
		snapshotId: string;
		snapshotSha256: string;
		recordCount: number;
		watermarks: Record<ReportingProjectionStream, string>;
	};
	target: {
		kind: 'reporting-postgresql';
		database: 'winwidget_reporting';
		role: 'winwidget_reporting_backup';
		systemIdentifier: string;
		backfillSnapshotId: string;
		backfillSha256: string;
		transactionSnapshotSha256: string;
		watermarks: Record<ReportingProjectionStream, string>;
	};
	checks: ReportingShadowCheck[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,64})$/;

export function canonicalReportingShadowJson(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error('Shadow evidence contains a non-finite number');
		}
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value
			.map(item => canonicalReportingShadowJson(item))
			.join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				key =>
					`${JSON.stringify(key)}:${canonicalReportingShadowJson(record[key])}`
			)
			.join(',')}}`;
	}
	throw new Error('Shadow evidence contains a non-JSON value');
}

export function reportingShadowSha256(value: unknown): string {
	return createHash('sha256')
		.update(canonicalReportingShadowJson(value), 'utf8')
		.digest('hex');
}

export function serializeReportingShadowEvidence(
	evidence: ReportingShadowEvidence
): string {
	assertReportingShadowEvidence(evidence);
	return `${canonicalReportingShadowJson(evidence)}\n`;
}

export function parseReportingShadowEvidence(
	input: string
): ReportingShadowEvidence {
	if (Buffer.byteLength(input, 'utf8') > 2 * 1024 * 1024) {
		throw new Error('Shadow evidence exceeds the 2 MiB limit');
	}
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error('Shadow evidence is not valid JSON');
	}
	assertReportingShadowEvidence(value);
	const evidence = value as ReportingShadowEvidence;
	if (input !== `${canonicalReportingShadowJson(evidence)}\n`) {
		throw new Error(
			'Shadow evidence must use canonical JSON and exactly one final LF'
		);
	}
	return evidence;
}

export function assertReportingShadowEvidence(
	value: unknown
): asserts value is ReportingShadowEvidence {
	const evidence = exactRecord(value, [
		'schema',
		'version',
		'algorithm',
		'revision',
		'imageId',
		'comparedAt',
		'periodPolicy',
		'source',
		'target',
		'checks'
	]);
	if (
		evidence.schema !== 'winwidget.reporting.shadow-evidence' ||
		evidence.version !== 2 ||
		evidence.algorithm !== 'projection-and-metrics-v1'
	) {
		throw new Error(
			'Shadow evidence schema, version or algorithm is invalid'
		);
	}
	assertPattern(evidence.revision, REVISION_PATTERN, 'revision');
	assertPattern(evidence.imageId, IMAGE_ID_PATTERN, 'imageId');
	assertIso(evidence.comparedAt, 'comparedAt');

	const periodPolicy = exactRecord(evidence.periodPolicy, [
		'asOf',
		'dashboardTimezone',
		'dailySummaryTimezone'
	]);
	assertIso(periodPolicy.asOf, 'periodPolicy.asOf');
	if (
		periodPolicy.asOf !== evidence.comparedAt ||
		periodPolicy.dashboardTimezone !== 'UTC' ||
		periodPolicy.dailySummaryTimezone !== 'Europe/Moscow'
	) {
		throw new Error('Shadow evidence period policy is invalid');
	}

	const source = exactRecord(evidence.source, [
		'kind',
		'database',
		'systemIdentifier',
		'snapshotId',
		'snapshotSha256',
		'recordCount',
		'watermarks'
	]);
	if (
		source.kind !== 'core-postgresql' ||
		source.database !== 'default_db'
	) {
		throw new Error('Shadow evidence Core identity is invalid');
	}
	assertPattern(
		source.systemIdentifier,
		DECIMAL_PATTERN,
		'source.systemIdentifier'
	);
	assertPattern(source.snapshotId, UUID_PATTERN, 'source.snapshotId');
	assertPattern(
		source.snapshotSha256,
		SHA256_PATTERN,
		'source.snapshotSha256'
	);
	if (
		typeof source.recordCount !== 'number' ||
		!Number.isSafeInteger(source.recordCount) ||
		source.recordCount < 0
	) {
		throw new Error('source.recordCount is invalid');
	}
	assertWatermarks(source.watermarks, 'source.watermarks');

	const target = exactRecord(evidence.target, [
		'kind',
		'database',
		'role',
		'systemIdentifier',
		'backfillSnapshotId',
		'backfillSha256',
		'transactionSnapshotSha256',
		'watermarks'
	]);
	if (
		target.kind !== 'reporting-postgresql' ||
		target.database !== 'winwidget_reporting' ||
		target.role !== 'winwidget_reporting_backup'
	) {
		throw new Error('Shadow evidence Reporting identity is invalid');
	}
	assertPattern(
		target.systemIdentifier,
		DECIMAL_PATTERN,
		'target.systemIdentifier'
	);
	assertPattern(
		target.backfillSnapshotId,
		UUID_PATTERN,
		'target.backfillSnapshotId'
	);
	assertPattern(
		target.backfillSha256,
		SHA256_PATTERN,
		'target.backfillSha256'
	);
	assertPattern(
		target.transactionSnapshotSha256,
		SHA256_PATTERN,
		'target.transactionSnapshotSha256'
	);
	assertWatermarks(target.watermarks, 'target.watermarks');
	if (
		canonicalReportingShadowJson(source.watermarks) !==
		canonicalReportingShadowJson(target.watermarks)
	) {
		throw new Error('Core and Reporting watermarks differ');
	}

	if (
		!Array.isArray(evidence.checks) ||
		evidence.checks.length !== REPORTING_SHADOW_CHECK_NAMES.length
	) {
		throw new Error('Shadow evidence checks are incomplete');
	}
	for (
		let index = 0;
		index < REPORTING_SHADOW_CHECK_NAMES.length;
		index += 1
	) {
		const check = exactRecord(evidence.checks[index], [
			'name',
			'coreValue',
			'reportingValue',
			'coreSha256',
			'reportingSha256',
			'match'
		]);
		if (
			check.name !== REPORTING_SHADOW_CHECK_NAMES[index] ||
			check.match !== true
		) {
			throw new Error(
				'Shadow evidence check order or match flag is invalid'
			);
		}
		assertJson(check.coreValue, `checks.${check.name}.coreValue`);
		assertJson(
			check.reportingValue,
			`checks.${check.name}.reportingValue`
		);
		assertPattern(
			check.coreSha256,
			SHA256_PATTERN,
			`checks.${check.name}.coreSha256`
		);
		assertPattern(
			check.reportingSha256,
			SHA256_PATTERN,
			`checks.${check.name}.reportingSha256`
		);
		if (
			check.coreSha256 !== reportingShadowSha256(check.coreValue) ||
			check.reportingSha256 !==
				reportingShadowSha256(check.reportingValue) ||
			check.coreSha256 !== check.reportingSha256 ||
			canonicalReportingShadowJson(check.coreValue) !==
				canonicalReportingShadowJson(check.reportingValue)
		) {
			throw new Error(`Shadow evidence ${String(check.name)} mismatch`);
		}
	}
}

function assertWatermarks(value: unknown, path: string): void {
	const record = exactRecord(value, REPORTING_PROJECTION_STREAMS);
	for (const stream of REPORTING_PROJECTION_STREAMS) {
		assertPattern(record[stream], DECIMAL_PATTERN, `${path}.${stream}`);
	}
}

function assertJson(value: unknown, path: string, depth = 0): void {
	if (depth > 20) throw new Error(`${path} is nested too deeply`);
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'string'
	) {
		if (typeof value === 'string' && value.length > 16_384) {
			throw new Error(`${path} string is too large`);
		}
		return;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not finite`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 10_000)
			throw new Error(`${path} array is too large`);
		value.forEach((item, index) =>
			assertJson(item, `${path}.${index}`, depth + 1)
		);
		return;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (Object.keys(record).length > 1_000) {
			throw new Error(`${path} object is too large`);
		}
		for (const [key, item] of Object.entries(record)) {
			if (!key || key.length > 128)
				throw new Error(`${path} key is invalid`);
			assertJson(item, `${path}.${key}`, depth + 1);
		}
		return;
	}
	throw new Error(`${path} is not JSON`);
}

function exactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Shadow evidence object is invalid');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error('Shadow evidence object keys are invalid');
	}
	return record;
}

function assertPattern(
	value: unknown,
	pattern: RegExp,
	path: string
): asserts value is string {
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new Error(`${path} is invalid`);
	}
}

function assertIso(value: unknown, path: string): asserts value is string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error(`${path} must be a canonical UTC timestamp`);
	}
}
