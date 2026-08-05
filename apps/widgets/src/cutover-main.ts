import { Prisma } from '@prisma/widgets-client';
import { createHash } from 'node:crypto';
import { WidgetsPrismaService } from './prisma/widgets-prisma.service';
import {
	ReportingAggregateSeed,
	WidgetsReportingSequenceService
} from './reporting/widgets-reporting-sequence.service';

const SCHEMA_VERSION = 1;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RECORDS = 10_000_000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const TABLES = [
	'widgets',
	'quizzes',
	'callbacks',
	'countdown_timers',
	'stop_offers',
	'online_consultants',
	'calculators',
	'leads',
	'quiz_leads',
	'callback_leads',
	'countdown_timer_leads',
	'stop_offer_leads',
	'online_consultant_leads',
	'calculator_leads',
	'widget_config_revisions',
	'widget_runtime_presence',
	'widget_runtime_daily_metrics',
	'widget_runtime_daily_step_metrics'
] as const;

type TableName = (typeof TABLES)[number];
type SnapshotCounts = Record<string, number>;
type JsonRecord = Record<string, unknown>;

interface Manifest {
	recordType: 'manifest';
	schemaVersion: 1;
	sourceDatabaseFingerprint: string;
	sourceExportedAt: string;
	reportingSourceHighWater: string;
	counts: SnapshotCounts;
}

interface ParsedLine {
	value: JsonRecord;
	canonical: string;
}

class CutoverError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 2 | 3 = 2
	) {
		super(message);
		this.name = 'CutoverError';
	}
}

const command = process.argv[2] || '';
let prisma!: WidgetsPrismaService;
let reporting!: WidgetsReportingSequenceService;
const SUPPORTED_COMMANDS = new Set([
	'import-snapshot',
	'begin-handoff',
	'activate-ownership',
	'verify-steady'
]);

async function main(): Promise<void> {
	try {
		if (!SUPPORTED_COMMANDS.has(command)) {
			throw new CutoverError(
				'COMMAND',
				'Command must be import-snapshot, begin-handoff, activate-ownership, or verify-steady'
			);
		}
		prisma = new WidgetsPrismaService();
		reporting = new WidgetsReportingSequenceService(prisma);
		await prisma.$connect();
		let result: JsonRecord;
		if (command === 'import-snapshot') result = await importSnapshot();
		else if (command === 'begin-handoff') result = await beginHandoff();
		else if (command === 'activate-ownership')
			result = await activateOwnership();
		else result = await verifySteady();
		process.stdout.write(`${JSON.stringify({ command, ...result })}\n`);
	} catch (error) {
		const known = error instanceof CutoverError;
		process.stderr.write(
			`${JSON.stringify({
				status: 'error',
				command: command || 'unknown',
				code: known ? error.code : 'CUTOVER_FAILED',
				message: known ? error.message : 'Widgets cutover command failed'
			})}\n`
		);
		process.exitCode = known ? error.exitCode : 1;
	} finally {
		if (prisma) await prisma.disconnect().catch(() => undefined);
	}
}

void main();

