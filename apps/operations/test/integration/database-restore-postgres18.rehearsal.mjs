import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
	chmod,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const servicesRoot = resolve(appRoot, '../..');
const containerId =
	process.env.OPERATIONS_RESTORE_REHEARSAL_POSTGRES_CONTAINER_ID?.trim() ??
	'';
const superuser =
	process.env.OPERATIONS_RESTORE_REHEARSAL_POSTGRES_USER?.trim() ?? '';
const superuserPassword =
	process.env.OPERATIONS_RESTORE_REHEARSAL_POSTGRES_PASSWORD ?? '';
const controlDatabase =
	process.env.OPERATIONS_RESTORE_REHEARSAL_POSTGRES_DB?.trim() ?? '';

const TARGETS = [
	{
		name: 'notification-delivery',
		app: 'notification-delivery',
		environmentPrefix: 'NOTIFICATION_DELIVERY',
		database: 'winwidget_notification_delivery',
		schema: 'notification_delivery',
		adminRole: 'winwidget_notification_delivery_admin',
		migrationRole: 'winwidget_notification_delivery_migration',
		runtimeRole: 'winwidget_notification_delivery_runtime',
		backupRole: 'winwidget_notification_delivery_backup',
		acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
	},
	{
		name: 'campaigns',
		app: 'campaigns',
		environmentPrefix: 'CAMPAIGNS',
		database: 'winwidget_campaigns',
		schema: 'campaigns',
		adminRole: 'winwidget_campaigns_admin',
		migrationRole: 'winwidget_campaigns_migration',
		runtimeRole: 'winwidget_campaigns_runtime',
		backupRole: 'winwidget_campaigns_backup',
		acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
	},
	{
		name: 'reporting',
		app: 'reporting',
		environmentPrefix: 'REPORTING',
		database: 'winwidget_reporting',
		schema: 'reporting',
		adminRole: 'winwidget_reporting_admin',
		migrationRole: 'winwidget_reporting_migration',
		runtimeRole: 'winwidget_reporting_runtime',
		backupRole: 'winwidget_reporting_backup',
		acl: {
			profile: 'standard',
			routines: ['reject_report_run_snapshot_mutation()'],
			runtimeRoutines: []
		}
	},
	{
		name: 'widgets',
		app: 'widgets',
		environmentPrefix: 'WIDGETS',
		database: 'winwidget_widgets',
		schema: 'widgets',
		adminRole: 'winwidget_widgets_admin',
		migrationRole: 'winwidget_widgets_migration',
		runtimeRole: 'winwidget_widgets_runtime',
		backupRole: 'winwidget_widgets_backup',
		acl: {
			profile: 'widgets',
			routines: [
				'enforce_ai_consent_receipt_immutability()',
				'guard_wincrm_connector_update()',
				'reject_wincrm_evidence_mutation()'
			],
			runtimeRoutines: []
		}
	},
	{
		name: 'identity',
		app: 'identity',
		environmentPrefix: 'IDENTITY',
		database: 'winwidget_identity',
		schema: 'identity',
		adminRole: 'winwidget_identity_admin',
		migrationRole: 'winwidget_identity_migration',
		runtimeRole: 'winwidget_identity_runtime',
		backupRole: 'winwidget_identity_backup',
		acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
	},
	{
		name: 'platform',
		app: 'platform',
		environmentPrefix: 'PLATFORM',
		database: 'winwidget_platform',
		schema: 'platform',
		adminRole: 'winwidget_platform_admin',
		migrationRole: 'winwidget_platform_migration',
		runtimeRole: 'winwidget_platform_runtime',
		backupRole: 'winwidget_platform_backup',
		acl: {
			profile: 'platform',
			routines: [
				'current_semantic_fingerprint()',
				'enforce_billing_offer_producer_cursor()',
				'enforce_current_semantic_fingerprint()',
				'enforce_service_identity_integrity()',
				'refresh_current_semantic_fingerprint(text)'
			],
			runtimeRoutines: [
				'current_semantic_fingerprint()',
				'refresh_current_semantic_fingerprint(text)'
			]
		}
	},
	{
		name: 'support',
		app: 'support',
		environmentPrefix: 'SUPPORT',
		database: 'winwidget_support',
		schema: 'support',
		adminRole: 'winwidget_support_admin',
		migrationRole: 'winwidget_support_migration',
		runtimeRole: 'winwidget_support_runtime',
		backupRole: 'winwidget_support_backup',
		acl: {
			profile: 'standard',
			routines: ['enforce_service_identity_integrity()'],
			runtimeRoutines: []
		}
	}
];

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REHEARSAL_LABEL = 'winwidget.operations-restore-rehearsal';
const REHEARSAL_LABEL_VALUE = 'true';
const EXPECTED_CONTROL_DATABASE = 'operations_restore_rehearsal_control';
const EXPECTED_SUPERUSER = 'operations_restore_rehearsal_superuser';
const dumpPaths = new Map();
const fenceMarkers = new Map();
const writerSessions = [];
let temporaryRoot;
let ownsFixtureState = false;
let activeAdminTarget = null;

const quoteIdentifier = value => {
	assert.match(
		value,
		IDENTIFIER,
		`Unsafe PostgreSQL identifier: ${value}`
	);
	return `"${value}"`;
};

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

