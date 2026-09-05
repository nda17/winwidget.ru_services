import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--help')) {
	console.log(
		'Usage: WIDGETS_LOCAL_WINCRM_PG_ALLOW_MUTATION=true node apps/widgets/test/integration/local-wincrm-postgres.mjs\nRequires the existing local Colima wincrm-mvp-postgres18 container (winwidget.test=crm-mvp), PostgreSQL 18 at 127.0.0.1:55440 and crm_bootstrap_ci. Creates only a fresh Widgets test database and two restricted roles. Never reads existing fixtures/env or starts/stops Docker. Database and roles remain for coordinated owner cleanup; private staging is removed.'
	);
	process.exit(0);
}
assert.equal(
	process.argv.length,
	2,
	'Unsupported Widgets PostgreSQL runner arguments'
);
assert.equal(
	process.env.WIDGETS_LOCAL_WINCRM_PG_ALLOW_MUTATION,
	'true',
	'Explicit Widgets local PostgreSQL mutation opt-in is required'
);

const serviceRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../..'
);
const container = 'wincrm-mvp-postgres18';
const bootstrapRole = 'crm_bootstrap_ci';
const runId = randomBytes(6).toString('hex');
const database = `winwidget_widgets_test_${runId}_test`;
const migrationRole = `widgets_wincrm_m_${runId}`;
const runtimeRole = `widgets_wincrm_r_${runId}`;
const migrationPassword = randomBytes(32).toString('hex');
const runtimePassword = randomBytes(32).toString('hex');
const staging = await mkdtemp(join(tmpdir(), 'wincrm-widgets-pg-'));
await chmod(staging, 0o700);
const environment = {
	PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
	HOME: homedir(),
	LANG: 'en_US.UTF-8',
	TMPDIR: staging,
	NODE_ENV: 'test',
	MODE: 'development',
	PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true',
	PRISMA_HIDE_UPDATE_MESSAGE: 'true'
};
let mayOwnResources = false;
let phase = 'preflight';
const log = message => console.log(`[widgets-wincrm-pg] ${message}`);

function execute(
	command,
	args,
	{
		input = '',
		cwd = staging,
		env = {},
		label = 'local command',
		allowFailure = false
	} = {}
) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...environment, ...env },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let output = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, 120_000);
		const capture = chunk => {
			output = (output + chunk.toString()).slice(-64000);
		};
		child.stdout.on('data', capture);
		child.stderr.on('data', capture);
		child.once('error', () => {
			clearTimeout(timer);
			reject(new Error(`${label}: spawn failed`));
		});
		child.once('close', code => {
			clearTimeout(timer);
			if (allowFailure) return done({ code, output, timedOut });
			if (code === 0 && !timedOut) return done(output.trim());
			const codes = [
				...new Set(
					output.match(
						/\b(?:P\d{4}|TS\d{4}|ERR_[A-Z0-9_]+|[245][0-9A-Z]{4})\b/g
					) || []
				)
			].slice(0, 8);
			const workflowPhase = output.match(
				/Widgets WinCRM PostgreSQL proof FAILED at ([a-z -]{1,80}) \(/
			)?.[1];
			const allowedPhases = [
				'runtime role and table ACL',
				'configure replay and ownership',
				'server-paged candidates',
				'atomic lead capture',
				'fresh transfer context',
				'disable and generation fences',
				'bounded widget lock contention',
				'runtime immutable evidence',
				'original period expiry'
			];
			const detail = allowedPhases.includes(workflowPhase)
				? ` [${workflowPhase}]`
				: '';
			reject(
				new Error(
					`${label}: ${timedOut ? 'timeout' : 'failed'}${codes.length ? ` (${codes.join(', ')})` : ''}${detail}`
				)
			);
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});
}
const docker = (args, options) =>
	execute('docker', ['--context', 'colima', ...args], options);
