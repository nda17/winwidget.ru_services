import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

// Deliberately restricted to a labelled disposable local PostgreSQL container.
// Creates and drops only its own uniquely named database; never accepts a URL.
const container = process.env.OPERATIONS_BACKLOG_TEST_CONTAINER_ID ?? '';
const user = process.env.OPERATIONS_BACKLOG_TEST_POSTGRES_USER ?? '';
assert.match(container, /^[a-f0-9]{12,64}$/);
assert.match(user, /^[a-z][a-z0-9_]{0,62}$/);
assert.equal(process.env.OPERATIONS_BACKLOG_TEST_ALLOW_MUTATION, 'true');
const database = `operations_backlog_test_${randomUUID().replaceAll('-', '')}`;
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

let created = false;
try {
	assert.ok(
		Number(execute('SHOW server_version_num;', 'postgres')) >= 180000
	);
	execute(`CREATE DATABASE "${database}";`, 'postgres');
	created = true;
	for (const entry of readdirSync(migrations, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name >= migrationName) continue;
		execute(
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
	assert.notEqual(
		sql(migration).status,
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
	execute(migration);
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
		'PostgreSQL 18 Backlog removal: full migration chain, exact deletion, unrelated audit preservation and FK rollback passed.\n'
	);
} finally {
	if (created) execute(`DROP DATABASE "${database}";`, 'postgres');
}
