import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Prisma, PrismaClient } from '@prisma/client';

const SCHEMA_VERSION = 1;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_SIZE = 1000;

const domainDefinitions = [
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
];
const domainTableNames = new Set(domainDefinitions);

const widgetSources = [
	['wheel', 'widgets'],
	['quiz', 'quizzes'],
	['callback', 'callbacks'],
	['countdownTimer', 'countdown_timers'],
	['stopOffer', 'stop_offers'],
	['onlineConsultant', 'online_consultants'],
	['calculator', 'calculators']
];

const leadSources = [
	['wheel', 'leads', 'widget_id'],
	['quiz', 'quiz_leads', 'quiz_id'],
	['callback', 'callback_leads', 'callback_id'],
	['countdownTimer', 'countdown_timer_leads', 'countdown_timer_id'],
	['stopOffer', 'stop_offer_leads', 'stop_offer_id'],
	['onlineConsultant', 'online_consultant_leads', 'online_consultant_id'],
	['calculator', 'calculator_leads', 'calculator_id']
];

let sourceDatabaseFingerprint = '';
let sourceExportedAt = '';
const selfTestRequested = process.argv.includes('--self-test');

async function runExport() {
	const databaseUrl = process.env.DATABASE_URL_PRODUCTION;
	sourceDatabaseFingerprint =
		process.env.WIDGETS_SOURCE_DATABASE_FINGERPRINT || '';
	sourceExportedAt = process.env.WIDGETS_SOURCE_EXPORTED_AT || '';

	if (!databaseUrl) fail('CONFIG', 'Core runtime database URL is missing');
	if (!/^[0-9a-f]{64}$/.test(sourceDatabaseFingerprint)) {
		fail('CONFIG', 'Source database fingerprint is invalid');
	}
	if (
		!sourceExportedAt ||
		Number.isNaN(Date.parse(sourceExportedAt)) ||
		new Date(sourceExportedAt).toISOString() !== sourceExportedAt
	) {
		fail('CONFIG', 'Source export timestamp is invalid');
	}

	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl } }
	});
	try {
		await prisma.$transaction(exportSnapshot, {
			isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
			maxWait: 10_000,
			timeout: 30 * 60 * 1000
		});
	} catch (error) {
		const code =
			error instanceof SnapshotError ? error.code : 'EXPORT_FAILED';
		const message =
			error instanceof SnapshotError
				? error.message
				: 'Widgets snapshot export failed';
		process.stderr.write(
			`${JSON.stringify({ status: 'error', command: 'export-snapshot', code, message })}\n`
		);
		process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
	}
}