const safeOutput = value =>
	String(value ?? '')
		.trim()
		.slice(-4_000);

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
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
	if (options.expectFailure) {
		if (result.status === 0) {
			throw new Error(
				`${options.label ?? command} unexpectedly succeeded`
			);
		}
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
	user = superuser,
	database = controlDatabase,
	password = superuserPassword,
	sql,
	tuplesOnly = false,
	expectFailure = false,
	verbose = false,
	label = 'PostgreSQL command'
}) =>
	containerCommand(
		'psql',
		[
			'--no-password',
			'--set',
			'ON_ERROR_STOP=1',
			...(verbose ? ['--set', 'VERBOSITY=verbose'] : []),
			'--host',
			'127.0.0.1',
			'--port',
			'5432',
			'--username',
			user,
			'--dbname',
			database,
			...(tuplesOnly ? ['--tuples-only', '--no-align'] : []),
			'--command',
			sql
		],
		{
			environment: { PGPASSWORD: password },
			expectFailure,
			label
		}
	);

const pgDump = (target, output, options = {}) =>
	containerCommand(
		'pg_dump',
		[
			'--format=custom',
			'--no-owner',
			'--no-privileges',
			'--no-password',
			'--host',
			'127.0.0.1',
			'--port',
			'5432',
			'--username',
			options.user ?? target.backupRole,
			'--dbname',
			target.database,
			...options.schemas.flatMap(schema => ['--schema', schema]),
			'--file',
			output
		],
		{
			environment: {
				PGPASSWORD: options.password ?? target.passwords.backup
			},
			expectFailure: options.expectFailure,
			label: options.label ?? `pg_dump ${target.name}`
		}
	);

const waitForPostgres = async () => {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const result = containerCommand(
			'pg_isready',
			['--username', superuser, '--dbname', controlDatabase],
			{ allowFailure: true, label: 'PostgreSQL readiness probe' }
		);
		if (result.status === 0) return;
		await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
	}
	throw new Error('PostgreSQL 18 did not become ready after restart');
};

const restartPostgres = async () => {
	docker(['restart', containerId], {
		label: 'Ephemeral PostgreSQL restart'
	});
	await waitForPostgres();
};

const expectReject = async (operation, pattern, label) => {
	try {
		await operation();
	} catch (error) {
		assert.match(
			error instanceof Error ? error.message : String(error),
			pattern
		);
		return;
	}
	throw new Error(`${label} unexpectedly succeeded`);
};

const rolePassword = (target, role) =>
	`rehearsal-${TARGETS.indexOf(target) + 1}-${role}-only-A9`;

const targetConfiguration = target => ({
	...target,
	passwords: {
		admin: rolePassword(target, 'admin'),
		migration: rolePassword(target, 'migration'),
		runtime: rolePassword(target, 'runtime'),
		backup: rolePassword(target, 'backup')
	}
});

const configuredTargets = TARGETS.map(targetConfiguration);
const operationId = (target, generation = 1) =>
	`00000000-0000-4${String(generation).padStart(3, '0')}-8${String(
		TARGETS.indexOf(target) + 1
	).padStart(
		3,
		'0'
	)}-${String(TARGETS.indexOf(target) + 1).padStart(12, '0')}`;

const assertHarnessBoundary = () => {
	if (process.env.OPERATIONS_RESTORE_REHEARSAL_ALLOW_MUTATION !== 'true') {
		throw new Error(
			'OPERATIONS_RESTORE_REHEARSAL_ALLOW_MUTATION=true is required'
		);
	}
	assert.match(
		containerId,
		CONTAINER_ID,
		'A concrete Docker container ID is required'
	);
	assert.equal(superuser, EXPECTED_SUPERUSER);
	assert.equal(controlDatabase, EXPECTED_CONTROL_DATABASE);
	assert.ok(
		superuserPassword.length >= 16,
		'Ephemeral PostgreSQL password is invalid'
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
		'The PostgreSQL container is not explicitly marked as an Operations restore rehearsal fixture'
	);
	const version = psql({
		sql: 'SHOW server_version_num;',
		tuplesOnly: true,
		label: 'PostgreSQL version verification'
	}).stdout.trim();
	assert.match(
		version,
		/^18\d{4}$/,
		'The rehearsal requires PostgreSQL 18'
	);
	const identity = psql({
		sql: "SELECT current_user || E'\\n' || current_database();",
		tuplesOnly: true,
		label: 'Ephemeral PostgreSQL identity verification'
	}).stdout.trim();
	assert.equal(
		identity,
		`${EXPECTED_SUPERUSER}\n${EXPECTED_CONTROL_DATABASE}`
	);
	const fixtureNames = configuredTargets.flatMap(target => [
		target.database,
		target.adminRole,
		target.migrationRole,
		target.runtimeRole,
		target.backupRole
	]);
	const existing = psql({
		sql: `SELECT name FROM (
			SELECT datname AS name FROM pg_database
			UNION ALL SELECT rolname AS name FROM pg_roles
		) AS names WHERE name IN (${fixtureNames.map(literal).join(', ')}) ORDER BY name;`,
		tuplesOnly: true,
		label: 'Rehearsal fixture preflight'
	}).stdout.trim();
	assert.equal(
		existing,
		'',
		'The marked rehearsal container is not a clean fixture'
	);
};

