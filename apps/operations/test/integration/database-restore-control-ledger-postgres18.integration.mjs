import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsRoot = join(appRoot, 'prisma/migrations');
const containerId =
	process.env.OPERATIONS_CONTROL_LEDGER_POSTGRES_CONTAINER_ID?.trim() ??
	'';
const superuser =
	process.env.OPERATIONS_CONTROL_LEDGER_POSTGRES_USER?.trim() ?? '';
const superuserPassword =
	process.env.OPERATIONS_CONTROL_LEDGER_POSTGRES_PASSWORD ?? '';
const controlDatabase =
	process.env.OPERATIONS_CONTROL_LEDGER_POSTGRES_DB?.trim() ?? '';
const publishedPort =
	process.env.OPERATIONS_CONTROL_LEDGER_POSTGRES_PORT?.trim() ?? '';

const EXPECTED_SUPERUSER = 'operations_control_ledger_superuser';
const EXPECTED_DATABASE = 'operations_control_ledger';
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const PORT =
	/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const REHEARSAL_LABEL = 'winwidget.operations-control-ledger';
const REHEARSAL_LABEL_VALUE = 'true';
const SHA256 = /^[a-f0-9]{64}$/;
let negativeSqlCases = 0;

const fixture = Object.freeze({
	backupJobId: '10000000-0000-4000-8000-000000000001',
	permitId: '10000000-0000-4000-8000-000000000002',
	jobId: '10000000-0000-4000-8000-000000000003',
	eventId: '10000000-0000-4000-8000-000000000004',
	idempotencyKey: '10000000-0000-4000-8000-000000000005',
	releaseAuthorizationId: '10000000-0000-4000-8000-000000000006',
	terminalReceiptId: '10000000-0000-4000-8000-000000000007',
	recoveryActionId: '10000000-0000-4000-8000-000000000008',
	target: 'reporting',
	sourceFileName: 'reporting-control-ledger.dump',
	sourceSha256: '1'.repeat(64),
	otherSourceSha256: '2'.repeat(64),
	sourceSize: 1024,
	servicesSha: 'a'.repeat(40),
	migrationManifestSha: 'b'.repeat(64),
	provenanceEnvelopeSha256: 'c'.repeat(64),
	provenanceKeyId: 'operations-backup-ed25519-2026-08-31',
	backupProvenance: JSON.stringify({
		schemaVersion: 1,
		keyId: 'operations-backup-ed25519-2026-08-31',
		signature: 'control-ledger-fixture'
	}),
	releasePayloadSha256: 'd'.repeat(64),
	artifactSha256: 'e'.repeat(64),
	receiptPayloadSha256: 'f'.repeat(64),
	writerFenceRoles: JSON.stringify([
		'winwidget_reporting_runtime',
		'winwidget_reporting_migration',
		'winwidget_reporting_backup'
	])
});

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

const safeOutput = value =>
	String(value ?? '')
		.replaceAll(superuserPassword, '[redacted]')
		.trim()
		.slice(-4_000);

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: options.environment
			? { ...process.env, ...options.environment }
			: process.env,
		input: options.input,
		maxBuffer: 64 * 1024 * 1024,
		stdio: options.input === undefined ? 'pipe' : ['pipe', 'pipe', 'pipe']
	});
	if (result.error) {
		throw new Error(
			`${options.label ?? command} could not start: ${result.error.message}`
		);
	}
	if (options.allowFailure) {
		return {
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			status: result.status
		};
	}
	if (result.status !== 0) {
		throw new Error(
			`${options.label ?? command} failed: ${safeOutput(result.stderr || result.stdout)}`
		);
	}
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		status: result.status
	};
};

const docker = (args, options = {}) => run('docker', args, options);

const containerCommand = (command, args, options = {}) => {
	const environment = Object.entries(options.environment ?? {}).flatMap(
		([key, value]) => ['--env', `${key}=${value}`]
	);
	return docker(
		['exec', '-i', ...environment, containerId, command, ...args],
		options
	);
};

const psql = ({
	sql,
	tuplesOnly = false,
	allowFailure = false,
	label = 'PostgreSQL command'
}) =>
	containerCommand(
		'psql',
		[
			'--no-password',
			'--set',
			'ON_ERROR_STOP=1',
			'--host',
			'127.0.0.1',
			'--port',
			'5432',
			'--username',
			superuser,
			'--dbname',
			controlDatabase,
			...(tuplesOnly ? ['--tuples-only', '--no-align'] : []),
			'--command',
			sql
		],
		{
			environment: { PGPASSWORD: superuserPassword },
			allowFailure,
			label
		}
	);