async function exportSnapshot(transaction) {
	const counts = {};
	for (const table of domainDefinitions) {
		counts[table] = await loadDomainCount(transaction, table);
	}

	const [users, subscriptions, widgetAggregateRows, highWaterRows] =
		await Promise.all([
			loadUsers(transaction),
			loadSubscriptions(transaction),
			transaction.$queryRaw`
				SELECT
					"aggregate_type" AS "aggregateType",
					"aggregate_id" AS "aggregateId",
					"version"::TEXT AS "version",
					"source_sequence"::TEXT AS "sourceSequence"
				FROM "reporting_projection_versions"
				WHERE "aggregate_type" LIKE ${'widgets.widget.%'}
					OR "aggregate_type" LIKE ${'widgets.lead.%'}
				ORDER BY "aggregate_type", "aggregate_id"
			`,
			transaction.$queryRaw`
				SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END::TEXT AS "value"
				FROM "reporting_source_sequence"
			`
		]);
	const reportingSourceHighWater = highWaterRows[0]?.value || '0';
	assertDecimal(reportingSourceHighWater, true, 'REPORTING_HIGH_WATER');

	const identityAnchors = await loadProjectionAnchors(
		transaction,
		'identity.user',
		users.map(user => user.id)
	);
	const entitlementAnchors = await loadProjectionAnchors(
		transaction,
		'billing.subscription',
		subscriptions.map(subscription => subscription.id)
	);
	const ownerProjections = users.map(user => {
		const anchor = resolveSnapshotAnchor(
			identityAnchors,
			user.id,
			'OWNER_ANCHOR'
		);
		const state = identityState(user);
		const tombstoned = user.deletedAt !== null;
		return {
			recordType: 'owner-projection',
			row: {
				userId: user.id,
				status: tombstoned
					? 'DELETED'
					: user.status === 'ACTIVE'
						? 'ACTIVE'
						: 'DEACTIVATED',
				deletedAt: user.deletedAt,
				tombstoned,
				aggregateVersion: anchor.version,
				sourceSequence: anchor.sourceSequence,
				sourceOccurredAt: sourceExportedAt
			},
			anchor: anchor.persisted
				? {
						recordType: 'aggregate-version',
						row: {
							aggregateType: 'core.identity.user',
							aggregateId: user.id,
							version: anchor.version,
							sourceSequence: anchor.sourceSequence,
							stateHash: projectionStateHash(false, state)
						}
					}
				: null
		};
	});

	const entitlementProjections = subscriptions.map(subscription => {
		const anchor = resolveSnapshotAnchor(
			entitlementAnchors,
			subscription.id,
			'ENTITLEMENT_ANCHOR'
		);
		const state = entitlementState(subscription);
		return {
			recordType: 'entitlement-projection',
			row: {
				id: subscription.id,
				userId: subscription.userId,
				plan: subscription.plan,
				billingPeriod: subscription.billingPeriod,
				status: subscription.status,
				startsAt: subscription.startsAt,
				expiresAt: subscription.expiresAt,
				periodResetsAt: subscription.periodResetsAt,
				maxWidgets: subscription.plan === 'HARD' ? 10 : 1,
				maxLeadsPerPeriod:
					subscription.plan === 'TRIAL'
						? 10
						: subscription.plan === 'EASY'
							? 100
							: null,
				unlimited: subscription.plan === 'HARD',
				tombstoned: false,
				aggregateVersion: anchor.version,
				sourceSequence: anchor.sourceSequence,
				sourceOccurredAt: sourceExportedAt,
				sourceCreatedAt: subscription.createdAt,
				sourceUpdatedAt: subscription.updatedAt
			},
			anchor: anchor.persisted
				? {
						recordType: 'aggregate-version',
						row: {
							aggregateType: 'core.billing.subscription',
							aggregateId: subscription.id,
							version: anchor.version,
							sourceSequence: anchor.sourceSequence,
							stateHash: projectionStateHash(false, state)
						}
					}
				: null
		};
	});

	const widgetCounts = await loadWidgetCounts(transaction);
	const usageCounters = subscriptions
		.map(subscription => {
			const anchor = resolveSnapshotAnchor(
				entitlementAnchors,
				subscription.id,
				'USAGE_ENTITLEMENT_ANCHOR'
			);
			const periodEnd =
				subscription.periodResetsAt || subscription.expiresAt || null;
			const validPeriodEnd =
				periodEnd && periodEnd > subscription.startsAt ? periodEnd : null;
			return {
				recordType: 'usage-counter',
				row: {
					userId: subscription.userId,
					widgetCount: widgetCounts.get(subscription.userId) || 0,
					leadCount: subscription.leadsThisPeriod,
					leadPeriodKey:
						validPeriodEnd?.toISOString() ||
						`migration:${sourceExportedAt.slice(0, 7)}`,
					leadPeriodStartsAt: subscription.startsAt,
					leadPeriodEndsAt: validPeriodEnd,
					entitlementVersion: anchor.version
				}
			};
		})
		.sort(
			(left, right) =>
				left.row.userId.localeCompare(right.row.userId) ||
				left.row.leadPeriodKey.localeCompare(right.row.leadPeriodKey)
		);
	const usageLedger = usageCounters
		.flatMap(counter =>
			['WIDGET', 'LEAD'].map(kind => {
				const count =
					kind === 'WIDGET'
						? counter.row.widgetCount
						: counter.row.leadCount;
				const identity = `${sourceDatabaseFingerprint}\u0000${counter.row.userId}\u0000${kind}`;
				return {
					recordType: 'usage-ledger',
					row: {
						id: deterministicUuid(identity),
						userId: counter.row.userId,
						kind,
						operation: 'MIGRATION_ADJUSTMENT',
						delta: count,
						counterAfter: count,
						periodKey: kind === 'LEAD' ? counter.row.leadPeriodKey : null,
						aggregateType: null,
						aggregateId: null,
						idempotencyKey: `widgets-cutover:${createHash('sha256').update(identity).digest('hex')}`,
						entitlementVersion: counter.row.entitlementVersion,
						correlationId: null,
						occurredAt: sourceExportedAt,
						createdAt: sourceExportedAt
					}
				};
			})
		)
		.sort((left, right) => left.row.id.localeCompare(right.row.id));

	const widgetAggregateVersions = await buildWidgetAggregateRecords(
		transaction,
		widgetAggregateRows
	);
	const aggregateVersions = [
		...ownerProjections.map(record => record.anchor),
		...entitlementProjections.map(record => record.anchor),
		...widgetAggregateVersions
	]
		.filter(Boolean)
		.sort(
			(left, right) =>
				left.row.aggregateType.localeCompare(right.row.aggregateType) ||
				left.row.aggregateId.localeCompare(right.row.aggregateId)
		);

	Object.assign(counts, {
		ownerProjections: ownerProjections.length,
		entitlementProjections: entitlementProjections.length,
		usageCounters: usageCounters.length,
		usageLedger: usageLedger.length,
		aggregateVersions: aggregateVersions.length
	});

	const writer = new SnapshotWriter();
	await writer.write({
		recordType: 'manifest',
		schemaVersion: SCHEMA_VERSION,
		sourceDatabaseFingerprint,
		sourceExportedAt,
		reportingSourceHighWater,
		counts
	});
	for (const table of domainDefinitions) {
		let cursor = '';
		for (;;) {
			const rows = await loadDomainChunk(transaction, table, cursor);
			for (const row of rows) {
				await writer.write({
					recordType: 'table-row',
					table,
					key: row.id,
					row
				});
			}
			if (rows.length < CHUNK_SIZE) break;
			cursor = rows.at(-1).id;
		}
	}
	for (const record of ownerProjections) {
		await writer.write({ recordType: record.recordType, row: record.row });
	}
	for (const record of entitlementProjections) {
		await writer.write({ recordType: record.recordType, row: record.row });
	}
	for (const record of usageCounters) await writer.write(record);
	for (const record of usageLedger) await writer.write(record);
	for (const record of aggregateVersions) await writer.write(record);
	await writer.finish(counts);
}

