// Opt-in, disposable PostgreSQL clusters only. Never accepts a database URL,
// existing container or production target. Credentials stay in child env/stdin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
	readDatabaseAccess,
	databaseBootstrapSql,
	databaseRuntimeGrantsSql
} from './database-access.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const services = [
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales'
];
const image =
	'postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296';
const args = process.argv.slice(2);
assert.ok(args.length === 2 && ['--local', '--ci'].includes(args[0]));
assert.ok(services.includes(args[1]) || args[1] === 'all');
const ci = args[0] === '--ci';
assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
if (ci)
	assert.ok(
		process.env.CI === 'true' &&
			process.env.GITHUB_REPOSITORY === 'nda17/winwidget.ru_services'
	);
else assert.equal(process.platform, 'darwin');

let stage = 'local-context';
const execute = (bin, argv, options = {}) =>
	spawnSync(bin, argv, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 180000,
		maxBuffer: 8 * 1024 * 1024,
		...options
	});
const output = result => {
	if (result.status !== 0)
		throw new Error(stage + ': command failed (output suppressed)');
	return result.stdout.trim();
};
const context = ci ? 'default' : 'colima';
const docker = (argv, options) =>
	execute('docker', ['--context', context, ...argv], options);
assert.equal(output(execute('docker', ['context', 'show'])), context);
assert.equal(
	output(
		docker([
			'context',
			'inspect',
			context,
			'--format',
			'{{.Endpoints.docker.Host}}'
		])
	),
	ci
		? 'unix:///var/run/docker.sock'
		: `unix://${homedir()}/.colima/default/docker.sock`
);
if (!ci)
	assert.equal(
		output(docker(['info', '--format', '{{.Name}}'])),
		'colima'
	);

stage = 'pull-pinned-postgres18';
output(docker(['pull', image]));
const runId = randomBytes(6).toString('hex');
const quote = value => '"' + value + '"';
const literal = value => "'" + value + "'";