async function importSnapshot(): Promise<JsonRecord> {
	const records = parsedLines()[Symbol.asyncIterator]();
	const first = await records.next();
	if (first.done)
		throw new CutoverError(
			'MANIFEST_MISSING',
			'Snapshot manifest is missing'
		);
	const manifest = parseManifest(first.value.value);
	const hash = createHash('sha256');
	hash.update(`${first.value.canonical}\n`);
	let recordCount = 1;

	return prisma.$transaction(
		async transaction => {
			await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(hashtextextended('widgets-cutover-import', 0))
		`;
			const identity = await transaction.widgetsServiceIdentity.findUnique(
				{
					where: { id: 'widgets-service' }
				}
			);
			if (identity?.ownershipActivatedAt) {
				throw new CutoverError(
					'ALREADY_ACTIVE',
					'Widgets ownership is already active',
					3
				);
			}
			if (
				identity?.sourceDatabaseFingerprint &&
				identity.sourceDatabaseFingerprint !==
					manifest.sourceDatabaseFingerprint
			) {
				throw new CutoverError(
					'SOURCE_CONFLICT',
					'Imported source database fingerprint conflicts with the marker',
					3
				);
			}
			if (
				identity?.sourceExportedAt &&
				identity.sourceExportedAt.toISOString() !==
					manifest.sourceExportedAt
			) {
				throw new CutoverError(
					'EXPORT_CONFLICT',
					'Imported source export timestamp conflicts with the marker',
					3
				);
			}
			const existingImport = Boolean(identity?.sourceSnapshotSha256);
			if (!existingImport) await assertImportTargetEmpty(transaction);

			const observed = emptyCounts();
			const widgetAnchors: ReportingAggregateSeed[] = [];
			let phase = 0;
			let lastTableIndex = -1;
			let lastKey = '';
			let lastProjectionKey = '';
			let trailer: JsonRecord | null = null;

			for (;;) {
				const next = await records.next();
				if (next.done) break;
				const parsed = next.value;
				const recordType = stringField(parsed.value, 'recordType');
				if (recordType === 'trailer') {
					trailer = parsed.value;
					const afterTrailer = await records.next();
					if (!afterTrailer.done) {
						throw new CutoverError(
							'TRAILER_ORDER',
							'Snapshot trailer must be the final record'
						);
					}
					break;
				}
				hash.update(`${parsed.canonical}\n`);
				recordCount += 1;
				if (recordCount > MAX_RECORDS) {
					throw new CutoverError(
						'RECORD_LIMIT',
						'Snapshot record limit is exceeded'
					);
				}

				if (recordType === 'table-row') {
					if (phase > 0)
						throw new CutoverError(
							'RECORD_ORDER',
							'Domain table records are out of order'
						);
					const table = stringField(parsed.value, 'table') as TableName;
					const tableIndex = TABLES.indexOf(table);
					if (tableIndex < 0 || tableIndex < lastTableIndex) {
						throw new CutoverError(
							'TABLE_ORDER',
							'Snapshot table order is invalid'
						);
					}
					const key = stringField(parsed.value, 'key');
					if (tableIndex !== lastTableIndex) {
						lastTableIndex = tableIndex;
						lastKey = '';
					}
					if (key <= lastKey)
						throw new CutoverError(
							'ROW_ORDER',
							'Snapshot table keys are not strictly ordered'
						);
					lastKey = key;
					const row = objectField(parsed.value, 'row');
					if (String(row.id || '') !== key) {
						throw new CutoverError(
							'ROW_KEY',
							'Snapshot row key does not match its primary key'
						);
					}
					observed[table] += 1;
					if (!existingImport)
						await createTableRow(transaction, table, row);
					continue;
				}

				const expectedPhase = recordPhase(recordType);
				if (expectedPhase < 1 || expectedPhase < phase) {
					throw new CutoverError(
						'RECORD_ORDER',
						'Snapshot record order is invalid'
					);
				}
				if (expectedPhase !== phase) {
					phase = expectedPhase;
					lastProjectionKey = '';
				}
				const row = objectField(parsed.value, 'row');
				const orderKey = projectionOrderKey(recordType, row);
				if (orderKey <= lastProjectionKey) {
					throw new CutoverError(
						'PROJECTION_ORDER',
						'Snapshot projection keys are not strictly ordered'
					);
				}
				lastProjectionKey = orderKey;
				const countKey = countKeyForRecord(recordType);
				observed[countKey] += 1;
				if (existingImport) continue;
				if (recordType === 'owner-projection')
					await createOwnerProjection(transaction, row);
				else if (recordType === 'entitlement-projection')
					await createEntitlementProjection(transaction, row);
				else if (recordType === 'usage-counter')
					await createUsageCounter(transaction, row);
				else if (recordType === 'usage-ledger')
					await createUsageLedger(transaction, row);
				else if (recordType === 'aggregate-version') {
					const aggregate = aggregateSeed(row);
					if (aggregate.aggregateType.startsWith('widgets.'))
						widgetAnchors.push(aggregate);
					else await createProjectionAnchor(transaction, aggregate);
				}
			}

			if (!trailer)
				throw new CutoverError(
					'TRAILER_MISSING',
					'Snapshot trailer is missing'
				);
			const contentSha256 = hash.digest('hex');
			validateTrailer(
				trailer,
				manifest,
				observed,
				recordCount,
				contentSha256
			);
			if (existingImport) {
				if (identity?.sourceSnapshotSha256 !== contentSha256) {
					throw new CutoverError(
						'SNAPSHOT_CONFLICT',
						'Snapshot hash conflicts with the imported marker',
						3
					);
				}
				await assertTargetCounts(transaction, manifest.counts);
				return successImport('already-imported', manifest, contentSha256);
			}

			await reporting.seedInTransaction(transaction, {
				sourceDatabaseFingerprint: manifest.sourceDatabaseFingerprint,
				sourceExportedAt: manifest.sourceExportedAt,
				sourceSnapshotSha256: contentSha256,
				sourceSnapshotCounts: manifest.counts,
				sourceSequenceHighWater: manifest.reportingSourceHighWater,
				aggregates: widgetAnchors
			});
			await assertTargetCounts(transaction, manifest.counts);
			return successImport('imported', manifest, contentSha256);
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 10_000,
			timeout: 30 * 60_000
		}
	);
}

async function activateOwnership(): Promise<JsonRecord> {
	return prisma.$transaction(
		async transaction => {
			await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(hashtextextended('widgets-cutover-import', 0))
		`;
			const identity = await transaction.widgetsServiceIdentity.findUnique(
				{
					where: { id: 'widgets-service' }
				}
			);
			assertSeededIdentity(identity);
			if (!identity.handoffStartedAt) {
				throw new CutoverError(
					'HANDOFF_NOT_STARTED',
					'Widgets durable handoff boundary is not active',
					3
				);
			}
			if (identity.ownershipActivatedAt) {
				return {
					status: 'already-activated',
					schemaVersion: SCHEMA_VERSION,
					ownershipGeneration: identity.ownershipGeneration.toString(),
					sourceDatabaseFingerprint:
						identity.sourceDatabaseFingerprint as string
				};
			}
			await assertTargetCounts(
				transaction,
				identity.sourceSnapshotCounts as SnapshotCounts
			);
			const sequence = await transaction.widgetSourceSequence.findUnique({
				where: { id: 'reporting' }
			});
			if (
				!sequence ||
				sequence.lastValue !== identity.sourceReportingHighWater
			) {
				throw new CutoverError(
					'SEQUENCE_CONFLICT',
					'Reporting source sequence changed before ownership activation',
					3
				);
			}
			const activatedAt = new Date();
			const updated = await transaction.widgetsServiceIdentity.updateMany({
				where: {
					id: 'widgets-service',
					ownershipGeneration: 0n,
					handoffStartedAt: { not: null },
					ownershipActivatedAt: null
				},
				data: {
					ownershipGeneration: 1n,
					ownershipActivatedAt: activatedAt
				}
			});
			if (updated.count !== 1)
				throw new CutoverError(
					'ACTIVATION_CONFLICT',
					'Widgets ownership activation changed concurrently',
					3
				);
			return {
				status: 'activated',
				schemaVersion: SCHEMA_VERSION,
				ownershipGeneration: '1',
				sourceDatabaseFingerprint:
					identity.sourceDatabaseFingerprint as string
			};
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 10_000,
			timeout: 60_000
		}
	);
}