const expectSqlFailure = (sql, pattern, label) => {
	const result = psql({ sql, allowFailure: true, label });
	assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
	assert.match(
		safeOutput(`${result.stderr}\n${result.stdout}`),
		pattern,
		`${label} failed outside the expected invariant`
	);
	negativeSqlCases += 1;
};

const assertHarnessBoundary = () => {
	assert.equal(
		process.env.OPERATIONS_CONTROL_LEDGER_ALLOW_MUTATION,
		'true',
		'OPERATIONS_CONTROL_LEDGER_ALLOW_MUTATION=true is required'
	);
	assert.match(
		containerId,
		CONTAINER_ID,
		'A concrete Docker container ID is required'
	);
	assert.equal(superuser, EXPECTED_SUPERUSER);
	assert.equal(controlDatabase, EXPECTED_DATABASE);
	assert.ok(
		superuserPassword.length >= 16,
		'Ephemeral PostgreSQL password is invalid'
	);
	assert.match(
		publishedPort,
		PORT,
		'A concrete published PostgreSQL port is required'
	);

	const label = docker([
		'inspect',
		'--format',
		`{{ index .Config.Labels "${REHEARSAL_LABEL}" }}`,
		containerId
	]).stdout.trim();
	assert.equal(
		label,
		REHEARSAL_LABEL_VALUE,
		'The PostgreSQL container is not marked as an Operations control-ledger fixture'
	);
	const mappedPort = docker([
		'inspect',
		'--format',
		'{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}',
		containerId
	]).stdout.trim();
	assert.equal(
		mappedPort,
		publishedPort,
		'The control-ledger connection port is not owned by the marked fixture'
	);

	const version = psql({
		sql: 'SHOW server_version_num;',
		tuplesOnly: true,
		label: 'PostgreSQL version verification'
	}).stdout.trim();
	assert.match(
		version,
		/^18\d{4}$/,
		'The control-ledger gate requires PostgreSQL 18'
	);
	const identity = psql({
		sql: "SELECT current_user || E'\\n' || current_database();",
		tuplesOnly: true,
		label: 'Ephemeral PostgreSQL identity verification'
	}).stdout.trim();
	assert.equal(identity, `${EXPECTED_SUPERUSER}\n${EXPECTED_DATABASE}`);
	const operationsSchema = psql({
		sql: "SELECT COALESCE(to_regnamespace('operations')::text, '');",
		tuplesOnly: true,
		label: 'Clean control-ledger fixture verification'
	}).stdout.trim();
	assert.equal(
		operationsSchema,
		'',
		'The marked control-ledger fixture is not clean'
	);
};

const applyAndVerifyMigrations = async () => {
	const migrations = (
		await readdir(migrationsRoot, { withFileTypes: true })
	)
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	assert.ok(migrations.length > 0, 'Operations migrations are missing');

	psql({
		sql: `CREATE SCHEMA "operations" AUTHORIZATION "${EXPECTED_SUPERUSER}";`,
		label: 'Create isolated Operations schema'
	});
	const databaseUrl =
		`postgresql://${encodeURIComponent(superuser)}:` +
		`${encodeURIComponent(superuserPassword)}@127.0.0.1:${publishedPort}/` +
		`${controlDatabase}?schema=operations`;
	run(
		'pnpm',
		[
			'exec',
			'prisma',
			'migrate',
			'deploy',
			'--schema',
			'prisma/schema.prisma'
		],
		{
			cwd: appRoot,
			environment: { OPERATIONS_DATABASE_URL: databaseUrl },
			label: 'Apply Operations Prisma migrations'
		}
	);

	const applied = psql({
		sql: `SELECT "migration_name"
			FROM "operations"."_prisma_migrations"
			WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
			ORDER BY "migration_name";`,
		tuplesOnly: true,
		label: 'Read Operations migration ledger'
	})
		.stdout.trim()
		.split(/\r?\n/)
		.filter(Boolean);
	assert.deepEqual(
		applied,
		migrations,
		'Operations migration ledger is incomplete or drifted'
	);
};