const bootstrapTarget = target => {
	const roleSql = [
		`CREATE ROLE ${quoteIdentifier(target.adminRole)} NOLOGIN SUPERUSER PASSWORD ${literal(target.passwords.admin)};`,
		`CREATE ROLE ${quoteIdentifier(target.migrationRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(target.passwords.migration)};`,
		`CREATE ROLE ${quoteIdentifier(target.runtimeRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(target.passwords.runtime)};`,
		`CREATE ROLE ${quoteIdentifier(target.backupRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(target.passwords.backup)};`
	].join('\n');
	psql({
		sql: roleSql,
		label: `Create isolated roles for ${target.name}`
	});
	psql({
		sql: `CREATE DATABASE ${quoteIdentifier(target.database)} OWNER ${quoteIdentifier(target.adminRole)};`,
		label: `Create isolated database for ${target.name}`
	});
	psql({
		database: target.database,
		sql: [
			`SET ROLE ${quoteIdentifier(target.adminRole)};`,
			`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(target.database)} FROM PUBLIC;`,
			`GRANT CONNECT ON DATABASE ${quoteIdentifier(target.database)} TO ${quoteIdentifier(target.migrationRole)}, ${quoteIdentifier(target.runtimeRole)}, ${quoteIdentifier(target.backupRole)};`,
			`CREATE SCHEMA ${quoteIdentifier(target.schema)} AUTHORIZATION ${quoteIdentifier(target.migrationRole)};`,
			`REVOKE ALL PRIVILEGES ON SCHEMA ${quoteIdentifier(target.schema)} FROM PUBLIC;`,
			`SET ROLE ${quoteIdentifier(target.migrationRole)};`,
			`CREATE TABLE ${quoteIdentifier(target.schema)}."_prisma_migrations" (
				id VARCHAR(36) PRIMARY KEY,
				checksum VARCHAR(64) NOT NULL,
				finished_at TIMESTAMPTZ,
				migration_name VARCHAR(255) NOT NULL,
				logs TEXT,
				rolled_back_at TIMESTAMPTZ,
				started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				applied_steps_count INTEGER NOT NULL DEFAULT 0
			);`
		].join('\n'),
		label: `Bootstrap schema for ${target.name}`
	});
};

const selectExclusiveAdmin = target => {
	if (!activeAdminTarget) {
		psql({
			sql: [
				...configuredTargets.map(
					candidate =>
						`ALTER ROLE ${quoteIdentifier(candidate.adminRole)} ${candidate === target ? 'LOGIN' : 'NOLOGIN'};`
				),
				`ALTER ROLE ${quoteIdentifier(superuser)} NOLOGIN;`
			].join('\n'),
			label: `Select exclusive bootstrap admin ${target.name}`
		});
		activeAdminTarget = target;
		return;
	}
	const previous = activeAdminTarget;
	psql({
		user: previous.adminRole,
		database: previous.database,
		password: previous.passwords.admin,
		sql: `ALTER ROLE ${quoteIdentifier(target.adminRole)} LOGIN;
			ALTER ROLE ${quoteIdentifier(previous.adminRole)} NOLOGIN;`,
		label: `Rotate exclusive bootstrap admin ${previous.name} to ${target.name}`
	});
	activeAdminTarget = target;
};

const restoreControlLogin = () => {
	if (!activeAdminTarget) return;
	const active = activeAdminTarget;
	psql({
		user: active.adminRole,
		database: active.database,
		password: active.passwords.admin,
		sql: `ALTER ROLE ${quoteIdentifier(superuser)} LOGIN;
			ALTER ROLE ${quoteIdentifier(active.adminRole)} NOLOGIN;`,
		label: `Restore rehearsal control role after ${active.name}`
	});
	activeAdminTarget = null;
};

const readTrustedManifest = async () => {
	const manifest = JSON.parse(
		await readFile(
			join(appRoot, 'restore-manifests/database-restore-migrations.json'),
			'utf8'
		)
	);
	assert.deepEqual(
		Object.keys(manifest.targets).sort(),
		TARGETS.map(({ name }) => name).sort()
	);
	for (const target of configuredTargets) {
		const targetManifest = manifest.targets[target.name];
		assert.match(targetManifest.manifestSha256, SHA256);
		const migrationsDirectory = join(
			servicesRoot,
			'apps',
			target.app,
			'prisma',
			'migrations'
		);
		const names = (
			await readdir(migrationsDirectory, { withFileTypes: true })
		)
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.sort();
		assert.deepEqual(
			names,
			targetManifest.migrations.map(migration => migration.name),
			`Trusted migration set drifted for ${target.name}`
		);
		for (const migration of targetManifest.migrations) {
			const sql = await readFile(
				join(migrationsDirectory, migration.name, 'migration.sql')
			);
			assert.equal(
				createHash('sha256').update(sql).digest('hex'),
				migration.checksum,
				`Trusted migration checksum drifted for ${target.name}/${migration.name}`
			);
		}
	}
	return manifest;
};