for (const service of args[1] === 'all' ? services : [args[1]]) {
	const schema = service.replaceAll('-', '_');
	const database = 'winwidget_' + schema;
	const roles = Object.fromEntries(
		['admin', 'migration', 'runtime', 'backup'].map(role => [
			role,
			database + '_' + role
		])
	);
	const passwords = Object.fromEntries(
		['migration', 'runtime', 'backup'].map(role => [
			role,
			randomBytes(32).toString('hex')
		])
	);
	const adminPassword = randomBytes(32).toString('hex');
	const name = 'wincrm-db-proof-' + runId + '-' + service;
	let container;
	try {
		stage = service + ': start-owned-cluster';
		console.log(JSON.stringify({ stage, runId }));
		container = output(
			docker(
				[
					'run',
					'-d',
					'--name',
					name,
					'--label',
					'winwidget.crm.database-proof=' + runId,
					'--memory',
					'512m',
					'--cpus',
					'1',
					'--publish',
					'127.0.0.1::5432',
					'--env',
					'POSTGRES_USER',
					'--env',
					'POSTGRES_PASSWORD',
					'--env',
					'POSTGRES_DB',
					'--env',
					'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
					'--env',
					'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=trust',
					image,
					'-c',
					'max_connections=' +
						{
							'crm-access': 32,
							'crm-intake': 48,
							'crm-customers': 16,
							'crm-sales': 16
						}[service]
				],
				{
					env: {
						...process.env,
						POSTGRES_USER: roles.admin,
						POSTGRES_PASSWORD: adminPassword,
						POSTGRES_DB: database
					}
				}
			)
		);
		assert.match(container, /^[a-f0-9]{64}$/);
		const owned = () => {
			const value = JSON.parse(output(docker(['inspect', container])))[0];
			assert.equal(value.Id, container);
			assert.equal(value.Name, '/' + name);
			assert.equal(
				value.Config.Labels['winwidget.crm.database-proof'],
				runId
			);
			assert.equal(value.Config.Image, image);
			return value;
		};
		const sql = (text, role = 'admin', expectedState, password) => {
			const result = docker(
				[
					'exec',
					'-i',
					'--env',
					'PGPASSWORD',
					container,
					'psql',
					'-X',
					'-q',
					'-tA',
					'-v',
					'ON_ERROR_STOP=1',
					'-v',
					'VERBOSITY=sqlstate',
					'-h',
					'127.0.0.1',
					'-U',
					roles[role],
					'-d',
					database
				],
				{
					input: text,
					env: {
						...process.env,
						PGPASSWORD:
							password ??
							(role === 'admin' ? adminPassword : passwords[role])
					}
				}
			);
			if (expectedState) {
				assert.ok(
					result.status !== 0 && result.stderr.includes(expectedState),
					stage +
						': expected SQLSTATE ' +
						expectedState +
						'; actual ' +
						(result.stderr.match(
							/(?:ERROR|FATAL):\s+([A-Z0-9]{5})/
						)?.[1] ?? 'none')
				);
				return '';
			}
			if (result.status !== 0) {
				const state =
					result.stderr.match(/(?:ERROR|FATAL):\s+([A-Z0-9]{5})/)?.[1] ??
					'unknown';
				throw new Error(
					stage + ': SQLSTATE ' + state + ' (details suppressed)'
				);
			}
			return result.stdout.trim();
		};
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt++) {
			const result = docker([
				'exec',
				container,
				'pg_isready',
				// initdb starts a temporary socket-only server before the real
				// TCP listener. Bootstrap uses TCP and must wait for that listener.
				'-h',
				'127.0.0.1',
				'-U',
				roles.admin,
				'-d',
				database
			]);
			if (result.status === 0) {
				ready = true;
				break;
			}
			await delay(500);
		}
		assert.ok(ready, 'owned PostgreSQL did not become ready');
		const binding = owned().NetworkSettings.Ports['5432/tcp'];
		assert.equal(binding.length, 1);
		assert.equal(binding[0].HostIp, '127.0.0.1');
		assert.match(binding[0].HostPort, /^[0-9]{1,5}$/);
		const { contract, migrations } = readDatabaseAccess(
			join(root, 'apps', service, 'prisma'),
			service
		);
		stage = service + ': bootstrap-and-authenticate';
		sql(databaseBootstrapSql(contract, passwords));
		for (const role of ['migration', 'runtime', 'backup'])
			assert.equal(sql('SELECT current_user;', role), roles[role]);
		stage = service + ': exact-owner-prisma-migrations';
		const key = schema.toUpperCase() + '_DATABASE_URL';
		const url = `postgresql://${roles.migration}:${passwords.migration}@127.0.0.1:${binding[0].HostPort}/${database}?schema=${schema}&connection_limit=1&pool_timeout=10`;
		const migrate = () =>
			output(
				execute(
					'pnpm',
					['--dir', 'apps/' + service, 'run', 'prisma:migrate:deploy'],
					{ env: { ...process.env, [key]: url } }
				)
			);
		migrate();
		stage = service + ': exact-inventory-and-grants';
		const grants = databaseRuntimeGrantsSql(contract, migrations);
		sql(grants);
		// Actual TCP-authenticated readers. The runtime cannot even read the ledger.
		for (const role of ['runtime', 'backup'])
			assert.equal(
				sql(`SELECT service_name FROM ${schema}.service_identity;`, role),
				service + '-service'
			);
		assert.equal(
			Number(
				sql(`SELECT count(*) FROM ${schema}._prisma_migrations;`, 'backup')
			),
			migrations.length
		);
		sql(`SELECT * FROM ${schema}._prisma_migrations;`, 'runtime', '42501');
		let checkedPrivileges = 0;
		for (const [table, rights] of Object.entries(contract.tables)) {
			const target = schema + '.' + quote(table);
			for (const role of ['runtime', 'backup']) {
				const allowed = role === 'runtime' ? rights : ['SELECT'];
				const privileges = [
					'SELECT',
					'INSERT',
					'UPDATE',
					'DELETE',
					'TRUNCATE',
					'REFERENCES',
					'TRIGGER',
					'MAINTAIN'
				];
				assert.equal(
					sql(
						'SELECT ' +
							privileges
								.map(
									right =>
										`has_table_privilege(${literal(roles[role])}, ${literal(target)}, ${literal(right)})`
								)
								.join(',') +
							';'
					),
					privileges
						.map(right => (allowed.includes(right) ? 't' : 'f'))
						.join('|'),
					service + ': ' + table + '/' + role
				);
				checkedPrivileges += privileges.length;
			}
			if (rights.length)
				sql('SELECT * FROM ' + target + ' LIMIT 0;', 'runtime');
			if (!rights.includes('DELETE'))
				sql('DELETE FROM ' + target + ' WHERE false;', 'runtime', '42501');
		}
		for (const [sequence, rights] of Object.entries(contract.sequences)) {
			for (const right of ['SELECT', 'USAGE', 'UPDATE'])
				assert.equal(
					sql(
						`SELECT has_sequence_privilege('${roles.runtime}', '${schema}.${sequence}', '${right}');`
					),
					rights.includes(right) ? 't' : 'f'
				);
		}
		for (const type of contract.types)
			assert.equal(
				sql(
					`SELECT has_type_privilege('${roles.runtime}', '${schema}."${type}"', 'USAGE');`
				),
				't'
			);
		for (const routine of contract.routines)
			assert.equal(
				sql(
					`SELECT has_function_privilege('${roles.runtime}', '${schema}.${routine}()', 'EXECUTE');`
				),
				'f'
			);
		for (const role of ['runtime', 'backup']) {
			sql(
				`CREATE TABLE ${schema}.unauthorized (id integer);`,
				role,
				'42501'
			);
			sql('CREATE TEMP TABLE unauthorized (id integer);', role, '42501');
			sql('CREATE SCHEMA unauthorized;', role, '42501');
			sql(`DROP TABLE ${schema}.service_identity;`, role, '42501');
			sql('SET ROLE ' + quote(roles.migration) + ';', role, '42501');
			assert.equal(
				sql(
					`SELECT has_database_privilege('${roles[role]}', 'postgres', 'CONNECT'), has_database_privilege('${roles[role]}', 'template1', 'CONNECT');`
				),
				'f|f'
			);
		}
		stage =
			service + ': repeated-bootstrap-preserves-identity-and-credentials';
		const identity = sql(
			`SELECT database_id FROM ${schema}.service_identity;`
		);
		const fingerprintSql = `SELECT md5(string_agg(rolname || rolpassword, ',' ORDER BY rolname)) FROM pg_authid WHERE rolname IN (${Object.values(roles).map(literal).join(',')});`;
		const fingerprint = sql(fingerprintSql);
		const alternate = Object.fromEntries(
			Object.keys(passwords).map(role => [
				role,
				randomBytes(32).toString('hex')
			])
		);
		sql(databaseBootstrapSql(contract, alternate));
		migrate();
		sql(grants);
		assert.equal(
			sql(`SELECT database_id FROM ${schema}.service_identity;`),
			identity
		);
		assert.ok(
			sql(fingerprintSql) === fingerprint,
			'existing passwords must not be rotated'
		);
		for (const role of ['migration', 'runtime', 'backup']) {
			assert.equal(sql('SELECT 1;', role), '1');
			// Authentication failures may precede psql's VERBOSITY setting.
			const wrong = docker(
				[
					'exec',
					'-i',
					'--env',
					'PGPASSWORD',
					container,
					'psql',
					'-X',
					'-h',
					'127.0.0.1',
					'-U',
					roles[role],
					'-d',
					database
				],
				{
					input: 'SELECT 1;',
					env: { ...process.env, PGPASSWORD: alternate[role] }
				}
			);
			assert.ok(
				wrong.status !== 0 &&
					/password authentication failed/.test(wrong.stderr),
				'wrong password must fail without rotation'
			);
		}
		stage = service + ': fail-closed-drift';
		const poisons = [
			'CREATE ROLE unexpected_role',
			`ALTER ROLE ${quote(roles.runtime)} SUPERUSER`,
			`GRANT ${quote(roles.backup)} TO ${quote(roles.runtime)}`,
			`CREATE TABLE ${schema}.unexpected (id integer)`,
			'CREATE TABLE public.unexpected (id integer)',
			'CREATE SCHEMA unexpected',
			`UPDATE ${schema}._prisma_migrations SET finished_at = NULL WHERE migration_name = '${migrations[0].name}'`,
			`UPDATE ${schema}._prisma_migrations SET checksum = repeat('0',64) WHERE migration_name = '${migrations[0].name}'`,
			`GRANT SELECT(id) ON ${schema}.service_identity TO ${quote(roles.runtime)}`
		];
		// Nested BEGIN emits only a warning; each expected failure rolls back its
		// synthetic drift when psql exits. These are this test's disposable DBs.
		for (const [index, poison] of poisons.entries()) {
			stage = service + ': fail-closed-drift-' + index;
			sql('BEGIN;\n' + poison + ';\n' + grants, 'admin', 'P0001');
		}
		sql(grants);
		// Exact ACL application also repairs accidental table-wide excess grants.
		sql(
			`GRANT ALL ON ${schema}.service_identity TO ${quote(roles.runtime)};`
		);
		sql(grants);
		assert.equal(
			sql(
				`SELECT has_table_privilege('${roles.runtime}', '${schema}.service_identity', 'TRUNCATE');`
			),
			'f'
		);
		console.log(
			JSON.stringify({
				service,
				runId,
				postgres: 18,
				migrations: migrations.length,
				checkedPrivileges,
				authenticatedRoles: 3,
				driftRejections: poisons.length,
				replayPreservesCredentials: true,
				status: 'passed',
				productionReady: false
			})
		);
	} finally {
		if (container) {
			assert.match(container, /^[a-f0-9]{64}$/);
			const actual = JSON.parse(output(docker(['inspect', container])))[0];
			assert.equal(
				actual.Config.Labels['winwidget.crm.database-proof'],
				runId
			);
			assert.equal(actual.Name, '/' + name);
			output(docker(['rm', '--force', '--volumes', container]));
		}
	}
}