async function loadUsers(transaction) {
	const [users, identities] = await Promise.all([
		transaction.$queryRaw`
			SELECT
				"id",
				"status"::TEXT AS "status",
				"deleted_at" AS "deletedAt",
				"rights"::TEXT[] AS "rights",
				"created_at" AS "createdAt",
				"updated_at" AS "updatedAt"
			FROM "User"
			ORDER BY "id"
		`,
		transaction.$queryRaw`
			SELECT
				"user_id" AS "userId",
				"type"::TEXT AS "type",
				"verified_at" AS "verifiedAt"
			FROM "auth_identities"
			ORDER BY "user_id", "type"
		`
	]);
	const identitiesByUser = new Map();
	for (const identity of identities) {
		const current = identitiesByUser.get(identity.userId) || [];
		current.push({ type: identity.type, verifiedAt: identity.verifiedAt });
		identitiesByUser.set(identity.userId, current);
	}
	return users.map(user => ({
		...user,
		authIdentities: identitiesByUser.get(user.id) || []
	}));
}

async function loadSubscriptions(transaction) {
	return transaction.$queryRaw`
		SELECT
			"id",
			"user_id" AS "userId",
			"plan"::TEXT AS "plan",
			"billing_period"::TEXT AS "billingPeriod",
			"status"::TEXT AS "status",
			"starts_at" AS "startsAt",
			"expires_at" AS "expiresAt",
			"leads_this_period" AS "leadsThisPeriod",
			"period_resets_at" AS "periodResetsAt",
			"created_at" AS "createdAt",
			"updated_at" AS "updatedAt"
		FROM "subscriptions"
		ORDER BY "id"
	`;
}

async function loadDomainCount(transaction, table) {
	const rows = await transaction.$queryRaw(domainCountQuery(table));
	const count = rows[0]?.count;
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new SnapshotError('COUNT', 'Source table count is invalid');
	}
	return count;
}

async function loadDomainChunk(transaction, table, cursor) {
	const rows = await transaction.$queryRaw(
		domainChunkQuery(table, cursor)
	);
	return rows.map(mapDatabaseRow);
}