const applyMigrations = async (target, targetManifest) => {
	const migrationsDirectory = join(
		servicesRoot,
		'apps',
		target.app,
		'prisma',
		'migrations'
	);
	for (const [index, migration] of targetManifest.migrations.entries()) {
		const migrationSql = await readFile(
			join(migrationsDirectory, migration.name, 'migration.sql'),
			'utf8'
		);
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};\n${migrationSql}`,
			label: `Apply ${target.name}/${migration.name}`
		});
		const migrationId = `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};
				INSERT INTO ${quoteIdentifier(target.schema)}."_prisma_migrations"
				(id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
				VALUES (${literal(migrationId)}, ${literal(migration.checksum)}, now(), ${literal(migration.name)}, NULL, NULL, now(), 1);`,
			label: `Record ${target.name}/${migration.name}`
		});
	}
};

const migrationLedger = (processService, connection, target) =>
	processService.readMigrationLedger(connection, target);

const installClientWrappers = async directory => {
	for (const command of ['psql', 'pg_restore', 'pg_dump']) {
		const path = join(directory, command);
		await writeFile(
			path,
			`#!/bin/sh\nexec docker exec -i -e PGPASSWORD="$PGPASSWORD" ${containerId} ${command} "$@"\n`,
			{ mode: 0o700 }
		);
		await chmod(path, 0o700);
	}
	process.env.PATH = `${directory}:${process.env.PATH}`;
};

const assertWidgetsNativeAcl = async (aclService, target) => {
	const connection = targetConnection(target);
	const schema = quoteIdentifier(target.schema);
	const runtime = quoteIdentifier(target.runtimeRole);
	const migration = quoteIdentifier(target.migrationRole);
	const execute = (sql, label, extra = {}) =>
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql,
			label,
			...extra
		});
	const tables = [
		'wincrm_connectors',
		'wincrm_connector_commands',
		'wincrm_transfer_intents'
	];
	const assertPrivileges = () => {
		const checks = tables.flatMap(table =>
			[
				'SELECT',
				'INSERT',
				'UPDATE',
				'DELETE',
				'TRUNCATE',
				'REFERENCES',
				'TRIGGER'
			].map(privilege => {
				const allowed =
					['SELECT', 'INSERT'].includes(privilege) ||
					(table === 'wincrm_connectors' && privilege === 'UPDATE');
				return `has_table_privilege(${literal(target.runtimeRole)}, ${literal(`${target.schema}.${table}`)}, ${literal(privilege)}) = ${allowed}`;
			})
		);
		for (const routine of target.acl.routines)
			checks.push(
				`NOT has_function_privilege(${literal(target.runtimeRole)}, ${literal(`${target.schema}.${routine}`)}, 'EXECUTE')`
			);
		checks.push(
			`has_table_privilege(${literal(target.runtimeRole)}, ${literal(`${target.schema}.widgets`)}, 'DELETE')`
		);
		assert.equal(
			execute(
				`SELECT ${checks.join(' AND ')};`,
				'Verify exact Widgets native privileges',
				{ tuplesOnly: true }
			).stdout.trim(),
			't'
		);
	};
	assertPrivileges();
	// Rehearse repairing a prior STANDARD grant instead of only proving a fresh ACL.
	execute(
		`SET ROLE ${migration}; GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tables.map(table => `${schema}.${quoteIdentifier(table)}`).join(', ')} TO ${runtime};`,
		'Inject broad Widgets native grants'
	);
	await expectReject(
		() => aclService.verify(connection, target),
		/table privileges drifted/i,
		'Reject broad Widgets native grants'
	);
	await aclService.reconcileAndVerify(connection, target);
	assertPrivileges();
	for (const table of tables) {
		for (const sql of [
			`DELETE FROM ${schema}.${quoteIdentifier(table)} WHERE FALSE;`,
			`TRUNCATE ${schema}.${quoteIdentifier(table)};`,
			...(table === 'wincrm_connectors'
				? []
				: [
						`UPDATE ${schema}.${quoteIdentifier(table)} SET ${table === 'wincrm_connector_commands' ? 'command_id = command_id' : 'id = id'} WHERE FALSE;`
					])
		]) {
			const rejected = execute(
				`SET ROLE ${runtime}; ${sql}`,
				'Reject forbidden Widgets native runtime DML',
				{ expectFailure: true, verbose: true }
			);
			assert.match(rejected.stderr, /42501/);
		}
	}
	const routine = 'guard_wincrm_connector_update';
	execute(
		`SET ROLE ${migration}; ALTER FUNCTION ${schema}.${quoteIdentifier(routine)}() RENAME TO restore_rehearsal_missing_native_routine;`,
		'Inject missing Widgets native routine'
	);
	try {
		await expectReject(
			() => aclService.verify(connection, target),
			/routine allowlist drifted/i,
			'Reject missing Widgets native routine'
		);
	} finally {
		execute(
			`SET ROLE ${migration}; ALTER FUNCTION ${schema}.restore_rehearsal_missing_native_routine() RENAME TO ${quoteIdentifier(routine)};`,
			'Restore Widgets native routine name'
		);
	}
	execute(
		`SET ROLE ${migration}; CREATE FUNCTION ${schema}.${quoteIdentifier(routine)}(integer) RETURNS integer LANGUAGE SQL AS 'SELECT 1';`,
		'Inject unexpected Widgets routine overload'
	);
	try {
		await expectReject(
			() => aclService.verify(connection, target),
			/routine allowlist drifted/i,
			'Reject unexpected Widgets routine signature'
		);
	} finally {
		execute(
			`SET ROLE ${migration}; DROP FUNCTION ${schema}.${quoteIdentifier(routine)}(integer);`,
			'Remove Widgets rehearsal routine overload'
		);
	}
	execute(
		`SET ROLE ${migration}; GRANT EXECUTE ON FUNCTION ${schema}.${quoteIdentifier(routine)}() TO ${runtime};`,
		'Inject Widgets runtime EXECUTE drift'
	);
	await expectReject(
		() => aclService.verify(connection, target),
		/routine privileges drifted/i,
		'Reject Widgets runtime EXECUTE'
	);
	await aclService.reconcileAndVerify(connection, target);
	assertPrivileges();
};