function sql(target, statement, role = bootstrapRole, options = {}) {
	assert.ok(
		target === 'postgres' || target === database,
		'SQL target must be bootstrap catalog or this exact new test database'
	);
	assert.ok(
		[bootstrapRole, migrationRole, runtimeRole].includes(role),
		'Unexpected PostgreSQL role'
	);
	return docker(
		[
			'exec',
			'-i',
			container,
			'psql',
			'-X',
			'-A',
			'-t',
			'-U',
			role,
			'-d',
			target,
			'-v',
			'ON_ERROR_STOP=1',
			'-v',
			'VERBOSITY=sqlstate'
		],
		{ input: statement, label: 'isolated PostgreSQL command', ...options }
	);
}
function dbUrl(role, password) {
	assert.ok([migrationRole, runtimeRole].includes(role));
	const url = new URL(
		`postgresql://127.0.0.1:55440/${database}?schema=widgets&sslmode=disable&connection_limit=8`
	);
	url.username = role;
	url.password = password;
	return url.href;
}
async function denied(statement, role = runtimeRole, code = '42501') {
	const result = await sql(database, statement, role, {
		allowFailure: true
	});
	assert.ok(
		result.code !== 0 && !result.timedOut && result.output.includes(code),
		'Expected exact database privilege/constraint rejection'
	);
}