function domainCountQuery(table) {
	return Prisma.sql`
		SELECT COUNT(*)::INTEGER AS "count"
		FROM ${domainTableIdentifier(table)}
	`;
}

function domainChunkQuery(table, cursor) {
	return Prisma.sql`
		SELECT source_row.*
		FROM ${domainTableIdentifier(table)} AS source_row
		WHERE "id" > ${cursor}
		ORDER BY "id"
		LIMIT ${CHUNK_SIZE}
	`;
}

function domainTableIdentifier(table) {
	if (!domainTableNames.has(table) || !/^[a-z][a-z0-9_]*$/.test(table)) {
		throw new SnapshotError('SOURCE_TABLE', 'Unknown source table');
	}
	return Prisma.raw(`"${table}"`);
}

function sourceColumnIdentifier(column) {
	const allowed = new Set(leadSources.map(([, , field]) => field));
	if (!allowed.has(column) || !/^[a-z][a-z0-9_]*$/.test(column)) {
		throw new SnapshotError('SOURCE_COLUMN', 'Unknown source column');
	}
	return Prisma.raw(`"${column}"`);
}

function mapDatabaseRow(row) {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
			value
		])
	);
}

async function loadProjectionAnchors(transaction, aggregateType, ids) {
	if (!ids.length) return new Map();
	const expectedIds = new Set(ids);
	const rows = await transaction.$queryRaw`
		SELECT
			"aggregate_id" AS "aggregateId",
			"version"::TEXT AS "version",
			"source_sequence"::TEXT AS "sourceSequence"
		FROM "reporting_projection_versions"
		WHERE "aggregate_type" = ${aggregateType}
		ORDER BY "aggregate_id"
	`;
	return new Map(
		rows
			.filter(row => expectedIds.has(row.aggregateId))
			.map(row => [
				row.aggregateId,
				{
					version: row.version,
					sourceSequence: row.sourceSequence
				}
			])
	);
}

async function loadWidgetCounts(transaction) {
	const counts = new Map();
	for (const [, table] of widgetSources) {
		const rows = await transaction.$queryRaw(
			Prisma.sql`
				SELECT "user_id" AS "userId", COUNT(*)::INTEGER AS "count"
				FROM ${domainTableIdentifier(table)}
				GROUP BY "user_id"
				ORDER BY "user_id"
			`
		);
		for (const row of rows) {
			counts.set(row.userId, (counts.get(row.userId) || 0) + row.count);
		}
	}
	return counts;
}

async function buildWidgetAggregateRecords(transaction, anchors) {
	const states = new Map();
	for (const [type, table] of widgetSources) {
		const rows = await transaction.$queryRaw(
			Prisma.sql`
				SELECT
					"id",
					"user_id" AS "userId",
					"is_active" AS "isActive",
					"install_domain" AS "installDomain",
					"created_at" AS "createdAt"
				FROM ${domainTableIdentifier(table)}
				ORDER BY "id"
			`
		);
		for (const row of rows) {
			states.set(`widgets.widget.${type}\u0000${type}:${row.id}`, {
				id: row.id,
				userId: row.userId,
				widgetType: type,
				isActive: row.isActive,
				hasInstallDomain: Boolean(row.installDomain),
				createdAt: row.createdAt.toISOString()
			});
		}
	}
	for (const [type, table, widgetIdField] of leadSources) {
		const rows = await transaction.$queryRaw(
			Prisma.sql`
				SELECT
					"id",
					${sourceColumnIdentifier(widgetIdField)} AS "widgetId",
					"created_at" AS "createdAt"
				FROM ${domainTableIdentifier(table)}
				ORDER BY "id"
			`
		);
		for (const row of rows) {
			states.set(`widgets.lead.${type}\u0000${type}:${row.id}`, {
				id: row.id,
				widgetId: row.widgetId,
				widgetType: type,
				createdAt: row.createdAt.toISOString()
			});
		}
	}
	return anchors.map(anchor => {
		assertDecimal(anchor.version, false, 'WIDGET_AGGREGATE_VERSION');
		assertDecimal(
			anchor.sourceSequence,
			false,
			'WIDGET_AGGREGATE_SEQUENCE'
		);
		const state = states.get(
			`${anchor.aggregateType}\u0000${anchor.aggregateId}`
		);
		return {
			recordType: 'aggregate-version',
			row: {
				aggregateType: anchor.aggregateType,
				aggregateId: anchor.aggregateId,
				version: anchor.version,
				sourceSequence: anchor.sourceSequence,
				stateHash: projectionStateHash(!state, state || null)
			}
		};
	});
}