const assertExactAclWithInjectedDrift = async (
	aclService,
	processService,
	target
) => {
	const connection = targetConnection(target);
	try {
		await aclService.reconcileAndVerify(connection, target);
	} catch (error) {
		const actual = psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SELECT relation.relname, COALESCE(grantee.rolname, 'PUBLIC'),
				privilege.privilege_type, grantor.rolname, privilege.is_grantable
			FROM pg_class AS relation
			CROSS JOIN LATERAL aclexplode(
				COALESCE(relation.relacl, acldefault('r', relation.relowner))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE relation.relnamespace = ${literal(target.schema)}::regnamespace
				AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
				AND privilege.grantee <> relation.relowner
			ORDER BY 1, 2, 3, 4;`,
			tuplesOnly: true,
			label: `Read failed ACL evidence ${target.name}`
		}).stdout.trim();
		throw new Error(
			`${target.name} ACL reconciliation failed: ${error instanceof Error ? error.message : String(error)}; actual=${actual}`
		);
	}
	if (target.name === 'widgets')
		await assertWidgetsNativeAcl(aclService, target);
	if (target !== configuredTargets[0]) return;
	const table = psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SELECT relname FROM pg_class
			WHERE relnamespace = ${literal(target.schema)}::regnamespace
				AND relkind IN ('r', 'p') AND relname <> '_prisma_migrations'
			ORDER BY relname LIMIT 1;`,
		tuplesOnly: true,
		label: 'Select ACL drift probe table'
	}).stdout.trim();
	assert.match(table, IDENTIFIER);
	const foreignRuntime = configuredTargets[1].runtimeRole;
	psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};
			GRANT SELECT ON TABLE ${quoteIdentifier(target.schema)}.${quoteIdentifier(table)} TO ${quoteIdentifier(foreignRuntime)};`,
		label: 'Inject ACL drift'
	});
	await expectReject(
		() => aclService.verify(connection, target),
		/ACL|privileges|drifted/i,
		'Exact ACL drift rejection'
	);
	psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};
			REVOKE SELECT ON TABLE ${quoteIdentifier(target.schema)}.${quoteIdentifier(table)} FROM ${quoteIdentifier(foreignRuntime)};`,
		label: 'Remove ACL drift fixture'
	});
	await aclService.reconcileAndVerify(connection, target);
	await processService.executeSql(connection, 'SELECT 1;');
};

const createAndValidateDumps = async (
	target,
	targetManifest,
	artifactValidator,
	manifestService
) => {
	const validContainerPath = `/tmp/winwidget-restore-rehearsal-${target.name}.dump`;
	const validHostPath = join(temporaryRoot, `${target.name}.dump`);
	pgDump(target, validContainerPath, {
		schemas: [target.schema],
		label: `Create source dump for ${target.name}`
	});
	docker(['cp', `${containerId}:${validContainerPath}`, validHostPath], {
		label: `Copy source dump for ${target.name}`
	});
	const sha256 = await artifactValidator.sha256(validHostPath);
	assert.match(sha256, SHA256);
	artifactValidator.assertChecksum(sha256, sha256);
	await expectReject(
		() => artifactValidator.assertChecksum(sha256, '0'.repeat(64)),
		/checksum mismatch/i,
		'Source SHA-256 mismatch rejection'
	);
	const toc = containerCommand(
		'pg_restore',
		['--list', validContainerPath],
		{
			label: `Read source TOC for ${target.name}`
		}
	).stdout;
	artifactValidator.assertTableOfContents(toc, target);
	const ledger = containerCommand(
		'pg_restore',
		[
			'--data-only',
			'--strict-names',
			'--schema',
			target.schema,
			'--table',
			'_prisma_migrations',
			'--file',
			'-',
			validContainerPath
		],
		{ label: `Read source ledger for ${target.name}` }
	).stdout;
	manifestService.assertDumpLedger(target.name, target.schema, ledger);

	const firstMigration = targetManifest.migrations[0];
	const invalidChecksum =
		firstMigration.checksum === '0'.repeat(64)
			? '1'.repeat(64)
			: '0'.repeat(64);
	const badLedgerPath = `/tmp/winwidget-restore-rehearsal-${target.name}-bad-ledger.dump`;
	try {
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};
				UPDATE ${quoteIdentifier(target.schema)}."_prisma_migrations"
				SET checksum = ${literal(invalidChecksum)}
				WHERE migration_name = ${literal(firstMigration.name)};`,
			label: `Inject incompatible ledger for ${target.name}`
		});
		pgDump(target, badLedgerPath, {
			user: target.adminRole,
			password: target.passwords.admin,
			schemas: [target.schema],
			label: `Create incompatible-ledger dump for ${target.name}`
		});
		const badLedger = containerCommand(
			'pg_restore',
			[
				'--data-only',
				'--strict-names',
				'--schema',
				target.schema,
				'--table',
				'_prisma_migrations',
				'--file',
				'-',
				badLedgerPath
			],
			{ label: `Read incompatible ledger for ${target.name}` }
		).stdout;
		await expectReject(
			() =>
				manifestService.assertDumpLedger(
					target.name,
					target.schema,
					badLedger
				),
			/migration ledger|manifest|checksum|does not match/i,
			`Incompatible migration ledger rejection for ${target.name}`
		);
	} finally {
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SET ROLE ${quoteIdentifier(target.migrationRole)};
				UPDATE ${quoteIdentifier(target.schema)}."_prisma_migrations"
				SET checksum = ${literal(firstMigration.checksum)}
				WHERE migration_name = ${literal(firstMigration.name)};`,
			label: `Restore exact ledger for ${target.name}`
		});
	}

	const rogueSchema = `restore_rehearsal_${target.schema}`;
	const badTocPath = `/tmp/winwidget-restore-rehearsal-${target.name}-bad-toc.dump`;
	try {
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `CREATE SCHEMA ${quoteIdentifier(rogueSchema)} AUTHORIZATION ${quoteIdentifier(target.migrationRole)};`,
			label: `Create cross-schema TOC fixture for ${target.name}`
		});
		pgDump(target, badTocPath, {
			user: target.adminRole,
			password: target.passwords.admin,
			schemas: [target.schema, rogueSchema],
			label: `Create incompatible-TOC dump for ${target.name}`
		});
		const badToc = containerCommand('pg_restore', ['--list', badTocPath], {
			label: `Read incompatible TOC for ${target.name}`
		}).stdout;
		await expectReject(
			() => artifactValidator.assertTableOfContents(badToc, target),
			/only the target service schema|exact target schema/i,
			`Cross-schema TOC rejection for ${target.name}`
		);
	} finally {
		psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `DROP SCHEMA IF EXISTS ${quoteIdentifier(rogueSchema)} CASCADE;`,
			label: `Drop cross-schema TOC fixture for ${target.name}`
		});
	}

	const noSpace = pgDump(target, '/dev/full', {
		user: target.adminRole,
		password: target.passwords.admin,
		schemas: [target.schema],
		expectFailure: true,
		label: `Deterministic no-space injection for ${target.name}`
	});
	assert.match(noSpace.stderr, /No space left on device|ENOSPC/i);
	dumpPaths.set(target.name, {
		container: validContainerPath,
		host: validHostPath,
		sha256
	});
};

