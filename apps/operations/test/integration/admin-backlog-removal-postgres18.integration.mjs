import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// Deliberately restricted to a labelled disposable local PostgreSQL container.
// Creates and drops only its own uniquely named database and two NOLOGIN roles;
// never accepts a URL or changes an existing role.
const container = process.env.OPERATIONS_BACKLOG_TEST_CONTAINER_ID ?? '';
const user = process.env.OPERATIONS_BACKLOG_TEST_POSTGRES_USER ?? '';
assert.match(container, /^[a-f0-9]{12,64}$/);
assert.match(user, /^[a-z][a-z0-9_]{0,62}$/);
assert.equal(process.env.OPERATIONS_BACKLOG_TEST_ALLOW_MUTATION, 'true');
const fixtureId = randomUUID().replaceAll('-', '');
const database = `operations_backlog_test_${fixtureId}`;
const migrationRole = `ops_backlog_migration_${fixtureId}`;
const runtimeRole = `ops_backlog_runtime_${fixtureId}`;
const migrationName = '20260910110000_remove_admin_backlog';
const migrations = new URL('../../prisma/migrations/', import.meta.url);

const run = (args, input) =>
	spawnSync('docker', args, {
		encoding: 'utf8',
		input,
		maxBuffer: 8 * 1024 * 1024,
		env: {
			...process.env,
			DOCKER_HOST: undefined,
			DOCKER_CONTEXT: undefined
		}
	});
const checked = (args, input) => {
	const result = run(args, input);
	assert.equal(result.status, 0, 'Local test command failed');
	return result.stdout.trim();
};
const context = checked(['context', 'show']);
const endpoint = checked([
	'context',
	'inspect',
	context,
	'--format',
	'{{.Endpoints.docker.Host}}'
]);
assert.ok(
	endpoint.startsWith('unix://'),
	'Only a local Unix-socket Docker context is permitted'
);
const info = JSON.parse(checked(['inspect', container]))[0];
assert.ok(
	info.Config.Labels?.['winwidget.operations-backlog-test'] === 'true' ||
		info.Config.Labels?.['winwidget.test'] === 'crm-mvp'
);
assert.equal(info.State.Running, true);
const sql = (statement, db = database) =>
	run(
		[
			'exec',
			'-i',
			container,
			'psql',
			'--no-password',
			'-X',
			'-qAt',
			'--set',
			'ON_ERROR_STOP=1',
			'--username',
			user,
			'--dbname',
			db
		],
		statement
	);
const execute = (statement, db = database) => {
	const result = sql(statement, db);
	assert.equal(result.status, 0, 'PostgreSQL fixture or migration failed');
	return result.stdout.trim();
};
const asRole = (role, statement) => {
	assert.ok(role === migrationRole || role === runtimeRole);
	return sql(`SET ROLE "${role}";\n${statement}`);
};
const migrate = statement => {
	const result = asRole(migrationRole, statement);
	assert.equal(
		result.status,
		0,
		'Restricted migration-role command failed'
	);
	return result.stdout.trim();
};