const permitInsert = ({
	target = fixture.target,
	sourceSha256 = fixture.sourceSha256,
	sourceSize = fixture.sourceSize,
	sourceBackupJobId = fixture.backupJobId,
	backupProvenance = fixture.backupProvenance,
	provenanceEnvelopeSha256 = fixture.provenanceEnvelopeSha256,
	provenanceKeyId = fixture.provenanceKeyId
} = {}) => `
	INSERT INTO "operations"."database_restore_permits" (
		"id", "job_id", "target", "source_sha256", "source_size",
		"source_backup_job_id", "backup_provenance",
		"backup_provenance_envelope_sha256", "backup_provenance_key_id",
		"expected_services_sha", "migration_manifest_sha", "status",
		"requested_by_id", "approved_by_id", "approved_at", "expires_at",
		"consumed_at", "closed_at", "close_reason", "created_at", "updated_at"
	) VALUES (
		${literal(fixture.permitId)}, ${literal(fixture.jobId)}, ${literal(target)},
		${literal(sourceSha256)}, ${sourceSize}, ${literal(sourceBackupJobId)},
		${literal(backupProvenance)}, ${literal(provenanceEnvelopeSha256)},
		${literal(provenanceKeyId)}, ${literal(fixture.servicesSha)},
		${literal(fixture.migrationManifestSha)}, 'CLOSED', 'requester',
		'approver', now() - interval '20 minutes', now() + interval '1 hour',
		now() - interval '10 minutes', now() - interval '5 minutes',
		'control-ledger fixture', now() - interval '30 minutes', now()
	);`;

const jobInsert = ({ sourceSha256 = fixture.sourceSha256 } = {}) => `
	INSERT INTO "operations"."database_restore_jobs" (
		"id", "target", "status", "phase", "source_file_name",
		"source_sha256", "source_size", "source_backup_job_id",
		"backup_provenance", "backup_provenance_envelope_sha256",
		"backup_provenance_key_id", "requested_by_id", "idempotency_key",
		"event_id", "permit_id", "expected_services_sha",
		"migration_manifest_sha", "attempts", "result", "finished_at",
		"created_at", "updated_at"
	) VALUES (
		${literal(fixture.jobId)}, ${literal(fixture.target)}, 'SUCCEEDED', 'VERIFIED',
		${literal(fixture.sourceFileName)}, ${literal(sourceSha256)},
		${fixture.sourceSize}, ${literal(fixture.backupJobId)},
		${literal(fixture.backupProvenance)},
		${literal(fixture.provenanceEnvelopeSha256)},
		${literal(fixture.provenanceKeyId)}, 'requester',
		${literal(fixture.idempotencyKey)}, ${literal(fixture.eventId)},
		${literal(fixture.permitId)}, ${literal(fixture.servicesSha)},
		${literal(fixture.migrationManifestSha)}, 1, '{"verified":true}'::jsonb,
		now(), now() - interval '30 minutes', now()
	);`;

const releaseAuthorizationInsert = ({
	sourceSize = fixture.sourceSize
} = {}) => `
	INSERT INTO "operations"."database_restore_release_authorizations" (
		"id", "operation_type", "operation_id", "job_id", "action_id",
		"permit_id", "event_id", "target", "recovery_action",
		"initial_receipt_payload_sha256", "source_sha256", "source_size",
		"source_backup_job_id", "backup_provenance_envelope_sha256",
		"backup_provenance_key_id", "artifact_sha256", "expected_services_sha",
		"migration_manifest_sha", "requested_by_id", "approved_by_id",
		"approved_at", "approval_evidence_sha256", "writer_fence_roles",
		"writer_fence_applied_at", "writer_fence_evidence_sha256", "verified_at",
		"migration_ledger_sha256", "acl_evidence_sha256",
		"verified_writer_fence_sha256", "payload_sha256",
		"signature_hmac_sha256", "signature_key_id", "authorized_at", "created_at"
	) VALUES (
		${literal(fixture.releaseAuthorizationId)}, 'RESTORE',
		${literal(fixture.jobId)}, ${literal(fixture.jobId)}, NULL,
		${literal(fixture.permitId)}, ${literal(fixture.eventId)},
		${literal(fixture.target)}, NULL, NULL, ${literal(fixture.sourceSha256)},
		${sourceSize}, ${literal(fixture.backupJobId)},
		${literal(fixture.provenanceEnvelopeSha256)},
		${literal(fixture.provenanceKeyId)}, ${literal(fixture.artifactSha256)},
		${literal(fixture.servicesSha)}, ${literal(fixture.migrationManifestSha)},
		'requester', 'approver', now() - interval '20 minutes',
		${literal('3'.repeat(64))}, ${literal(fixture.writerFenceRoles)}::jsonb,
		now() - interval '15 minutes', ${literal('4'.repeat(64))},
		now() - interval '10 minutes', ${literal('5'.repeat(64))},
		${literal('6'.repeat(64))}, ${literal('7'.repeat(64))},
		${literal(fixture.releasePayloadSha256)}, ${literal('8'.repeat(64))},
		'operations-receipt-hmac-2026-08-31', now() - interval '5 minutes', now()
	);`;