const writerRoles = target => [
	{
		kind: 'runtime',
		role: target.runtimeRole,
		password: target.passwords.runtime
	},
	{
		kind: 'migration',
		role: target.migrationRole,
		password: target.passwords.migration
	},
	{
		kind: 'backup',
		role: target.backupRole,
		password: target.passwords.backup
	}
];

const startWriterSession = (target, writer) => {
	const applicationName = `restore_rehearsal_${target.schema}_${writer.kind}`;
	const child = spawn(
		'docker',
		[
			'exec',
			'-i',
			'--env',
			`PGPASSWORD=${writer.password}`,
			containerId,
			'psql',
			'--no-password',
			'--host',
			'127.0.0.1',
			'--username',
			writer.role,
			'--dbname',
			target.database,
			'--command',
			`SET application_name = ${literal(applicationName)}; SELECT pg_sleep(300);`
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	child.stdout?.resume();
	child.stderr?.resume();
	writerSessions.push(child);
	return { child, applicationName, writer };
};

const waitForWriterSession = async (target, writer, applicationName) => {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const count = psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SELECT count(*) FROM pg_stat_activity
				WHERE datname = ${literal(target.database)}
					AND usename = ${literal(writer.role)}
					AND application_name = ${literal(applicationName)};`,
			tuplesOnly: true,
			label: `Wait for ${writer.kind} session ${target.name}`
		}).stdout.trim();
		if (count === '1') return;
		await new Promise(resolvePromise => setTimeout(resolvePromise, 125));
	}
	throw new Error(
		`Writer session ${target.name}/${writer.kind} did not start`
	);
};

const waitForChildExit = child =>
	new Promise((resolvePromise, rejectPromise) => {
		if (child.exitCode !== null) return resolvePromise(child.exitCode);
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			rejectPromise(new Error('Terminated writer session did not exit'));
		}, 5_000);
		child.once('exit', code => {
			clearTimeout(timeout);
			resolvePromise(code);
		});
	});

const targetConnection = target => ({
	host: '127.0.0.1',
	port: 5432,
	user: target.adminRole,
	database: target.database,
	password: target.passwords.admin
});

const applyWriterFence = async (
	target,
	writerFenceService,
	generation = 1
) => {
	try {
		const evidence = await writerFenceService.apply(
			targetConnection(target),
			target,
			operationId(target, generation)
		);
		fenceMarkers.set(target.name, evidence.evidenceSha256);
		return evidence;
	} catch (error) {
		const sessions = psql({
			user: target.adminRole,
			database: target.database,
			password: target.passwords.admin,
			sql: `SELECT usename, application_name, state FROM pg_stat_activity
				WHERE datname = ${literal(target.database)}
					AND usename IN (${writerRoles(target)
						.map(writer => literal(writer.role))
						.join(', ')}) ORDER BY usename, application_name;`,
			tuplesOnly: true,
			label: `Read failed writer fence evidence ${target.name}`
		}).stdout.trim();
		throw new Error(
			`${target.name} writer fence failed: ${error instanceof Error ? error.message : String(error)}; sessions=${sessions}`
		);
	}
};

const assertWritersFenced = async (target, writerFenceService) => {
	let evidence;
	try {
		evidence = await writerFenceService.verify(
			targetConnection(target),
			target,
			fenceMarkers.get(target.name)
		);
	} catch (error) {
		throw new Error(
			`${target.name} writer fence verification failed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	assert.deepEqual(
		evidence.roles,
		writerRoles(target).map(writer => writer.role)
	);
	assert.match(evidence.evidenceSha256, SHA256);
	const roleStates = psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SELECT rolname || ':' || rolcanlogin::text FROM pg_roles
			WHERE rolname IN (${writerRoles(target)
				.map(writer => literal(writer.role))
				.join(', ')}) ORDER BY rolname;`,
		tuplesOnly: true,
		label: `Read writer fence ${target.name}`
	}).stdout.trim();
	assert.deepEqual(
		roleStates.split('\n'),
		writerRoles(target)
			.map(writer => `${writer.role}:false`)
			.sort()
	);
	const sessions = psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SELECT count(*) FROM pg_stat_activity
			WHERE datname = ${literal(target.database)}
				AND usename IN (${writerRoles(target)
					.map(writer => literal(writer.role))
					.join(', ')});`,
		tuplesOnly: true,
		label: `Verify terminated writer sessions ${target.name}`
	}).stdout.trim();
	assert.equal(sessions, '0');
	for (const writer of writerRoles(target)) {
		const rejection = psql({
			user: writer.role,
			database: target.database,
			password: writer.password,
			sql: 'SELECT 1;',
			expectFailure: true,
			label: `Reject new ${writer.kind} login ${target.name}`
		});
		assert.match(rejection.stderr, /not permitted to log in/i);
	}
};