try {
	assert.match(database, /^winwidget_widgets_test_[0-9a-f]{12}_test$/);
	for (const role of [migrationRole, runtimeRole])
		assert.match(role, /^widgets_wincrm_[mr]_[0-9a-f]{12}$/);
	assert.equal(
		await execute('docker', ['context', 'show'], {
			label: 'active Docker context'
		}),
		'colima',
		'Active Docker context must be colima'
	);
	const endpoint = JSON.parse(
		await docker([
			'context',
			'inspect',
			'colima',
			'--format',
			'{{json .Endpoints.docker.Host}}'
		])
	);
	assert.match(endpoint, /^unix:\/\/.*\/\.colima\/[^\s]+\/docker\.sock$/);
	assert.ok(
		(await stat(endpoint.slice('unix://'.length))).isSocket(),
		'Local Colima endpoint must be a Unix socket'
	);
	assert.equal(
		await docker(['info', '--format', '{{.Name}}']),
		'colima',
		'Docker daemon must be local Colima'
	);
	assert.equal(
		await docker([
			'inspect',
			container,
			'--format',
			'{{index .Config.Labels "winwidget.test"}}'
		]),
		'crm-mvp',
		'Expected explicit local test-container label'
	);
	assert.equal(
		await docker(['inspect', container, '--format', '{{.State.Running}}']),
		'true',
		'Local PostgreSQL test container must already be running'
	);
	const ports = JSON.parse(
		await docker([
			'inspect',
			container,
			'--format',
			'{{json .NetworkSettings.Ports}}'
		])
	);
	assert.equal(ports['5432/tcp']?.length, 1);
	assert.deepEqual(ports['5432/tcp'][0], {
		HostIp: '127.0.0.1',
		HostPort: '55440'
	});
	const preflight = await sql(
		'postgres',
		"SELECT current_user || '|' || current_setting('server_version_num') || '|' || rolsuper FROM pg_roles WHERE rolname=current_user;"
	);
	assert.match(preflight, /^crm_bootstrap_ci\|18[0-9]{4}\|true$/);
	log(
		'Verified local Colima, labelled PostgreSQL 18 container and exact loopback port.'
	);
	phase = 'isolated resource creation';
	assert.equal(
		await sql(
			'postgres',
			`SELECT count(*) FROM pg_database WHERE datname='${database}';`
		),
		'0',
		'Refusing to reuse a database'
	);
	assert.equal(
		await sql(
			'postgres',
			`SELECT count(*) FROM pg_roles WHERE rolname IN ('${migrationRole}','${runtimeRole}');`
		),
		'0',
		'Refusing to reuse roles'
	);
	mayOwnResources = true;
	await sql(
		'postgres',
		`CREATE ROLE ${migrationRole} LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE DATABASE ${database} OWNER ${bootstrapRole};`
	);
	await sql(
		database,
		`REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${database} TO ${migrationRole}, ${runtimeRole};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA widgets AUTHORIZATION ${migrationRole};
CREATE SCHEMA foreign_service_guard AUTHORIZATION ${bootstrapRole};
CREATE TABLE foreign_service_guard.sentinel (id INTEGER PRIMARY KEY);
INSERT INTO foreign_service_guard.sentinel VALUES (1);
REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA foreign_service_guard FROM PUBLIC;`
	);
	log(
		'Created one fresh Widgets database, two restricted roles and a foreign-schema sentinel.'
	);
	phase = 'Prisma migration and generation';
	const schemaDirectory = join(staging, 'prisma');
	await mkdir(schemaDirectory);
	await copyFile(
		join(serviceRoot, 'package.json'),
		join(staging, 'package.json')
	);
	await symlink(
		join(serviceRoot, 'node_modules'),
		join(staging, 'node_modules'),
		'dir'
	);
	await symlink(
		join(serviceRoot, 'prisma/migrations'),
		join(schemaDirectory, 'migrations'),
		'dir'
	);
	const sourceSchema = await readFile(
		join(serviceRoot, 'prisma/schema.prisma'),
		'utf8'
	);
	const stagedSchema = sourceSchema.replace(
		/^\s*output\s*=\s*"[^"\n]+"/m,
		`  output = ${JSON.stringify(join(serviceRoot, 'node_modules/@prisma/widgets-client'))}`
	);
	assert.notEqual(
		stagedSchema,
		sourceSchema,
		'Expected explicit Widgets Prisma output'
	);
	const schemaPath = join(schemaDirectory, 'schema.prisma');
	await writeFile(schemaPath, stagedSchema, { mode: 0o600 });
	const migrationEnv = {
		WIDGETS_DATABASE_URL: dbUrl(migrationRole, migrationPassword)
	};
	const prismaCli = join(
		serviceRoot,
		'node_modules/prisma/build/index.js'
	);
	await execute(
		process.execPath,
		[prismaCli, 'migrate', 'deploy', '--schema', schemaPath],
		{ env: migrationEnv, label: 'Widgets owned migrations' }
	);
	await execute(
		process.execPath,
		[prismaCli, 'generate', '--schema', schemaPath],
		{ env: migrationEnv, label: 'Widgets Prisma generate' }
	);
	log(
		'Service-owned migrations and Prisma generation completed without loading an env file.'
	);
	phase = 'runtime ACL proof';
	await sql(
		database,
		`GRANT USAGE ON SCHEMA widgets TO ${runtimeRole};
GRANT SELECT ON widgets.service_identity, widgets.widgets, widgets.quizzes, widgets.callbacks, widgets.countdown_timers, widgets.stop_offers, widgets.calculators, widgets.leads, widgets.quiz_leads, widgets.callback_leads, widgets.countdown_timer_leads, widgets.stop_offer_leads, widgets.calculator_leads TO ${runtimeRole};
GRANT INSERT ON widgets.widgets, widgets.leads TO ${runtimeRole};
GRANT UPDATE(id) ON widgets.widgets, widgets.quizzes, widgets.callbacks, widgets.countdown_timers, widgets.stop_offers, widgets.calculators TO ${runtimeRole};
GRANT SELECT, INSERT ON widgets.owner_projections, widgets.entitlement_projections, widgets.usage_ledger, widgets.outbox_events, widgets.wincrm_connector_commands, widgets.wincrm_transfer_intents TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE ON widgets.usage_counters, widgets.wincrm_connectors TO ${runtimeRole};
REVOKE ALL ON widgets._prisma_migrations FROM ${runtimeRole};`
	);
	for (const role of [migrationRole, runtimeRole]) {
		assert.equal(
			await sql(
				database,
				'SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolbypassrls AND NOT rolreplication FROM pg_roles WHERE rolname=current_user;',
				role
			),
			't'
		);
		assert.equal(
			await sql(
				database,
				"SELECT NOT has_database_privilege(current_user,current_database(),'CREATE') AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_schema_privilege(current_user,'foreign_service_guard','USAGE');",
				role
			),
			't'
		);
		await denied('SELECT * FROM foreign_service_guard.sentinel;', role);
		await denied(
			'INSERT INTO foreign_service_guard.sentinel VALUES (2);',
			role
		);
	}
	assert.equal(
		await sql(
			database,
			"SELECT NOT has_schema_privilege(current_user,'widgets','CREATE') AND NOT has_table_privilege(current_user,'widgets._prisma_migrations','SELECT') AND NOT has_function_privilege(current_user,'widgets.guard_wincrm_connector_update()','EXECUTE') AND NOT has_function_privilege(current_user,'widgets.reject_wincrm_evidence_mutation()','EXECUTE');",
			runtimeRole
		),
		't'
	);
	await denied('CREATE TABLE widgets.forbidden_runtime_ddl(id INTEGER);');
	assert.equal(
		await sql(
			database,
			'SELECT count(*) FROM foreign_service_guard.sentinel;'
		),
		'1'
	);
	log(
		'Runtime/migration role flags, no DB CREATE, no cross-schema reads/writes and exact runtime grants verified.'
	);
	phase = 'build and native connector PostgreSQL workflow';
	await execute(
		process.execPath,
		[
			join(serviceRoot, 'node_modules/typescript/bin/tsc'),
			'-p',
			join(serviceRoot, 'tsconfig.build.json')
		],
		{ label: 'Widgets TypeScript build' }
	);
	const output = await execute(
		process.execPath,
		[join(serviceRoot, 'test/integration/widgets-wincrm.integration.mjs')],
		{
			env: {
				WIDGETS_TEST_DATABASE_URL: dbUrl(runtimeRole, runtimePassword),
				WIDGETS_INTEGRATION_ALLOW_MUTATION: 'true'
			},
			label: 'Widgets WinCRM PostgreSQL workflow'
		}
	);
	assert.ok(
		output.includes('Widgets WinCRM PostgreSQL proof GREEN'),
		'Expected explicit non-skipped workflow result'
	);
	phase = 'owner-level immutable evidence proof';
	await denied(
		'UPDATE widgets.wincrm_connector_commands SET caller=caller;',
		migrationRole,
		'P0001'
	);
	await denied(
		'DELETE FROM widgets.wincrm_transfer_intents;',
		migrationRole,
		'P0001'
	);
	await denied(
		'TRUNCATE TABLE widgets.wincrm_connector_commands;',
		migrationRole,
		'P0001'
	);
	await denied(
		'DELETE FROM widgets.wincrm_connectors;',
		migrationRole,
		'P0001'
	);
	assert.equal(
		await sql(
			database,
			'SELECT count(*) FROM foreign_service_guard.sentinel;'
		),
		'1'
	);
	log(
		'GREEN: actual PostgreSQL 18 workflow, runtime ACL, owner-trigger immutability and foreign sentinel preservation.'
	);
} catch (error) {
	const codes = [
		...new Set(
			String(error?.message || '').match(
				/\b(?:P\d{4}|TS\d{4}|ERR_[A-Z0-9_]+|[245][0-9A-Z]{4})\b/g
			) || []
		)
	].slice(0, 8);
	const detail = String(error?.message || '').match(
		/\[([a-z -]{1,80})\]$/
	)?.[1];
	log(
		`FAILED at ${phase}${codes.length ? ` (${codes.join(', ')})` : ''}${detail ? ` [${detail}]` : ''}; private diagnostics suppressed.`
	);
	process.exitCode = 1;
} finally {
	if (mayOwnResources)
		log(
			`Retained own resources for coordinated cleanup: database=${database}; roles=${migrationRole},${runtimeRole}.`
		);
	const details = await lstat(staging);
	assert.ok(
		details.isDirectory() &&
			!details.isSymbolicLink() &&
			details.uid === process.getuid() &&
			/^wincrm-widgets-pg-[A-Za-z0-9]+$/.test(basename(staging)),
		'Refusing unsafe staging cleanup'
	);
	await rm(staging, { recursive: true });
}