let created = false;
const createdRoles = [];
try {
	assert.ok(
		Number(execute('SHOW server_version_num;', 'postgres')) >= 180000
	);
	execute(`CREATE DATABASE "${database}";`, 'postgres');
	created = true;
	for (const role of [migrationRole, runtimeRole]) {
		execute(
			`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
			'postgres'
		);
		createdRoles.push(role);
	}
	execute(`
		REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;
		REVOKE ALL ON SCHEMA public FROM PUBLIC;
		CREATE SCHEMA operations AUTHORIZATION "${migrationRole}";
	`);
	assert.equal(
		execute(
			`SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrationRole}', '${runtimeRole}') AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;`,
			'postgres'
		),
		'2'
	);
	for (const entry of readdirSync(migrations, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name >= migrationName) continue;
		migrate(
			readFileSync(
				new URL(`${entry.name}/migration.sql`, migrations),
				'utf8'
			)
		);
	}
	execute(`
		INSERT INTO operations.notes (id, text, updated_at) VALUES ('task-1', 'disposable task', now());
		INSERT INTO operations.admin_event_logs (id, section, action, description, entity_type, entity_label, metadata)
		VALUES
		('backlog-section', 'BACKLOG', 'OTHER', 'old task', NULL, 'private task text', '{"text":"private task"}'),
		('backlog-entity', 'TASKS', 'OTHER', 'old task', 'backlog_task', 'private task text', '{}'),
		('backlog-create', 'TASKS', 'BACKLOG_TASK_CREATE', 'old task', NULL, NULL, '{}'),
		('backlog-update', 'TASKS', 'BACKLOG_TASK_UPDATE', 'old task', NULL, NULL, '{}'),
		('backlog-delete', 'TASKS', 'BACKLOG_TASK_DELETE', 'old task', NULL, NULL, '{}'),
		('keep-payment', 'PAYMENTS', 'PAYMENT_MANUAL_CHECK', 'payment', 'payment', NULL, '{"amount":100}'),
		('keep-customer', 'USERS', 'USER_UPDATE', 'CRM notes are not Backlog', 'contact', NULL, '{"notes":"customer note"}'),
		('keep-similar', 'TASKS', 'BACKLOG_TASK_CREATES', 'not an exact removed action', 'backlog_tasks', NULL, '{}');
		CREATE TABLE operations.removal_test_dependency (note_id text REFERENCES operations.notes(id));
	`);
	const unrelatedBefore = execute(
		"SELECT jsonb_agg(to_jsonb(log) ORDER BY id)::text FROM operations.admin_event_logs log WHERE id LIKE 'keep-%';"
	);
	const migration = readFileSync(
		new URL(`${migrationName}/migration.sql`, migrations),
		'utf8'
	);
	migrate(`
		GRANT USAGE ON SCHEMA operations TO "${runtimeRole}";
		GRANT SELECT, INSERT, UPDATE, DELETE ON operations.notes TO "${runtimeRole}";
	`);
	assert.notEqual(
		asRole(runtimeRole, migration).status,
		0,
		'Runtime role must not execute the destructive owner migration'
	);
	assert.equal(execute('SELECT count(*) FROM operations.notes;'), '1');
	assert.equal(
		asRole(
			runtimeRole,
			"UPDATE operations.notes SET done = true WHERE id = 'task-1';"
		).status,
		0,
		'Fixture must start with a working Notes writer'
	);
	migrate(`
		BEGIN;
		SET LOCAL lock_timeout = '5s';
		LOCK TABLE operations.notes IN ACCESS EXCLUSIVE MODE NOWAIT;
		REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON operations.notes FROM "${runtimeRole}";
		COMMIT;
	`);
	assert.notEqual(
		asRole(
			runtimeRole,
			"UPDATE operations.notes SET done = false WHERE id = 'task-1';"
		).status,
		0,
		'Notes writer must fail after the persistent phase-A privilege fence'
	);
	assert.equal(
		asRole(runtimeRole, 'SELECT count(*) FROM operations.notes;').status,
		0,
		'Phase-A fence must preserve read-only access to the still-existing table'
	);
	assert.notEqual(
		asRole(migrationRole, migration).status,
		0,
		'Unexpected FK must prevent destructive migration'
	);
	assert.equal(execute('SELECT count(*) FROM operations.notes;'), '1');
	assert.equal(
		execute('SELECT count(*) FROM operations.admin_event_logs;'),
		'8',
		'Failed DROP must roll back earlier audit deletion'
	);
	execute('DROP TABLE operations.removal_test_dependency;');
	migrate(migration);
	assert.equal(
		execute("SELECT to_regclass('operations.notes') IS NULL;"),
		't'
	);
	assert.equal(
		execute('SELECT count(*) FROM operations.admin_event_logs;'),
		'3'
	);
	assert.equal(
		execute(
			"SELECT jsonb_agg(to_jsonb(log) ORDER BY id)::text FROM operations.admin_event_logs log WHERE id LIKE 'keep-%';"
		),
		unrelatedBefore
	);
	assert.equal(
		execute(
			"SELECT to_regclass('operations.outbox_events') IS NOT NULL AND to_regclass('operations.audit_event_receipts') IS NOT NULL;"
		),
		't'
	);
	process.stdout.write(
		'PostgreSQL 18 Backlog removal: restricted migration role, runtime denial, writer fence, full migration chain, exact deletion, unrelated audit preservation and FK rollback passed.\n'
	);
} finally {
	if (created) execute(`DROP DATABASE "${database}";`, 'postgres');
	for (const role of createdRoles.reverse()) {
		execute(`DROP ROLE "${role}";`, 'postgres');
	}
}