const terminalReceiptInsert = ({
	sourceSize = fixture.sourceSize,
	releasePayloadSha256 = fixture.releasePayloadSha256
} = {}) => `
	INSERT INTO "operations"."database_restore_terminal_receipts" (
		"id", "job_id", "permit_id", "permit_requested_by_id",
		"permit_approved_by_id", "permit_created_at", "permit_approved_at",
		"permit_expires_at", "permit_consumed_at", "target", "terminal_status",
		"phase", "source_sha256", "source_size", "source_backup_job_id",
		"backup_provenance_envelope_sha256", "backup_provenance_key_id",
		"safety_backup_sha256", "expected_services_sha", "migration_manifest_sha",
		"result_sha256", "error_sha256", "payload_sha256",
		"signature_hmac_sha256", "signature_key_id", "release_authorization_payload_sha256",
		"completed_at", "created_at"
	) VALUES (
		${literal(fixture.terminalReceiptId)}, ${literal(fixture.jobId)},
		${literal(fixture.permitId)}, 'requester', 'approver',
		now() - interval '30 minutes', now() - interval '20 minutes',
		now() + interval '1 hour', now() - interval '10 minutes',
		${literal(fixture.target)}, 'SUCCEEDED', 'VERIFIED',
		${literal(fixture.sourceSha256)}, ${sourceSize}, ${literal(fixture.backupJobId)},
		${literal(fixture.provenanceEnvelopeSha256)},
		${literal(fixture.provenanceKeyId)}, NULL, ${literal(fixture.servicesSha)},
		${literal(fixture.migrationManifestSha)}, ${literal('9'.repeat(64))}, NULL,
		${literal(fixture.receiptPayloadSha256)}, ${literal('0'.repeat(64))},
		'operations-receipt-hmac-2026-08-31',
		${releasePayloadSha256 === null ? 'NULL' : literal(releasePayloadSha256)},
		now(), now()
	);`;

const seedBackupJob = () => {
	psql({
		sql: `INSERT INTO "operations"."scheduled_job_runs" (
			"id", "job_type", "schedule_key", "trigger", "status",
			"scheduled_for", "input", "checkpoint", "result", "attempts",
			"max_attempts", "available_at", "started_at", "finished_at",
			"created_at", "updated_at"
		) VALUES (
			${literal(fixture.backupJobId)}, 'database-backup.reporting',
			'control-ledger-fixture', 'MANUAL', 'SUCCEEDED', now() - interval '1 hour',
			'{"target":"reporting"}'::jsonb, '{}'::jsonb,
			'{"delivered":true}'::jsonb, 1, 4, now() - interval '1 hour',
			now() - interval '50 minutes', now() - interval '40 minutes',
			now() - interval '1 hour', now()
		);`,
		label: 'Seed completed backup job'
	});
};