function identityState(user) {
	const types = user.authIdentities;
	return {
		id: user.id,
		status: user.status,
		deletedAt: user.deletedAt?.toISOString() || null,
		roles: [...new Set(user.rights)].sort(),
		hasEmailIdentity: types.some(identity => identity.type === 'EMAIL'),
		hasPhoneIdentity: types.some(identity => identity.type === 'PHONE'),
		hasTelegramIdentity: types.some(
			identity => identity.type === 'TELEGRAM'
		),
		loginMethodCount: types.filter(
			identity =>
				['EMAIL', 'GOOGLE', 'GITHUB', 'TELEGRAM'].includes(
					identity.type
				) ||
				(identity.type === 'PHONE' && identity.verifiedAt !== null)
		).length,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString()
	};
}

function entitlementState(subscription) {
	return {
		id: subscription.id,
		userId: subscription.userId,
		plan: subscription.plan,
		billingPeriod: subscription.billingPeriod,
		status: subscription.status,
		startsAt: subscription.startsAt.toISOString(),
		expiresAt: subscription.expiresAt?.toISOString() || null,
		periodResetsAt: subscription.periodResetsAt?.toISOString() || null,
		maxWidgets: subscription.plan === 'HARD' ? 10 : 1,
		maxLeadsPerPeriod:
			subscription.plan === 'TRIAL'
				? 10
				: subscription.plan === 'EASY'
					? 100
					: null,
		unlimited: subscription.plan === 'HARD',
		createdAt: subscription.createdAt.toISOString()
	};
}

function projectionStateHash(tombstone, state) {
	return createHash('sha256')
		.update(canonicalJson({ tombstone, state }))
		.digest('hex');
}

function resolveSnapshotAnchor(anchors, id, code) {
	const anchor = anchors.get(id);
	if (!anchor) {
		return {
			version: '0',
			sourceSequence: '0',
			persisted: false
		};
	}
	assertDecimal(anchor.version, false, code);
	assertDecimal(anchor.sourceSequence, false, code);
	return { ...anchor, persisted: true };
}