const assertForeignGenerationCannotTakeOverAndStaleCannotRelease = async (
	target,
	writerFenceService
) => {
	const currentMarker = fenceMarkers.get(target.name);
	assert.match(currentMarker, SHA256);
	const sameOperationTakeover = await applyWriterFence(
		target,
		writerFenceService,
		1
	);
	assert.equal(sameOperationTakeover.evidenceSha256, currentMarker);
	await expectReject(
		() => applyWriterFence(target, writerFenceService, 2),
		/generation marker drifted/i,
		`Foreign writer-fence generation takeover ${target.name}`
	);
	assert.equal(fenceMarkers.get(target.name), currentMarker);
	await assertWritersFenced(target, writerFenceService);
	await writerFenceService.release(
		targetConnection(target),
		target,
		currentMarker
	);
	const replacement = await applyWriterFence(
		target,
		writerFenceService,
		2
	);
	assert.notEqual(replacement.evidenceSha256, currentMarker);
	await expectReject(
		() =>
			writerFenceService.release(
				targetConnection(target),
				target,
				currentMarker
			),
		/generation marker drifted/i,
		`Stale writer-fence generation release ${target.name}`
	);
	await assertWritersFenced(target, writerFenceService);
};

const assertTargetIsolation = target => {
	const targetIndex = configuredTargets.indexOf(target);
	const foreignTarget =
		configuredTargets[(targetIndex + 1) % configuredTargets.length];
	for (const writer of writerRoles(target)) {
		const rejection = psql({
			user: writer.role,
			database: foreignTarget.database,
			password: writer.password,
			sql: 'SELECT 1;',
			expectFailure: true,
			label: `Reject ${target.name} ${writer.kind} on ${foreignTarget.name}`
		});
		assert.match(rejection.stderr, /permission denied for database/i);
	}
};

const restoreWhileFenced = async (
	target,
	processService,
	aclService,
	manifestService,
	writerFenceService
) => {
	const connection = targetConnection(target);
	const dump = dumpPaths.get(target.name);
	assert.ok(dump);
	await processService.recreateSchema(connection, target);
	await processService.restoreSchema(connection, target, dump.container);
	await aclService.reconcileAndVerify(
		connection,
		target,
		undefined,
		'FENCED'
	);
	const ledger = await migrationLedger(processService, connection, target);
	manifestService.assertDatabaseLedger(target.name, ledger);
	const currentRole = psql({
		user: target.adminRole,
		database: target.database,
		password: target.passwords.admin,
		sql: `SET ROLE ${quoteIdentifier(target.migrationRole)}; SELECT current_user;`,
		tuplesOnly: true,
		label: `Verify admin SET ROLE migration ${target.name}`
	}).stdout.trim();
	assert.equal(currentRole.split('\n').at(-1), target.migrationRole);
	await assertWritersFenced(target, writerFenceService);
};

const unfenceAndVerify = async (
	target,
	aclService,
	manifestService,
	processService,
	writerFenceService
) => {
	const connection = targetConnection(target);
	const evidence = await writerFenceService.release(
		connection,
		target,
		fenceMarkers.get(target.name)
	);
	assert.match(evidence.evidenceSha256, SHA256);
	await aclService.verify(connection, target);
	manifestService.assertDatabaseLedger(
		target.name,
		await migrationLedger(processService, connection, target)
	);
	for (const writer of writerRoles(target)) {
		const identity = psql({
			user: writer.role,
			database: target.database,
			password: writer.password,
			sql: 'SELECT current_user;',
			tuplesOnly: true,
			label: `Verify own ${writer.kind} login ${target.name}`
		}).stdout.trim();
		assert.equal(identity, writer.role);
	}
	assertTargetIsolation(target);
};