async function beginHandoff(): Promise<JsonRecord> {
	return prisma.$transaction(
		async transaction => {
			await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(hashtextextended('widgets-cutover-import', 0))
		`;
			const identity = await transaction.widgetsServiceIdentity.findUnique(
				{
					where: { id: 'widgets-service' }
				}
			);
			assertSeededIdentity(identity);
			if (identity.ownershipActivatedAt) {
				return {
					status: 'already-activated',
					schemaVersion: SCHEMA_VERSION,
					ownershipGeneration: identity.ownershipGeneration.toString()
				};
			}
			await assertTargetCounts(
				transaction,
				identity.sourceSnapshotCounts as SnapshotCounts
			);
			const sequence = await transaction.widgetSourceSequence.findUnique({
				where: { id: 'reporting' }
			});
			if (
				!sequence ||
				sequence.lastValue !== identity.sourceReportingHighWater
			) {
				throw new CutoverError(
					'SEQUENCE_CONFLICT',
					'Reporting source sequence changed before the durable handoff',
					3
				);
			}
			if (identity.handoffStartedAt) {
				return {
					status: 'already-started',
					schemaVersion: SCHEMA_VERSION,
					handoffStartedAt: identity.handoffStartedAt.toISOString()
				};
			}
			const handoffStartedAt = new Date();
			const updated = await transaction.widgetsServiceIdentity.updateMany({
				where: {
					id: 'widgets-service',
					ownershipGeneration: 0n,
					handoffStartedAt: null,
					ownershipActivatedAt: null
				},
				data: { handoffStartedAt }
			});
			if (updated.count !== 1) {
				throw new CutoverError(
					'HANDOFF_CONFLICT',
					'Widgets durable handoff boundary changed concurrently',
					3
				);
			}
			return {
				status: 'started',
				schemaVersion: SCHEMA_VERSION,
				handoffStartedAt: handoffStartedAt.toISOString()
			};
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			maxWait: 10_000,
			timeout: 60_000
		}
	);
}

async function verifySteady(): Promise<JsonRecord> {
	return prisma.$transaction(
		async transaction => {
			const identity = await transaction.widgetsServiceIdentity.findUnique(
				{
					where: { id: 'widgets-service' }
				}
			);
			assertSeededIdentity(identity);
			if (
				!identity.handoffStartedAt ||
				!identity.ownershipActivatedAt ||
				identity.ownershipGeneration < 1n
			) {
				throw new CutoverError(
					'NOT_ACTIVE',
					'Widgets ownership is not active',
					3
				);
			}
			const counts = await targetCounts(transaction);
			const sequence = await transaction.widgetSourceSequence.findUnique({
				where: { id: 'reporting' }
			});
			if (
				!sequence ||
				sequence.lastValue < (identity.sourceReportingHighWater as bigint)
			) {
				throw new CutoverError(
					'SEQUENCE_CONFLICT',
					'Reporting source sequence is behind the imported high-water',
					3
				);
			}
			return {
				status: 'steady',
				schemaVersion: SCHEMA_VERSION,
				counts,
				contentSha256: identity.sourceSnapshotSha256 as string,
				sourceDatabaseFingerprint:
					identity.sourceDatabaseFingerprint as string,
				reportingSourceHighWater: (
					identity.sourceReportingHighWater as bigint
				).toString(),
				currentReportingSourceSequence: sequence.lastValue.toString(),
				ownershipGeneration: identity.ownershipGeneration.toString()
			};
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
			maxWait: 10_000,
			timeout: 60_000
		}
	);
}

async function* parsedLines(): AsyncGenerator<ParsedLine> {
	let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let streamBytes = 0;
	for await (const value of process.stdin) {
		const chunk = Buffer.isBuffer(value)
			? value
			: Buffer.from(value as string);
		streamBytes += chunk.length;
		if (streamBytes > MAX_STREAM_BYTES)
			throw new CutoverError('STREAM_LIMIT', 'Snapshot exceeds 2 GiB');
		let offset = 0;
		for (;;) {
			const newline = chunk.indexOf(0x0a, offset);
			if (newline < 0) break;
			pending = appendBounded(pending, chunk.subarray(offset, newline));
			yield parseCanonicalLine(pending);
			pending = Buffer.alloc(0);
			offset = newline + 1;
		}
		pending = appendBounded(pending, chunk.subarray(offset));
	}
	if (pending.length)
		throw new CutoverError(
			'FINAL_NEWLINE',
			'Snapshot must end with a newline'
		);
}

function appendBounded(
	left: Buffer<ArrayBufferLike>,
	right: Buffer<ArrayBufferLike>
): Buffer<ArrayBufferLike> {
	if (left.length + right.length > MAX_LINE_BYTES) {
		throw new CutoverError(
			'LINE_LIMIT',
			'Snapshot record exceeds 256 KiB'
		);
	}
	return right.length ? Buffer.concat([left, right]) : left;
}

function parseCanonicalLine(buffer: Buffer): ParsedLine {
	if (!buffer.length || buffer.includes(0x0d))
		throw new CutoverError(
			'JSONL',
			'Snapshot contains an invalid JSONL record'
		);
	const text = buffer.toString('utf8');
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new CutoverError('JSON', 'Snapshot contains invalid JSON');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new CutoverError(
			'RECORD',
			'Snapshot records must be JSON objects'
		);
	}
	const canonical = canonicalJson(value);
	if (canonical !== text)
		throw new CutoverError(
			'CANONICAL_JSON',
			'Snapshot record is not canonical JSON'
		);
	return { value: value as JsonRecord, canonical };
}

function parseManifest(value: JsonRecord): Manifest {
	assertExactKeys(value, [
		'counts',
		'recordType',
		'reportingSourceHighWater',
		'schemaVersion',
		'sourceDatabaseFingerprint',
		'sourceExportedAt'
	]);
	if (
		value.recordType !== 'manifest' ||
		value.schemaVersion !== SCHEMA_VERSION
	) {
		throw new CutoverError(
			'MANIFEST',
			'Snapshot manifest version is unsupported'
		);
	}
	const fingerprint = stringField(value, 'sourceDatabaseFingerprint');
	if (!/^[0-9a-f]{64}$/.test(fingerprint))
		throw new CutoverError(
			'FINGERPRINT',
			'Source database fingerprint is invalid'
		);
	const exportedAt = isoDate(
		stringField(value, 'sourceExportedAt'),
		'sourceExportedAt'
	);
	const highWater = decimal(
		stringField(value, 'reportingSourceHighWater'),
		true,
		'reportingSourceHighWater'
	);
	const counts = parseCounts(objectField(value, 'counts'));
	return {
		recordType: 'manifest',
		schemaVersion: 1,
		sourceDatabaseFingerprint: fingerprint,
		sourceExportedAt: exportedAt.toISOString(),
		reportingSourceHighWater: highWater.toString(),
		counts
	};
}

function validateTrailer(
	value: JsonRecord,
	manifest: Manifest,
	observed: SnapshotCounts,
	records: number,
	sha256: string
): void {
	assertExactKeys(value, [
		'contentSha256',
		'counts',
		'recordType',
		'records',
		'schemaVersion'
	]);
	if (
		value.recordType !== 'trailer' ||
		value.schemaVersion !== SCHEMA_VERSION
	) {
		throw new CutoverError(
			'TRAILER',
			'Snapshot trailer version is unsupported'
		);
	}
	if (integer(value.records, 'trailer.records') !== records) {
		throw new CutoverError(
			'RECORD_COUNT',
			'Snapshot trailer record count does not match'
		);
	}
	const trailerHash = stringField(value, 'contentSha256');
	if (trailerHash !== sha256)
		throw new CutoverError(
			'CONTENT_HASH',
			'Snapshot content hash does not match'
		);
	const trailerCounts = parseCounts(objectField(value, 'counts'));
	if (
		canonicalJson(trailerCounts) !== canonicalJson(manifest.counts) ||
		canonicalJson(observed) !== canonicalJson(manifest.counts)
	) {
		throw new CutoverError(
			'COUNTS',
			'Snapshot counts do not match its records'
		);
	}
}

function parseCounts(value: JsonRecord): SnapshotCounts {
	const expected = [
		...TABLES,
		'ownerProjections',
		'entitlementProjections',
		'usageCounters',
		'usageLedger',
		'aggregateVersions'
	];
	assertExactKeys(value, expected);
	return Object.fromEntries(
		expected.map(key => [key, integer(value[key], `counts.${key}`)])
	);
}

function emptyCounts(): SnapshotCounts {
	return Object.fromEntries(
		[
			...TABLES,
			'ownerProjections',
			'entitlementProjections',
			'usageCounters',
			'usageLedger',
			'aggregateVersions'
		].map(key => [key, 0])
	);
}

function recordPhase(recordType: string): number {
	return (
		(
			{
				'owner-projection': 1,
				'entitlement-projection': 2,
				'usage-counter': 3,
				'usage-ledger': 4,
				'aggregate-version': 5
			} as Record<string, number>
		)[recordType] || -1
	);
}

function countKeyForRecord(recordType: string): string {
	return (
		{
			'owner-projection': 'ownerProjections',
			'entitlement-projection': 'entitlementProjections',
			'usage-counter': 'usageCounters',
			'usage-ledger': 'usageLedger',
			'aggregate-version': 'aggregateVersions'
		} as Record<string, string>
	)[recordType];
}

function projectionOrderKey(recordType: string, row: JsonRecord): string {
	if (recordType === 'owner-projection' || recordType === 'usage-counter')
		return stringField(row, 'userId');
	if (
		recordType === 'entitlement-projection' ||
		recordType === 'usage-ledger'
	)
		return stringField(row, 'id');
	if (recordType === 'aggregate-version')
		return `${stringField(row, 'aggregateType')}\u0000${stringField(row, 'aggregateId')}`;
	throw new CutoverError(
		'RECORD_TYPE',
		'Snapshot record type is unsupported'
	);
}

async function createTableRow(
	transaction: Prisma.TransactionClient,
	table: TableName,
	row: JsonRecord
): Promise<void> {
	const data = convertRow(row);
	switch (table) {
		case 'widgets':
			await transaction.widget.create({ data: data as never });
			return;
		case 'quizzes':
			await transaction.quiz.create({ data: data as never });
			return;
		case 'callbacks':
			await transaction.callback.create({ data: data as never });
			return;
		case 'countdown_timers':
			await transaction.countdownTimer.create({ data: data as never });
			return;
		case 'stop_offers':
			await transaction.stopOffer.create({ data: data as never });
			return;
		case 'online_consultants':
			await transaction.onlineConsultant.create({ data: data as never });
			return;
		case 'calculators':
			await transaction.calculator.create({ data: data as never });
			return;
		case 'leads':
			await transaction.lead.create({ data: data as never });
			return;
		case 'quiz_leads':
			await transaction.quizLead.create({ data: data as never });
			return;
		case 'callback_leads':
			await transaction.callbackLead.create({ data: data as never });
			return;
		case 'countdown_timer_leads':
			await transaction.countdownTimerLead.create({ data: data as never });
			return;
		case 'stop_offer_leads':
			await transaction.stopOfferLead.create({ data: data as never });
			return;
		case 'online_consultant_leads':
			await transaction.onlineConsultantLead.create({
				data: data as never
			});
			return;
		case 'calculator_leads':
			await transaction.calculatorLead.create({ data: data as never });
			return;
		case 'widget_config_revisions':
			await transaction.widgetConfigRevision.create({
				data: data as never
			});
			return;
		case 'widget_runtime_presence':
			await transaction.widgetRuntimePresence.create({
				data: data as never
			});
			return;
		case 'widget_runtime_daily_metrics':
			await transaction.widgetRuntimeDailyMetric.create({
				data: data as never
			});
			return;
		case 'widget_runtime_daily_step_metrics':
			await transaction.widgetRuntimeDailyStepMetric.create({
				data: data as never
			});
			return;
	}
}

async function createOwnerProjection(
	transaction: Prisma.TransactionClient,
	row: JsonRecord
): Promise<void> {
	await transaction.widgetOwnerProjection.create({
		data: convertRow(row) as never
	});
}

async function createEntitlementProjection(
	transaction: Prisma.TransactionClient,
	row: JsonRecord
): Promise<void> {
	await transaction.widgetEntitlementProjection.create({
		data: convertRow(row) as never
	});
}

async function createUsageCounter(
	transaction: Prisma.TransactionClient,
	row: JsonRecord
): Promise<void> {
	await transaction.widgetUsageCounter.create({
		data: convertRow(row) as never
	});
}

async function createUsageLedger(
	transaction: Prisma.TransactionClient,
	row: JsonRecord
): Promise<void> {
	await transaction.widgetUsageLedgerEntry.create({
		data: convertRow(row) as never
	});
}

async function createProjectionAnchor(
	transaction: Prisma.TransactionClient,
	aggregate: ReportingAggregateSeed
): Promise<void> {
	if (
		!['core.identity.user', 'core.billing.subscription'].includes(
			aggregate.aggregateType
		)
	) {
		throw new CutoverError(
			'AGGREGATE_TYPE',
			'Snapshot aggregate type is not Widgets-owned'
		);
	}
	await transaction.widgetAggregateVersion.create({
		data: {
			aggregateType: aggregate.aggregateType,
			aggregateId: aggregate.aggregateId,
			version: decimal(aggregate.version, false, 'aggregate.version'),
			sourceSequence: decimal(
				aggregate.sourceSequence,
				false,
				'aggregate.sourceSequence'
			),
			stateHash: sha256(aggregate.stateHash, 'aggregate.stateHash')
		}
	});
}

function aggregateSeed(row: JsonRecord): ReportingAggregateSeed {
	return {
		aggregateType: boundedString(
			row.aggregateType,
			'aggregate.aggregateType',
			100
		),
		aggregateId: boundedString(
			row.aggregateId,
			'aggregate.aggregateId',
			255
		),
		version: decimal(
			stringValue(row.version),
			false,
			'aggregate.version'
		).toString(),
		sourceSequence: decimal(
			stringValue(row.sourceSequence),
			false,
			'aggregate.sourceSequence'
		).toString(),
		stateHash: sha256(stringValue(row.stateHash), 'aggregate.stateHash')
	};
}

function convertRow(row: JsonRecord): JsonRecord {
	const result: JsonRecord = {};
	for (const [key, value] of Object.entries(row)) {
		if (value === null) {
			result[key] = key === 'draftConfig' ? Prisma.DbNull : null;
		} else if (
			key === 'aggregateVersion' ||
			key === 'sourceSequence' ||
			key === 'entitlementVersion' ||
			key === 'sourceVersion'
		) {
			result[key] = decimal(stringValue(value), true, key);
		} else if (key === 'calculatedPrice') {
			result[key] = new Prisma.Decimal(stringValue(value));
		} else if (key === 'date' || key.endsWith('At')) {
			result[key] = isoDate(stringValue(value), key);
		} else {
			result[key] = value;
		}
	}
	return result;
}

async function assertImportTargetEmpty(
	transaction: Prisma.TransactionClient
): Promise<void> {
	const counts = await targetCounts(transaction);
	if (Object.values(counts).some(value => value !== 0)) {
		throw new CutoverError(
			'TARGET_NOT_EMPTY',
			'Widgets import target is not empty',
			3
		);
	}
}

async function assertTargetCounts(
	transaction: Prisma.TransactionClient,
	expected: SnapshotCounts
): Promise<void> {
	const actual = await targetCounts(transaction);
	if (canonicalJson(actual) !== canonicalJson(expected)) {
		throw new CutoverError(
			'TARGET_COUNTS',
			'Widgets target counts do not match the snapshot',
			3
		);
	}
}

async function targetCounts(
	transaction: Prisma.TransactionClient
): Promise<SnapshotCounts> {
	const values = await Promise.all([
		transaction.widget.count(),
		transaction.quiz.count(),
		transaction.callback.count(),
		transaction.countdownTimer.count(),
		transaction.stopOffer.count(),
		transaction.onlineConsultant.count(),
		transaction.calculator.count(),
		transaction.lead.count(),
		transaction.quizLead.count(),
		transaction.callbackLead.count(),
		transaction.countdownTimerLead.count(),
		transaction.stopOfferLead.count(),
		transaction.onlineConsultantLead.count(),
		transaction.calculatorLead.count(),
		transaction.widgetConfigRevision.count(),
		transaction.widgetRuntimePresence.count(),
		transaction.widgetRuntimeDailyMetric.count(),
		transaction.widgetRuntimeDailyStepMetric.count(),
		transaction.widgetOwnerProjection.count(),
		transaction.widgetEntitlementProjection.count(),
		transaction.widgetUsageCounter.count(),
		transaction.widgetUsageLedgerEntry.count(),
		transaction.widgetAggregateVersion.count()
	]);
	return Object.fromEntries(
		[
			...TABLES,
			'ownerProjections',
			'entitlementProjections',
			'usageCounters',
			'usageLedger',
			'aggregateVersions'
		].map((key, index) => [key, values[index]])
	);
}

function assertSeededIdentity(
	identity: Awaited<
		ReturnType<
			Prisma.TransactionClient['widgetsServiceIdentity']['findUnique']
		>
	>
): asserts identity is NonNullable<typeof identity> {
	if (
		!identity ||
		!identity.sourceDatabaseFingerprint ||
		!identity.sourceExportedAt ||
		!identity.sourceSnapshotSha256 ||
		!identity.sourceSnapshotCounts ||
		identity.sourceReportingHighWater === null
	) {
		throw new CutoverError(
			'NOT_SEEDED',
			'Widgets snapshot import is not complete',
			3
		);
	}
}

function successImport(
	status: 'imported' | 'already-imported',
	manifest: Manifest,
	contentSha256: string
): JsonRecord {
	return {
		status,
		schemaVersion: SCHEMA_VERSION,
		counts: manifest.counts,
		contentSha256,
		sourceDatabaseFingerprint: manifest.sourceDatabaseFingerprint
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const serialized = JSON.stringify(value);
		if (serialized === undefined)
			throw new CutoverError(
				'SERIALIZE',
				'Snapshot contains unsupported data'
			);
		return serialized;
	}
	if (Array.isArray(value))
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	const object = value as JsonRecord;
	return `{${Object.keys(object)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(',')}}`;
}

function assertExactKeys(value: JsonRecord, expected: string[]): void {
	const actual = Object.keys(value).sort();
	const normalized = [...expected].sort();
	if (
		actual.length !== normalized.length ||
		actual.some((key, index) => key !== normalized[index])
	) {
		throw new CutoverError(
			'RECORD_KEYS',
			'Snapshot record fields are invalid'
		);
	}
}

function objectField(value: JsonRecord, key: string): JsonRecord {
	const item = value[key];
	if (!item || typeof item !== 'object' || Array.isArray(item)) {
		throw new CutoverError(
			'FIELD',
			`Snapshot field ${key} must be an object`
		);
	}
	return item as JsonRecord;
}

function stringField(value: JsonRecord, key: string): string {
	return boundedString(value[key], key, 255);
}

function boundedString(value: unknown, path: string, max: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) {
		throw new CutoverError('FIELD', `Snapshot field ${path} is invalid`);
	}
	return value;
}

function stringValue(value: unknown): string {
	if (typeof value !== 'string')
		throw new CutoverError(
			'FIELD',
			'Snapshot decimal field must be a string'
		);
	return value;
}

function integer(value: unknown, path: string): number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 0 ||
		(value as number) > MAX_RECORDS
	) {
		throw new CutoverError('INTEGER', `Snapshot field ${path} is invalid`);
	}
	return value as number;
}

function decimal(value: string, allowZero: boolean, path: string): bigint {
	const pattern = allowZero
		? /^(0|[1-9][0-9]{0,18})$/
		: /^[1-9][0-9]{0,18}$/;
	if (!pattern.test(value))
		throw new CutoverError('BIGINT', `Snapshot field ${path} is invalid`);
	const result = BigInt(value);
	if (result > POSTGRES_BIGINT_MAX)
		throw new CutoverError('BIGINT', `Snapshot field ${path} is invalid`);
	return result;
}

function isoDate(value: string, path: string): Date {
	const result = new Date(value);
	if (Number.isNaN(result.getTime()) || result.toISOString() !== value) {
		throw new CutoverError('DATE', `Snapshot field ${path} is invalid`);
	}
	return result;
}

function sha256(value: string, path: string): string {
	if (!/^[0-9a-f]{64}$/.test(value))
		throw new CutoverError('SHA256', `Snapshot field ${path} is invalid`);
	return value;
}