function deterministicUuid(value) {
	const bytes = createHash('sha256')
		.update(value)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertDecimal(value, allowZero, code) {
	const pattern = allowZero
		? /^(0|[1-9][0-9]{0,18})$/
		: /^[1-9][0-9]{0,18}$/;
	if (!pattern.test(String(value))) {
		throw new SnapshotError(
			code,
			'Projection sequence/version is invalid'
		);
	}
}

class SnapshotWriter {
	constructor() {
		this.hash = createHash('sha256');
		this.records = 0;
		this.bytes = 0;
	}

	async write(value) {
		const line = `${canonicalJson(value)}\n`;
		const bytes = Buffer.byteLength(line);
		if (bytes > MAX_LINE_BYTES) {
			throw new SnapshotError(
				'LINE_LIMIT',
				'Snapshot record exceeds 256 KiB'
			);
		}
		if (this.bytes + bytes > MAX_STREAM_BYTES) {
			throw new SnapshotError('STREAM_LIMIT', 'Snapshot exceeds 2 GiB');
		}
		this.hash.update(line);
		this.records += 1;
		this.bytes += bytes;
		if (!process.stdout.write(line)) await once(process.stdout, 'drain');
	}

	async finish(counts) {
		const trailer = {
			recordType: 'trailer',
			schemaVersion: SCHEMA_VERSION,
			records: this.records,
			counts,
			contentSha256: this.hash.digest('hex')
		};
		const line = `${canonicalJson(trailer)}\n`;
		const bytes = Buffer.byteLength(line);
		if (bytes > MAX_LINE_BYTES || this.bytes + bytes > MAX_STREAM_BYTES) {
			throw new SnapshotError(
				'TRAILER_LIMIT',
				'Snapshot trailer exceeds limits'
			);
		}
		if (!process.stdout.write(line)) await once(process.stdout, 'drain');
	}
}

function canonicalJson(value) {
	const normalized = normalize(value);
	if (normalized === null || typeof normalized !== 'object') {
		const serialized = JSON.stringify(normalized);
		if (serialized === undefined) {
			throw new SnapshotError(
				'SERIALIZE',
				'Snapshot contains an unsupported value'
			);
		}
		return serialized;
	}
	if (Array.isArray(normalized)) {
		return `[${normalized.map(item => canonicalJson(item)).join(',')}]`;
	}
	return `{${Object.keys(normalized)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(normalized[key])}`)
		.join(',')}}`;
}

function normalize(value) {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	if (
		value &&
		typeof value === 'object' &&
		value.constructor?.name === 'Decimal'
	) {
		return value.toString();
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => {
				if (item === undefined) {
					throw new SnapshotError(
						'SERIALIZE',
						'Snapshot contains undefined'
					);
				}
				return [key, normalize(item)];
			})
		);
	}
	return value;
}

class SnapshotError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function runSelfTest() {
	const expectedTables = [
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
	];
	if (
		JSON.stringify(domainDefinitions) !== JSON.stringify(expectedTables) ||
		domainTableNames.size !== expectedTables.length
	) {
		throw new Error('Widgets source table allowlist drifted');
	}
	for (const [, table] of widgetSources) domainTableIdentifier(table);
	for (const [, table, column] of leadSources) {
		domainTableIdentifier(table);
		sourceColumnIdentifier(column);
	}
	const query = domainChunkQuery('widgets', 'cursor-id');
	if (
		query.values.length !== 2 ||
		query.values[0] !== 'cursor-id' ||
		query.values[1] !== CHUNK_SIZE ||
		!query.text.includes('FROM "widgets" AS source_row') ||
		!query.text.includes('WHERE "id" > $1') ||
		!query.text.includes('LIMIT $2')
	) {
		throw new Error('Widgets parameterized chunk query contract drifted');
	}
	const mapped = mapDatabaseRow({
		id: 'row-id',
		user_id: 'user-id',
		created_at: new Date('2026-08-05T00:00:00.000Z')
	});
	if (
		mapped.id !== 'row-id' ||
		mapped.userId !== 'user-id' ||
		!(mapped.createdAt instanceof Date)
	) {
		throw new Error('Widgets raw row mapping contract drifted');
	}
	let rejectedUnsafeIdentifier = false;
	try {
		domainTableIdentifier('widgets; SELECT 1');
	} catch (error) {
		rejectedUnsafeIdentifier = error instanceof SnapshotError;
	}
	if (!rejectedUnsafeIdentifier) {
		throw new Error(
			'Widgets raw SQL identifier allowlist is not fail-closed'
		);
	}
	const historicalAnchor = resolveSnapshotAnchor(
		new Map(),
		'historical-id',
		'HISTORICAL_ANCHOR'
	);
	const persistedAnchor = resolveSnapshotAnchor(
		new Map([['persisted-id', { version: '7', sourceSequence: '19' }]]),
		'persisted-id',
		'PERSISTED_ANCHOR'
	);
	if (
		historicalAnchor.version !== '0' ||
		historicalAnchor.sourceSequence !== '0' ||
		historicalAnchor.persisted ||
		persistedAnchor.version !== '7' ||
		persistedAnchor.sourceSequence !== '19' ||
		!persistedAnchor.persisted
	) {
		throw new Error(
			'Widgets historical projection anchor contract drifted'
		);
	}
	let rejectedMixedAnchor = false;
	try {
		resolveSnapshotAnchor(
			new Map([['mixed-id', { version: '1', sourceSequence: '0' }]]),
			'mixed-id',
			'MIXED_ANCHOR'
		);
	} catch (error) {
		rejectedMixedAnchor = error instanceof SnapshotError;
	}
	if (!rejectedMixedAnchor) {
		throw new Error('Widgets mixed projection anchor is not rejected');
	}
	process.stdout.write(
		'Widgets snapshot raw SQL contract self-test passed.\n'
	);
}

function fail(code, message) {
	process.stderr.write(
		`${JSON.stringify({ status: 'error', command: 'export-snapshot', code, message })}\n`
	);
	process.exit(1);
}

if (selfTestRequested) {
	runSelfTest();
} else {
	await runExport();
}