const assertNegativeMatrix = () => {
	seedBackupJob();

	expectSqlFailure(
		permitInsert({ target: 'billing' }),
		/database_restore_permits_target/i,
		'Unknown restore target rejection'
	);
	expectSqlFailure(
		permitInsert({ backupProvenance: '' }),
		/database_restore_permits_provenance_check/i,
		'Unsigned backup provenance rejection'
	);
	expectSqlFailure(
		permitInsert({ provenanceEnvelopeSha256: 'invalid' }),
		/database_restore_permits_provenance_check/i,
		'Invalid backup provenance envelope rejection'
	);
	expectSqlFailure(
		permitInsert({ provenanceKeyId: 'invalid key id' }),
		/database_restore_permits_provenance_check/i,
		'Invalid backup provenance key rejection'
	);
	expectSqlFailure(
		permitInsert({ sourceSize: 0 }),
		/database_restore_permits_provenance_check/i,
		'Invalid backup provenance source size rejection'
	);

	psql({ sql: permitInsert(), label: 'Seed exact restore permit' });
	expectSqlFailure(
		jobInsert({ sourceSha256: fixture.otherSourceSha256 }),
		/database_restore_jobs_permit_fkey/i,
		'Permit and restore job cross-binding rejection'
	);
	psql({ sql: jobInsert(), label: 'Seed exact restore job' });
	expectSqlFailure(
		`UPDATE "operations"."database_restore_permits"
		SET "backup_provenance" = '{"mutated":true}'
		WHERE "id" = ${literal(fixture.permitId)};`,
		/Database restore permit binding is immutable/i,
		'Mutable permit provenance rejection'
	);
	expectSqlFailure(
		`UPDATE "operations"."database_restore_jobs"
		SET "backup_provenance" = '{"mutated":true}'
		WHERE "id" = ${literal(fixture.jobId)};`,
		/Database restore job provenance is immutable/i,
		'Mutable job provenance rejection'
	);

	expectSqlFailure(
		releaseAuthorizationInsert({ sourceSize: fixture.sourceSize + 1 }),
		/database_restore_release_authorizations_(job|permit)_fkey/i,
		'Release authorization cross-binding rejection'
	);
	psql({
		sql: releaseAuthorizationInsert(),
		label: 'Seed exact restore release authorization'
	});
	expectSqlFailure(
		terminalReceiptInsert({ sourceSize: fixture.sourceSize + 1 }),
		/database_restore_terminal_receipts_job_fkey/i,
		'Terminal receipt cross-binding rejection'
	);
	expectSqlFailure(
		terminalReceiptInsert({ releasePayloadSha256: null }),
		/database_restore_terminal_receipts_release_authorization/i,
		'Unsigned successful release receipt rejection'
	);
	psql({
		sql: terminalReceiptInsert(),
		label: 'Seed exact terminal receipt'
	});
	expectSqlFailure(
		`UPDATE "operations"."database_restore_terminal_receipts"
		SET "payload_sha256" = ${literal('a'.repeat(64))}
		WHERE "id" = ${literal(fixture.terminalReceiptId)};`,
		/Database restore terminal receipts are immutable/i,
		'Mutable terminal receipt rejection'
	);
	expectSqlFailure(
		`DELETE FROM "operations"."database_restore_terminal_receipts"
		WHERE "id" = ${literal(fixture.terminalReceiptId)};`,
		/Database restore terminal receipts are immutable/i,
		'Terminal receipt deletion rejection'
	);
	expectSqlFailure(
		`UPDATE "operations"."database_restore_release_authorizations"
		SET "payload_sha256" = ${literal('b'.repeat(64))}
		WHERE "id" = ${literal(fixture.releaseAuthorizationId)};`,
		/Database restore release authorizations are immutable/i,
		'Mutable release authorization rejection'
	);

	psql({
		sql: `INSERT INTO "operations"."database_restore_recovery_actions" (
			"id", "job_id", "action", "status", "receipt_payload_sha",
			"requested_by_id", "expires_at", "created_at", "updated_at"
		) VALUES (
			${literal(fixture.recoveryActionId)}, ${literal(fixture.jobId)},
			'VERIFY_AS_IS', 'EXPIRED', ${literal('c'.repeat(64))}, 'requester',
			now() + interval '1 hour', now(), now()
		);`,
		label: 'Seed terminal recovery action'
	});
	expectSqlFailure(
		`UPDATE "operations"."database_restore_recovery_actions"
		SET "last_error" = 'mutated'
		WHERE "id" = ${literal(fixture.recoveryActionId)};`,
		/Database restore terminal recovery action is immutable/i,
		'Mutable terminal recovery action rejection'
	);

	const counts = psql({
		sql: `SELECT
			(SELECT count(*) FROM "operations"."database_restore_permits") || '|' ||
			(SELECT count(*) FROM "operations"."database_restore_jobs") || '|' ||
			(SELECT count(*) FROM "operations"."database_restore_release_authorizations") || '|' ||
			(SELECT count(*) FROM "operations"."database_restore_terminal_receipts") || '|' ||
			(SELECT count(*) FROM "operations"."database_restore_recovery_actions");`,
		tuplesOnly: true,
		label: 'Verify negative matrix rollback isolation'
	}).stdout.trim();
	assert.equal(counts, '1|1|1|1|1');
};

const main = async () => {
	assertHarnessBoundary();
	await applyAndVerifyMigrations();
	assertNegativeMatrix();
	assert.equal(negativeSqlCases, 15);
	for (const value of [
		fixture.sourceSha256,
		fixture.provenanceEnvelopeSha256,
		fixture.releasePayloadSha256
	]) {
		assert.match(value, SHA256);
	}
	process.stdout.write(
		'operations_control_ledger_postgres18=passed\n' +
			`negative_sql_cases=${negativeSqlCases}\n`
	);
};

await main();