const cleanup = async () => {
	for (const child of writerSessions) {
		if (child.exitCode === null) child.kill('SIGKILL');
	}
	if (ownsFixtureState) {
		try {
			await waitForPostgres();
			restoreControlLogin();
			for (const target of configuredTargets) {
				psql({
					sql: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
						WHERE datname = ${literal(target.database)} AND pid <> pg_backend_pid();`,
					label: `Terminate rehearsal sessions ${target.name}`
				});
				psql({
					sql: `DROP DATABASE IF EXISTS ${quoteIdentifier(target.database)};`,
					label: `Drop rehearsal database ${target.name}`
				});
			}
			for (const target of [...configuredTargets].reverse()) {
				psql({
					sql: `DROP ROLE IF EXISTS ${quoteIdentifier(target.backupRole)};
						DROP ROLE IF EXISTS ${quoteIdentifier(target.runtimeRole)};
						DROP ROLE IF EXISTS ${quoteIdentifier(target.migrationRole)};
						DROP ROLE IF EXISTS ${quoteIdentifier(target.adminRole)};`,
					label: `Drop rehearsal roles ${target.name}`
				});
			}
		} catch (error) {
			console.error(
				`Rehearsal fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	if (CONTAINER_ID.test(containerId)) {
		for (const target of configuredTargets) {
			containerCommand(
				'rm',
				[
					'-f',
					`/tmp/winwidget-restore-rehearsal-${target.name}.dump`,
					`/tmp/winwidget-restore-rehearsal-${target.name}-bad-ledger.dump`,
					`/tmp/winwidget-restore-rehearsal-${target.name}-bad-toc.dump`
				],
				{
					allowFailure: true,
					label: `Remove dump fixtures ${target.name}`
				}
			);
		}
	}
	if (temporaryRoot)
		await rm(temporaryRoot, { recursive: true, force: true });
};

try {
	process.chdir(appRoot);
	assertHarnessBoundary();
	temporaryRoot = await mkdtemp(
		join(tmpdir(), 'winwidget-operations-restore-')
	);
	await installClientWrappers(temporaryRoot);
	const trustedManifest = await readTrustedManifest();
	const require = createRequire(import.meta.url);
	require('reflect-metadata');
	const { DatabaseRestoreProcessService } = require(
		join(appRoot, 'dist/src/restore/database-restore-process.service.js')
	);
	const { DatabaseRestoreAclService } = require(
		join(appRoot, 'dist/src/restore/database-restore-acl.service.js')
	);
	const { DatabaseRestoreArtifactValidatorService } = require(
		join(
			appRoot,
			'dist/src/restore/database-restore-artifact-validator.service.js'
		)
	);
	const { DatabaseRestoreMigrationManifestService } = require(
		join(
			appRoot,
			'dist/src/restore/database-restore-migration-manifest.service.js'
		)
	);
	const { DatabaseRestoreWriterFenceService } = require(
		join(
			appRoot,
			'dist/src/restore/database-restore-writer-fence.service.js'
		)
	);
	const processService = new DatabaseRestoreProcessService();
	const aclService = new DatabaseRestoreAclService(processService);
	const artifactValidator = new DatabaseRestoreArtifactValidatorService();
	const manifestService = new DatabaseRestoreMigrationManifestService();
	const writerFenceService = new DatabaseRestoreWriterFenceService(
		processService
	);

	ownsFixtureState = true;
	for (const target of configuredTargets) bootstrapTarget(target);
	for (const target of configuredTargets) {
		selectExclusiveAdmin(target);
		await applyMigrations(target, trustedManifest.targets[target.name]);
		const connection = targetConnection(target);
		manifestService.assertDatabaseLedger(
			target.name,
			await migrationLedger(processService, connection, target)
		);
		await assertExactAclWithInjectedDrift(
			aclService,
			processService,
			target
		);
		await createAndValidateDumps(
			target,
			trustedManifest.targets[target.name],
			artifactValidator,
			manifestService
		);
		assertTargetIsolation(target);

		const sessions = writerRoles(target).map(writer => ({
			target,
			...startWriterSession(target, writer)
		}));
		for (const session of sessions) {
			await waitForWriterSession(
				session.target,
				session.writer,
				session.applicationName
			);
		}
		const evidence = await applyWriterFence(target, writerFenceService);
		assert.match(evidence.evidenceSha256, SHA256);
		for (const session of sessions) {
			const exitCode = await waitForChildExit(session.child);
			assert.notEqual(exitCode, 0, `Writer session was not terminated`);
		}
		await assertWritersFenced(target, writerFenceService);

		await restartPostgres();
		await assertWritersFenced(target, writerFenceService);
		await assertForeignGenerationCannotTakeOverAndStaleCannotRelease(
			target,
			writerFenceService
		);
		await restoreWhileFenced(
			target,
			processService,
			aclService,
			manifestService,
			writerFenceService
		);
		await restartPostgres();
		await assertWritersFenced(target, writerFenceService);
		await unfenceAndVerify(
			target,
			aclService,
			manifestService,
			processService,
			writerFenceService
		);
	}
	restoreControlLogin();

	console.log(
		`Operations restore PostgreSQL 18 rehearsal passed for ${configuredTargets.length} isolated targets`
	);
} finally {
	await cleanup();
}
