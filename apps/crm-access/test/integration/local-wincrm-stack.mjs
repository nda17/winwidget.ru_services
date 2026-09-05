import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	randomUUID
} from 'node:crypto';
import {
	access,
	chmod,
	copyFile,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	stat,
	symlink,
	writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local integration harness only. The normal login, JWT, Identity introspection,
// CRM access checks and service-owned databases run without runtime overrides.
const servicesRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../..'
);
const workspaceRoot = dirname(servicesRoot);
const frontendFolders = ['winwidget.ru_client', 'winwidget.ru_client_crm'];
const frontendConfigs = [
	'package.json',
	'next.config.mjs',
	'tsconfig.json',
	'tailwind.config.ts',
	'postcss.config.js',
	'next-env.d.ts'
];

async function sourceSnapshot(root) {
	const hash = createHash('sha256');
	const walk = async relative => {
		const path = join(root, relative);
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (relative === 'public' && error.code === 'ENOENT') return;
			throw error;
		}
		assert.ok(
			!info.isSymbolicLink(),
			'Frontend source snapshots must not traverse symlinks'
		);
		if (info.isDirectory()) {
			for (const name of (await readdir(path)).sort()) {
				if (
					name.startsWith('.env') ||
					['.git', '.next', 'node_modules'].includes(name)
				)
					continue;
				await walk(join(relative, name));
			}
		} else if (info.isFile()) {
			const content = await readFile(path);
			hash.update(`${relative}\0${content.length}\0`).update(content);
		}
	};
	for (const path of ['src', 'public', ...frontendConfigs])
		await walk(path);
	return hash.digest('hex');
}

async function copyFrontendSource(root, mirror) {
	for (const entry of ['src', 'public']) {
		try {
			await access(join(root, entry));
		} catch (error) {
			if (entry === 'public' && error.code === 'ENOENT') continue;
			throw error;
		}
		await cp(join(root, entry), join(mirror, entry), {
			recursive: true,
			filter: path =>
				!basename(path).startsWith('.env') &&
				!['.git', '.next', 'node_modules'].includes(basename(path))
		});
	}
	for (const file of frontendConfigs)
		await copyFile(join(root, file), join(mirror, file));
	const hash = await sourceSnapshot(root);
	assert.equal(
		await sourceSnapshot(mirror),
		hash,
		'Frontend changed during copy or contains stale files; launch a fresh harness'
	);
	return hash;
}

if (process.argv[2] === '--refresh-frontends') {
	assert.equal(
		process.argv.length,
		4,
		'Provide exactly one private fixture path'
	);
	const path = resolve(process.argv[3]);
	assert.equal(basename(path), 'browser-fixture.json');
	const directory = await realpath(dirname(path));
	assert.equal(dirname(directory), await realpath(tmpdir()));
	assert.match(basename(directory), /^wincrm-local-stack-[A-Za-z0-9]+$/);
	for (const entry of [directory, path]) {
		const info = await lstat(entry);
		assert.ok(
			!info.isSymbolicLink() &&
				(info.mode & 0o077) === 0 &&
				info.uid === process.getuid()
		);
	}
	const fixture = JSON.parse(await readFile(path, 'utf8'));
	assert.match(fixture.runId, /^[a-f0-9]{10}$/);
	for (const folder of frontendFolders) {
		const mirror = join(directory, folder);
		assert.equal(await realpath(mirror), mirror);
		const sourceHash = await copyFrontendSource(
			join(workspaceRoot, folder),
			mirror
		);
		fixture.frontendSnapshots[folder] = { mirror, sourceHash };
		console.log(
			`[wincrm-local] Refreshed ${folder} source SHA-256 ${sourceHash}`
		);
	}
	await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, {
		mode: 0o600
	});
	console.log(
		'[wincrm-local] Source updates use HMR; changed Next/configuration files require restarting the harness.'
	);
	process.exit(0);
}

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
	console.log(`Usage: WINCRM_LOCAL_STACK_ALLOW_MUTATION=true node apps/crm-access/test/integration/local-wincrm-stack.mjs [--backend-only] [--activate-owner] [--with-widgets] [--verify-native-widget-http] [--verify-domain] [--verify-acceptance-http] [--smoke-and-stop]

Requires local Colima container wincrm-mvp-postgres18, PostgreSQL 18 on
127.0.0.1:55440 with local test-only trust and bootstrap role crm_bootstrap_ci.
Creates fresh isolated test databases and restricted roles, migrates/builds
current services, and starts real APIs plus temporary frontend mirrors.
Default owner starts without WinCRM: use the real five-day Trial button.
--activate-owner additionally activates Trial and installs universal-sales@1 via API.
--with-widgets requires --activate-owner, adds a real Widgets API on loopback 4700,
and seeds one synthetic published Quiz with a matching test-only EASY period.
It verifies public candidates/create and one claimed control command via real HTTP.
No payment, lead transfer, publisher or RabbitMQ transport is exercised by this profile.
--verify-native-widget-http requires --with-widgets and four scoped local broker principals.
It additionally proves public Quiz submit -> real Widgets Outbox publisher -> RabbitMQ
-> real Intake worker/HTTP dependencies -> Inbox, without external provider delivery.
--verify-domain runs Customers, Intake and Sales PostgreSQL 18 integration scenarios.
It includes the service-owned native Widget transfer PostgreSQL gate.
--verify-acceptance-http uses a separate normal test account and real HTTP downstream operations.
It drives a claimed Intake event without a broker and does not prove RabbitMQ transport.
Use --refresh-frontends /exact/private/browser-fixture.json to refresh source snapshots.
Generated account credentials are saved only to a private 0600 fixture file.
SIGINT/SIGTERM stops only this harness's child processes. Database/container
cleanup is intentionally left to the shared local verification cleanup.`);
	process.exit(0);
}
for (const arg of args) {
	assert.ok(
		[
			'--backend-only',
			'--activate-owner',
			'--with-widgets',
			'--verify-native-widget-http',
			'--verify-domain',
			'--verify-acceptance-http',
			'--smoke-and-stop'
		].includes(arg),
		'Unsupported local-stack argument'
	);
}
const withWidgets = args.has('--with-widgets');
const withNativeWidgetHttp = args.has('--verify-native-widget-http');
assert.ok(
	!withNativeWidgetHttp || withWidgets,
	'--verify-native-widget-http requires --with-widgets'
);
assert.ok(
	!withWidgets || args.has('--activate-owner'),
	'--with-widgets requires explicit --activate-owner; the default owner Trial is never activated implicitly'
);
assert.equal(
	process.env.WINCRM_LOCAL_STACK_ALLOW_MUTATION,
	'true',
	'Explicit local-stack mutation opt-in is required'
);

const runId = randomBytes(5).toString('hex');
const stateDirectory = await mkdtemp(
	join(tmpdir(), 'wincrm-local-stack-')
);
await chmod(stateDirectory, 0o700);
const fixturePath = join(stateDirectory, 'browser-fixture.json');
const startedAt = new Date().toISOString();
const container = 'wincrm-mvp-postgres18';
const bootstrapRole = 'crm_bootstrap_ci';
const secrets = new Set();
const children = new Map();
const frontendSnapshots = {};
let stopping = false;
let ready = false;
const generated = () => {
	const value = randomBytes(32).toString('base64url');
	secrets.add(value);
	return value;
};
const safeEnvironment = {
	PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
	HOME: homedir(),
	TMPDIR: stateDirectory,
	LANG: 'en_US.UTF-8',
	NODE_ENV: 'development',
	MODE: 'development',
	APP_REVISION: `local-browser-${runId}`,
	NEXT_TELEMETRY_DISABLED: '1'
};
const cors = 'http://localhost:3000,http://localhost:3001';
const jwtIssuer = 'http://localhost:4100';
const publicApi = 'http://localhost:4100/api/v1';
const jwksUrl = 'http://127.0.0.1:4900/api/v1/auth/.well-known/jwks.json';
const serviceDefinitions = [
	{ app: 'identity', schema: 'identity', port: 4900 },
	{ app: 'billing', schema: 'billing', port: 4800 },
	...(withWidgets
		? [{ app: 'widgets', schema: 'widgets', port: 4700 }]
		: []),
	{ app: 'crm-access', schema: 'crm_access', port: 5300 },
	{ app: 'crm-intake', schema: 'crm_intake', port: 5310 },
	{ app: 'crm-customers', schema: 'crm_customers', port: 5320 },
	{ app: 'crm-sales', schema: 'crm_sales', port: 5330 }
].map(service => ({
	...service,
	root: join(servicesRoot, 'apps', service.app),
	database: `winwidget_${service.schema}_test_browser_${runId}_test`,
	migrationRole: `wcrm_${service.schema}_m_${runId}`,
	runtimeRole: `wcrm_${service.schema}_r_${runId}`,
	databaseVariable: `${service.app.replaceAll('-', '_').toUpperCase()}_DATABASE_URL`
}));
const byApp = Object.fromEntries(
	serviceDefinitions.map(item => [item.app, item])
);

function scrub(value) {
	let result = String(value);
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		result = result.split(secret).join('[redacted]');
	}
	return result;
}

function log(value) {
	console.log(`[wincrm-local] ${scrub(value)}`);
}

function safeFailure(label, output) {
	const codes = [
		...new Set(
			String(output).match(
				/\b(?:P\d{4}|TS\d{4}|ERR_[A-Z0-9_]+|[245][0-9A-Z]{4})\b/g
			) || []
		)
	];
	const compiler = String(output)
		.split('\n')
		.filter(line => /error TS\d+:/.test(line))
		.slice(0, 6)
		.map(scrub);
	return `${label} failed${codes.length ? ` (${codes.join(', ')})` : ''}${compiler.length ? `: ${compiler.join('\n')}` : ''}`;
}

function execute(command, commandArgs, options = {}) {
	return new Promise((resolveCommand, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: options.cwd || stateDirectory,
			env: { ...safeEnvironment, ...options.env },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		const timeout = setTimeout(
			() => child.kill('SIGKILL'),
			options.timeoutMs || 180000
		);
		let output = '';
		const collect = chunk => {
			output = (output + chunk.toString()).slice(-24_000);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.once('error', error => {
			clearTimeout(timeout);
			reject(
				new Error(
					safeFailure(
						options.label || command,
						error.code || 'SPAWN_FAILED'
					)
				)
			);
		});
		child.once('exit', code => {
			clearTimeout(timeout);
			if (code === 0) resolveCommand(output.trim());
			else
				reject(new Error(safeFailure(options.label || command, output)));
		});
		child.stdin.end(options.input || '');
	});
}

function docker(commandArgs, options) {
	return execute(
		'docker',
		['--context', 'colima', ...commandArgs],
		options
	);
}

function sql(database, query, role = bootstrapRole) {
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
			database,
			'-v',
			'ON_ERROR_STOP=1'
		],
		{ input: query, label: 'Local PostgreSQL command' }
	);
}

function databaseUrl(service, role) {
	return `postgresql://${role}@127.0.0.1:55440/${service.database}?schema=${service.schema}&sslmode=disable`;
}

async function assertFreePort(port) {
	await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', () =>
			reject(new Error(`Local port ${port} is not available`))
		);
		server.listen(port, '127.0.0.1', () => server.close(resolvePort));
	});
}

async function verifyLocalPostgres() {
	assert.equal(
		await execute('docker', ['context', 'show']),
		'colima',
		'Active Docker context must be local Colima'
	);
	const endpoint = await docker([
		'context',
		'inspect',
		'colima',
		'--format',
		'{{json .Endpoints.docker.Host}}'
	]);
	const socket = JSON.parse(endpoint);
	assert.match(socket, /^unix:\/\/.*\/\.colima\/[^\s]+\/docker\.sock$/);
	assert.ok(
		(await stat(socket.slice('unix://'.length))).isSocket(),
		'Colima endpoint must be a local Unix socket'
	);
	const engine = await docker(['info', '--format', '{{.Name}}']);
	assert.equal(engine, 'colima');
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
		'true'
	);
	const detail = JSON.parse(
		await docker([
			'inspect',
			container,
			'--format',
			'{{json .NetworkSettings.Ports}}'
		])
	);
	assert.ok(
		detail['5432/tcp'].some(
			item => item.HostIp === '127.0.0.1' && item.HostPort === '55440'
		)
	);
	const version = Number(
		await sql('postgres', "SELECT current_setting('server_version_num');")
	);
	assert.ok(
		version >= 180000 && version < 190000,
		'PostgreSQL 18 is required'
	);
	log(`Verified local PostgreSQL ${version}`);
}

async function prepareDatabase(service) {
	assert.match(
		service.database,
		/^winwidget_[a-z_]+_test_browser_[a-f0-9]{10}_test$/
	);
	const existing = await sql(
		'postgres',
		`SELECT count(*) FROM pg_database WHERE datname = '${service.database}';`
	);
	assert.equal(existing, '0', 'Refusing to reuse an existing database');
	await sql(
		'postgres',
		`
CREATE ROLE ${service.migrationRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE ${service.runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE DATABASE ${service.database} OWNER ${bootstrapRole};
`
	);
	await sql(
		service.database,
		`
REVOKE ALL ON DATABASE ${service.database} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${service.database} TO ${service.migrationRole}, ${service.runtimeRole};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA ${service.schema} AUTHORIZATION ${service.migrationRole};
CREATE SCHEMA foreign_service_guard AUTHORIZATION ${bootstrapRole};
CREATE TABLE foreign_service_guard.sentinel (id integer PRIMARY KEY);
REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA foreign_service_guard FROM PUBLIC;
`
	);
	// Stage only the service-owned schema and migrations, never a local .env.
	const prismaDirectory = join(stateDirectory, service.app, 'prisma');
	await mkdir(prismaDirectory, { recursive: true });
	await copyFile(
		join(service.root, 'package.json'),
		join(stateDirectory, service.app, 'package.json')
	);
	await symlink(
		join(service.root, 'node_modules'),
		join(stateDirectory, service.app, 'node_modules'),
		'dir'
	);
	const source = await readFile(
		join(service.root, 'prisma/schema.prisma'),
		'utf8'
	);
	const clientOutput = join(
		service.root,
		'node_modules/@prisma',
		`${service.app}-client`
	);
	const stagedSchema = source.replace(
		/^\s*output\s*=\s*"[^"\n]+"/m,
		`  output = ${JSON.stringify(clientOutput)}`
	);
	assert.notEqual(
		stagedSchema,
		source,
		'Expected explicit service-owned Prisma output'
	);
	const schemaPath = join(prismaDirectory, 'schema.prisma');
	await writeFile(schemaPath, stagedSchema, { mode: 0o600 });
	await symlink(
		join(service.root, 'prisma/migrations'),
		join(prismaDirectory, 'migrations')
	);
	const env = {
		[service.databaseVariable]: databaseUrl(
			service,
			service.migrationRole
		),
		PRISMA_GENERATE_SKIP_AUTOINSTALL: 'true'
	};
	const prismaCli = join(
		service.root,
		'node_modules/prisma/build/index.js'
	);
	for (const command of ['generate', 'migrate']) {
		await execute(
			process.execPath,
			[
				prismaCli,
				command,
				...(command === 'migrate' ? ['deploy'] : []),
				'--schema',
				schemaPath
			],
			{
				env,
				cwd: join(stateDirectory, service.app),
				label: `${service.app} Prisma ${command}`
			}
		);
	}
	const tsc = join(service.root, 'node_modules/typescript/bin/tsc');
	await execute(
		process.execPath,
		[tsc, '-p', join(service.root, 'tsconfig.build.json')],
		{
			env,
			label: `${service.app} build`
		}
	);
	await grantRuntime(service);
	log(`${service.app} isolated database migrated and build ready`);
}

async function grantRuntime(service) {
	const grants = {
		identity: {
			'SELECT, INSERT, UPDATE': ['workspace_invitations'],
			'SELECT, INSERT, UPDATE, DELETE': [
				'users',
				'user_sessions',
				'workspaces',
				'workspace_members',
				'auth_identities',
				'telegram_notification_channels',
				'verification_challenges',
				'auth_settings',
				'oauth_authorizations',
				'aggregate_versions',
				'source_sequences',
				'outbox_events',
				'avatar_media_objects',
				'consumer_receipts',
				'consumer_failures',
				'internal_command_receipts',
				'telegram_update_receipts',
				'heartbeats'
			]
		},
		billing: {
			'SELECT, INSERT': ['crm_commercial_policies', 'command_receipts'],
			// Normal Identity login ensures the separate Widgets Trial in Billing;
			// it must never implicitly activate WinCRM.
			'SELECT, INSERT, UPDATE': ['source_sequences', 'subscriptions'],
			'SELECT, INSERT, UPDATE, DELETE': [
				'crm_entitlements',
				'outbox_events'
			],
			SELECT: ['settings', 'tariff_prices']
		},
		widgets: {
			SELECT: [
				'widgets',
				'quizzes',
				'callbacks',
				'countdown_timers',
				'stop_offers',
				'calculators',
				'leads',
				'quiz_leads',
				'callback_leads',
				'countdown_timer_leads',
				'stop_offer_leads',
				'calculator_leads'
			],
			INSERT: ['quizzes', ...(withNativeWidgetHttp ? ['quiz_leads'] : [])],
			...(withNativeWidgetHttp ? { UPDATE: ['outbox_events'] } : {}),
			'SELECT, INSERT': [
				'owner_projections',
				'entitlement_projections',
				'usage_ledger',
				'outbox_events',
				'wincrm_connector_commands',
				'wincrm_transfer_intents'
			],
			'SELECT, INSERT, UPDATE': [
				'usage_counters',
				'wincrm_connectors',
				'heartbeats',
				...(withNativeWidgetHttp
					? ['aggregate_versions', 'source_sequences']
					: [])
			]
		},
		'crm-access': {
			'SELECT, INSERT, UPDATE': [
				'crm_workspace_access',
				'crm_workspace_members',
				'crm_teams',
				'crm_invitation_intents',
				'crm_admissions'
			],
			'SELECT, INSERT, DELETE': ['crm_member_teams'],
			'SELECT, INSERT': ['crm_team_command_receipts', 'crm_team_audit'],
			'SELECT, INSERT, UPDATE, DELETE': [
				'crm_team_outbox',
				'crm_team_deliveries'
			]
		},
		'crm-intake': {
			'SELECT, INSERT, UPDATE': [
				'inbox_entries',
				'intake_sources',
				'acceptances',
				'acceptance_outbox',
				'acceptance_receipts',
				'managed_widget_sources',
				'widget_control_jobs',
				'widget_control_receipts',
				'widget_control_outbox',
				'widget_transfer_receipts',
				'widget_transfer_outbox'
			],
			'SELECT, INSERT': [
				'intake_commands',
				'intake_activities',
				'inbound_receipts',
				'csv_imports',
				'csv_import_rows',
				'export_audit',
				'widget_entry_snapshots'
			],
			'SELECT, INSERT, UPDATE, DELETE': ['ingestion_rate_buckets']
		},
		'crm-customers': {
			'SELECT, INSERT, UPDATE': ['companies', 'contacts'],
			'SELECT, INSERT': [
				'customer_commands',
				'customer_activities',
				'intake_operation_slots',
				'intake_operation_commands',
				'export_audit'
			]
		},
		'crm-sales': {
			'SELECT, INSERT, UPDATE, DELETE': ['pipelines', 'pipeline_stages'],
			'SELECT, INSERT, UPDATE': ['deals', 'tasks'],
			'SELECT, INSERT': [
				'pipeline_template_installations',
				'pipeline_template_installation_commands',
				'deal_timeline',
				'command_receipts',
				'intake_operation_slots',
				'intake_operation_commands',
				'export_audit'
			]
		}
	};
	const statements = [
		`GRANT USAGE ON SCHEMA ${service.schema} TO ${service.runtimeRole};`,
		`GRANT SELECT ON ${service.schema}.service_identity TO ${service.runtimeRole};`
	];
	for (const [privileges, tables] of Object.entries(grants[service.app])) {
		statements.push(
			`GRANT ${privileges} ON ${tables.map(table => `${service.schema}.${table}`).join(', ')} TO ${service.runtimeRole};`
		);
	}
	statements.push(
		`REVOKE ALL ON ${service.schema}._prisma_migrations FROM ${service.runtimeRole};`
	);
	if (service.app === 'crm-access')
		statements.push(
			`GRANT USAGE, SELECT ON SEQUENCE crm_access.crm_admissions_position_seq TO ${service.runtimeRole};`
		);
	if (service.app === 'widgets')
		statements.push(
			`GRANT UPDATE(id) ON widgets.widgets, widgets.quizzes, widgets.callbacks, widgets.countdown_timers, widgets.stop_offers, widgets.calculators TO ${service.runtimeRole};`
		);
	await sql(service.database, statements.join('\n'));
	const isolation = await sql(
		service.database,
		`SELECT
  NOT has_database_privilege(current_user, current_database(), 'CREATE')
  AND NOT has_schema_privilege(current_user, '${service.schema}', 'CREATE')
  AND NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE')
  AND NOT has_table_privilege(current_user, '${service.schema}._prisma_migrations', 'SELECT');`,
		service.runtimeRole
	);
	assert.equal(isolation, 't', `${service.app} runtime isolation failed`);
	if (service.app === 'widgets') {
		for (const [table, canUpdate] of [
			['wincrm_connectors', true],
			['wincrm_connector_commands', false],
			['wincrm_transfer_intents', false]
		]) {
			const exact = await sql(
				service.database,
				`SELECT has_table_privilege(current_user, 'widgets.${table}', 'SELECT') AND has_table_privilege(current_user, 'widgets.${table}', 'INSERT') AND has_table_privilege(current_user, 'widgets.${table}', 'UPDATE') = ${canUpdate} AND NOT has_table_privilege(current_user, 'widgets.${table}', 'DELETE') AND NOT has_table_privilege(current_user, 'widgets.${table}', 'TRUNCATE');`,
				service.runtimeRole
			);
			assert.equal(
				exact,
				't',
				'Native Widgets evidence ACL must remain least privilege'
			);
		}
		assert.equal(
			await sql(
				service.database,
				"SELECT NOT has_function_privilege(current_user, 'widgets.guard_wincrm_connector_update()', 'EXECUTE') AND NOT has_function_privilege(current_user, 'widgets.reject_wincrm_evidence_mutation()', 'EXECUTE');",
				service.runtimeRole
			),
			't'
		);
	}
}

async function verifyDomain() {
	for (const [app, file, prefix] of [
		[
			'identity',
			'widget-source-context-postgres18.integration.mjs',
			'IDENTITY'
		],
		['crm-intake', 'intake-postgres18.integration.mjs', 'CRM_INTAKE'],
		[
			'crm-customers',
			'customers-postgres18.integration.mjs',
			'CRM_CUSTOMERS'
		],
		[
			'crm-sales',
			'sales-workflow-postgres18.integration.mjs',
			'CRM_SALES'
		],
		[
			'crm-customers',
			'intake-operations-postgres18.integration.mjs',
			'CRM_CUSTOMERS'
		],
		['crm-intake', 'acceptance-postgres18.integration.mjs', 'CRM_INTAKE'],
		['crm-intake', 'csv-postgres18.integration.mjs', 'CRM_INTAKE'],
		[
			'crm-intake',
			'widget-control-postgres18.integration.mjs',
			'CRM_INTAKE'
		],
		[
			'crm-intake',
			'widget-transfer-postgres18.integration.mjs',
			'CRM_INTAKE'
		],
		[
			'crm-customers',
			'export-postgres18.integration.mjs',
			'CRM_CUSTOMERS'
		],
		['crm-sales', 'export-postgres18.integration.mjs', 'CRM_SALES'],
		['crm-intake', 'export-postgres18.integration.mjs', 'CRM_INTAKE']
	]) {
		const service = byApp[app];
		const output = await execute(
			process.execPath,
			[join(service.root, 'test/integration', file)],
			{
				env: {
					...optionalDomainTestBrokerEnvironment(file),
					...(file === 'widget-transfer-postgres18.integration.mjs'
						? nativeTransferTestBrokerEnvironment()
						: {}),
					[`${prefix}_INTEGRATION_ALLOW_MUTATION`]: 'true',
					[`${prefix}_TEST_DATABASE_URL`]: databaseUrl(
						service,
						service.runtimeRole
					),
					[`${prefix}_TEST_MIGRATION_DATABASE_URL`]: databaseUrl(
						service,
						service.migrationRole
					),
					[`${prefix}_TEST_RUNTIME_ROLE`]: service.runtimeRole,
					[`${prefix}_TEST_SKIP_MIGRATIONS`]: 'true'
				},
				label: `${app} PostgreSQL 18 integration`
			}
		);
		log(`${app} ${file} passed`);
		assert.ok(
			output.length > 0,
			'Expected an integration completion result'
		);
	}
}

function optionalDomainTestBrokerEnvironment(file) {
	const name = {
		'acceptance-postgres18.integration.mjs':
			'CRM_INTAKE_ACCEPTANCE_TEST_RABBITMQ_URL',
		'widget-control-postgres18.integration.mjs':
			'CRM_INTAKE_WIDGET_CONTROL_TEST_RABBITMQ_URL'
	}[file];
	if (!name || process.env[name] === undefined) return {};
	const value = process.env[name];
	secrets.add(value);
	try {
		const url = new URL(value);
		secrets.add(url.password);
		secrets.add(decodeURIComponent(url.password));
		assert.ok(
			url.protocol === 'amqp:' &&
				url.hostname === '127.0.0.1' &&
				url.port === '5673' &&
				decodeURIComponent(url.username) &&
				decodeURIComponent(url.password) &&
				!url.search &&
				!url.hash
		);
		assert.match(
			decodeURIComponent(url.pathname),
			/^\/[a-z0-9_-]+_(test|ci)$/
		);
		return { [name]: value };
	} catch {
		throw new Error(
			'Optional domain broker proof requires scoped credentials on a loopback 127.0.0.1:5673 test vhost; values suppressed'
		);
	}
}

function nativeTransferTestBrokerEnvironment() {
	const names = [
		'CRM_INTAKE_WIDGET_TRANSFER_TEST_RABBITMQ_URL',
		'CRM_INTAKE_WIDGET_TRANSFER_TEST_WORKER_RABBITMQ_URL',
		'CRM_INTAKE_WIDGET_TRANSFER_TEST_PUBLISHER_RABBITMQ_URL'
	];
	const supplied = names.map(name => process.env[name]);
	if (supplied.every(value => value === undefined)) return {};
	try {
		const urls = supplied.map(value => new URL(value));
		for (const url of urls) {
			assert.ok(
				url.protocol === 'amqp:' &&
					url.hostname === '127.0.0.1' &&
					url.port === '5673' &&
					url.username &&
					url.password &&
					!url.search &&
					!url.hash
			);
			assert.match(
				decodeURIComponent(url.pathname),
				/^\/[a-z0-9_-]+_(test|ci)$/
			);
			assert.equal(url.pathname, urls[0].pathname);
		}
		assert.equal(new Set(urls.map(url => url.username)).size, 3);
		for (const [index, value] of supplied.entries()) {
			secrets.add(value);
			secrets.add(urls[index].password);
			secrets.add(decodeURIComponent(urls[index].password));
		}
		return Object.fromEntries(
			names.map((name, index) => [name, supplied[index]])
		);
	} catch {
		throw new Error(
			'Native transfer test requires three distinct scoped credentials for one loopback 127.0.0.1:5673 test vhost; values suppressed'
		);
	}
}

function nativeWidgetHttpBrokerEnvironment() {
	const current = nativeTransferTestBrokerEnvironment();
	const value =
		process.env
			.CRM_INTAKE_WIDGET_TRANSFER_TEST_WIDGETS_PUBLISHER_RABBITMQ_URL;
	try {
		const peers = [
			current.CRM_INTAKE_WIDGET_TRANSFER_TEST_RABBITMQ_URL,
			current.CRM_INTAKE_WIDGET_TRANSFER_TEST_WORKER_RABBITMQ_URL,
			current.CRM_INTAKE_WIDGET_TRANSFER_TEST_PUBLISHER_RABBITMQ_URL,
			value
		].map(raw => new URL(raw));
		assert.ok(
			peers.every(
				peer =>
					peer.protocol === 'amqp:' &&
					peer.hostname === '127.0.0.1' &&
					peer.port === '5673' &&
					peer.pathname === peers[0].pathname &&
					peer.username &&
					peer.password &&
					!peer.search &&
					!peer.hash
			)
		);
		assert.equal(
			new Set(peers.map(peer => decodeURIComponent(peer.username))).size,
			4
		);
		secrets.add(value);
		secrets.add(peers[3].password);
		secrets.add(decodeURIComponent(peers[3].password));
		return {
			provisioner: current.CRM_INTAKE_WIDGET_TRANSFER_TEST_RABBITMQ_URL,
			worker: current.CRM_INTAKE_WIDGET_TRANSFER_TEST_WORKER_RABBITMQ_URL,
			publisher:
				current.CRM_INTAKE_WIDGET_TRANSFER_TEST_PUBLISHER_RABBITMQ_URL,
			widgetsPublisher: value
		};
	} catch {
		throw new Error(
			'Native Widget HTTP proof requires four distinct scoped principals on one local test vhost; values suppressed'
		);
	}
}

function environment() {
	const tokens = {};
	for (const key of [
		'IDENTITY_CAMPAIGNS_TOKEN',
		'IDENTITY_REPORTING_TOKEN',
		'IDENTITY_WIDGETS_TOKEN',
		'IDENTITY_BILLING_TOKEN',
		'IDENTITY_CRM_ACCESS_TOKEN',
		'IDENTITY_PLATFORM_TOKEN',
		'IDENTITY_SUPPORT_TOKEN',
		'IDENTITY_OPERATIONS_TOKEN',
		'BILLING_IDENTITY_TOKEN',
		'WIDGETS_IDENTITY_TOKEN',
		'OPERATIONS_IDENTITY_TOKEN',
		'BILLING_CRM_ACCESS_TOKEN',
		'BILLING_CAMPAIGNS_TOKEN',
		'BILLING_OPERATIONS_TOKEN',
		'WIDGETS_INTERNAL_TOKEN',
		...(withWidgets
			? [
					'WIDGETS_CRM_INTAKE_TOKEN',
					'BILLING_WINCRM_WIDGETS_TOKEN',
					'BILLING_WINCRM_CRM_INTAKE_TOKEN',
					'WIDGETS_OPERATIONS_TOKEN',
					'WIDGETS_CALLBACK_OTP_SECRET',
					'WIDGETS_AI_SESSION_SECRET',
					'CLOUDFLARE_API_TOKEN',
					'CLOUDFLARE_TURNSTILE_SECRET_KEY'
				]
			: []),
		'CRM_SALES_CRM_ACCESS_TOKEN',
		'CRM_SALES_CRM_INTAKE_TOKEN',
		'CRM_CUSTOMERS_CRM_SALES_TOKEN',
		'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
		'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
		'CRM_ACCESS_CRM_SALES_TOKEN',
		'CRM_ACCESS_CRM_INTAKE_TOKEN'
	])
		tokens[key] = generated();
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048
	});
	const signingKey = privateKey
		.export({ type: 'pkcs8', format: 'pem' })
		.toString();
	const kid = `local-${runId}`;
	const jwks = {
		keys: [
			{
				...publicKey.export({ format: 'jwk' }),
				kid,
				alg: 'RS256',
				use: 'sig',
				key_ops: ['verify']
			}
		]
	};
	const encodedKey = Buffer.from(signingKey).toString('base64');
	const encryptionKey = randomBytes(32).toString('base64');
	secrets.add(signingKey);
	secrets.add(encodedKey);
	secrets.add(encryptionKey);
	return {
		...tokens,
		CORS_ALLOWED_ORIGINS: cors,
		TRUST_PROXY: 'loopback',
		AUTH_COOKIE_DOMAIN: '',
		IDENTITY_PROCESS_ROLE: 'api',
		BILLING_PROCESS_ROLE: 'api',
		CRM_ACCESS_PROCESS_ROLE: 'api',
		CRM_INTAKE_PROCESS_ROLE: 'api',
		BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: String(withWidgets),
		CRM_INTAKE_WIDGETS_ENABLED: String(withWidgets),
		CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: String(withNativeWidgetHttp),
		...(withWidgets
			? {
					WIDGETS_PROCESS_ROLE: 'api',
					WIDGETS_LISTEN_HOST: '127.0.0.1',
					WIDGETS_PORT: '4700',
					WIDGETS_WINCRM_CONNECTOR_ENABLED: 'true',
					WIDGETS_ENTITLEMENT_MAX_STALENESS_MS: '86400000',
					CLOUDFLARE_ACCOUNT_ID: 'local-qa-account',
					CLOUDFLARE_AI_GATEWAY_ID: 'local-qa-gateway',
					CLOUDFLARE_AI_MODEL: '@cf/local/disabled',
					CLOUDFLARE_TURNSTILE_SITE_KEY: 'local-qa-disabled',
					CLOUDFLARE_AI_API_ORIGIN: 'http://127.0.0.1:59991',
					CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN: 'http://127.0.0.1:59991'
				}
			: {}),
		WINCRM_INVITATION_EMAIL_ENABLED: 'false',
		IDENTITY_LISTEN_HOST: '127.0.0.1',
		BILLING_LISTEN_HOST: '127.0.0.1',
		CRM_ACCESS_LISTEN_HOST: '127.0.0.1',
		CRM_CUSTOMERS_LISTEN_HOST: '127.0.0.1',
		CRM_SALES_LISTEN_HOST: '127.0.0.1',
		CRM_INTAKE_LISTEN_HOST: '127.0.0.1',
		JWT_ACCESS_PRIVATE_KEY_BASE64: encodedKey,
		JWT_ACCESS_JWKS_BASE64: Buffer.from(JSON.stringify(jwks)).toString(
			'base64'
		),
		JWT_ACCESS_ACTIVE_KID: kid,
		JWT_ISSUER: jwtIssuer,
		JWT_AUDIENCE: 'winwidget-api',
		JWT_ACCESS_TTL_SECONDS: '900',
		JWT_CLOCK_TOLERANCE_SECONDS: '0',
		PAYMENT_METHOD_ENCRYPTION_KEY: encryptionKey,
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
		WIDGETS_INTERNAL_BASE_URL: 'http://127.0.0.1:4700',
		OPERATIONS_INTERNAL_BASE_URL: 'http://127.0.0.1:5200',
		CRM_ACCESS_INTERNAL_BASE_URL: 'http://127.0.0.1:5300',
		CRM_CUSTOMERS_INTERNAL_BASE_URL: 'http://127.0.0.1:5320',
		CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330',
		RECAPTCHA_ENABLED: 'false',
		RECAPTCHA_CLIENT_URL: 'http://localhost:3000',
		IDENTITY_AVATAR_S3_ENDPOINT: 'http://127.0.0.1:59990',
		IDENTITY_AVATAR_S3_PUBLIC_BASE_URL: 'http://127.0.0.1:59990/avatars',
		IDENTITY_AVATAR_S3_REGION: 'local-test',
		IDENTITY_AVATAR_S3_BUCKET: 'local-test-avatars',
		IDENTITY_AVATAR_S3_ACCESS_KEY_ID: generated(),
		IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY: generated(),
		IDENTITY_AVATAR_S3_FORCE_PATH_STYLE: 'true'
	};
}

function ownedEnvironment(app, values) {
	const keys = {
		identity: [
			'IDENTITY_PROCESS_ROLE',
			'WINCRM_INVITATION_EMAIL_ENABLED',
			'IDENTITY_LISTEN_HOST',
			'AUTH_COOKIE_DOMAIN',
			'JWT_ACCESS_PRIVATE_KEY_BASE64',
			'JWT_ACCESS_JWKS_BASE64',
			'JWT_ACCESS_ACTIVE_KID',
			'JWT_ISSUER',
			'JWT_AUDIENCE',
			'JWT_ACCESS_TTL_SECONDS',
			'JWT_CLOCK_TOLERANCE_SECONDS',
			'IDENTITY_CAMPAIGNS_TOKEN',
			'IDENTITY_REPORTING_TOKEN',
			'IDENTITY_WIDGETS_TOKEN',
			'IDENTITY_BILLING_TOKEN',
			'IDENTITY_CRM_ACCESS_TOKEN',
			'IDENTITY_PLATFORM_TOKEN',
			'IDENTITY_SUPPORT_TOKEN',
			'IDENTITY_OPERATIONS_TOKEN',
			'BILLING_IDENTITY_TOKEN',
			'WIDGETS_IDENTITY_TOKEN',
			'OPERATIONS_IDENTITY_TOKEN',
			'BILLING_INTERNAL_BASE_URL',
			'WIDGETS_INTERNAL_BASE_URL',
			'OPERATIONS_INTERNAL_BASE_URL',
			'RECAPTCHA_ENABLED',
			'RECAPTCHA_CLIENT_URL',
			'IDENTITY_AVATAR_S3_ENDPOINT',
			'IDENTITY_AVATAR_S3_PUBLIC_BASE_URL',
			'IDENTITY_AVATAR_S3_REGION',
			'IDENTITY_AVATAR_S3_BUCKET',
			'IDENTITY_AVATAR_S3_ACCESS_KEY_ID',
			'IDENTITY_AVATAR_S3_SECRET_ACCESS_KEY',
			'IDENTITY_AVATAR_S3_FORCE_PATH_STYLE'
		],
		billing: [
			'BILLING_PROCESS_ROLE',
			'BILLING_LISTEN_HOST',
			'PAYMENT_METHOD_ENCRYPTION_KEY',
			'BILLING_IDENTITY_TOKEN',
			'BILLING_CRM_ACCESS_TOKEN',
			'BILLING_CAMPAIGNS_TOKEN',
			'BILLING_OPERATIONS_TOKEN',
			'IDENTITY_BILLING_TOKEN',
			'IDENTITY_INTERNAL_BASE_URL',
			'WIDGETS_INTERNAL_TOKEN',
			'WIDGETS_INTERNAL_BASE_URL',
			'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED',
			...(withWidgets
				? [
						'BILLING_WINCRM_WIDGETS_TOKEN',
						'BILLING_WINCRM_CRM_INTAKE_TOKEN'
					]
				: [])
		],
		widgets: [
			'WIDGETS_PROCESS_ROLE',
			'WIDGETS_LISTEN_HOST',
			'WIDGETS_PORT',
			'WIDGETS_WINCRM_CONNECTOR_ENABLED',
			'WIDGETS_ENTITLEMENT_MAX_STALENESS_MS',
			'WIDGETS_CRM_INTAKE_TOKEN',
			'BILLING_WINCRM_WIDGETS_TOKEN',
			'BILLING_INTERNAL_BASE_URL',
			'WIDGETS_INTERNAL_TOKEN',
			'WIDGETS_IDENTITY_TOKEN',
			'WIDGETS_OPERATIONS_TOKEN',
			'IDENTITY_WIDGETS_TOKEN',
			'IDENTITY_INTERNAL_BASE_URL',
			'WIDGETS_CALLBACK_OTP_SECRET',
			'WIDGETS_AI_SESSION_SECRET',
			'CLOUDFLARE_ACCOUNT_ID',
			'CLOUDFLARE_API_TOKEN',
			'CLOUDFLARE_AI_GATEWAY_ID',
			'CLOUDFLARE_AI_MODEL',
			'CLOUDFLARE_TURNSTILE_SITE_KEY',
			'CLOUDFLARE_TURNSTILE_SECRET_KEY',
			'CLOUDFLARE_AI_API_ORIGIN',
			'CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN'
		],
		'crm-access': [
			'CRM_ACCESS_PROCESS_ROLE',
			'CRM_ACCESS_LISTEN_HOST',
			'IDENTITY_INTERNAL_BASE_URL',
			'IDENTITY_CRM_ACCESS_TOKEN',
			'BILLING_INTERNAL_BASE_URL',
			'BILLING_CRM_ACCESS_TOKEN',
			'CRM_SALES_INTERNAL_BASE_URL',
			'CRM_SALES_CRM_ACCESS_TOKEN',
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
			'CRM_ACCESS_CRM_SALES_TOKEN',
			'CRM_ACCESS_CRM_INTAKE_TOKEN'
		],
		'crm-customers': [
			'CRM_CUSTOMERS_LISTEN_HOST',
			'CRM_ACCESS_INTERNAL_BASE_URL',
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
			'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_SALES_TOKEN'
		],
		'crm-sales': [
			'CRM_SALES_LISTEN_HOST',
			'CRM_SALES_CRM_ACCESS_TOKEN',
			'CRM_SALES_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_SALES_TOKEN',
			'CRM_ACCESS_INTERNAL_BASE_URL',
			'CRM_ACCESS_CRM_SALES_TOKEN',
			'CRM_CUSTOMERS_INTERNAL_BASE_URL'
		],
		'crm-intake': [
			'CRM_INTAKE_PROCESS_ROLE',
			'CRM_INTAKE_LISTEN_HOST',
			'CRM_ACCESS_INTERNAL_BASE_URL',
			'CRM_ACCESS_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_INTERNAL_BASE_URL',
			'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
			'CRM_SALES_INTERNAL_BASE_URL',
			'CRM_SALES_CRM_INTAKE_TOKEN',
			'CRM_INTAKE_WIDGETS_ENABLED',
			'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED',
			...(withWidgets
				? ['WIDGETS_INTERNAL_BASE_URL', 'WIDGETS_CRM_INTAKE_TOKEN']
				: [])
		]
	};
	return {
		...Object.fromEntries(
			['CORS_ALLOWED_ORIGINS', 'TRUST_PROXY', ...keys[app]].map(key => [
				key,
				values[key]
			])
		),
		...(app === 'widgets' ? { NODE_ENV: 'test' } : {})
	};
}

async function seedIdentity() {
	const service = byApp.identity;
	const require = createRequire(join(service.root, 'package.json'));
	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/identity-client');
	const { hash } = require('bcryptjs');
	const { WorkspaceProvisioningService } = require(
		join(
			service.root,
			'dist/src/workspaces/workspace-provisioning.service.js'
		)
	);
	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl(service, service.runtimeRole) } }
	});
	const workspaces = new WorkspaceProvisioningService();
	const accounts = {};
	try {
		await prisma.authSettings.update({
			where: { id: 'singleton' },
			data: {
				recaptchaEnabled: false,
				googleAuthEnabled: false,
				githubAuthEnabled: false,
				yandexAuthEnabled: false,
				vkAuthEnabled: false,
				telegramAuthEnabled: false
			}
		});
		for (const [name, rights] of [
			['owner', ['USER', 'ADMIN', 'DEV']],
			['admin', ['USER', 'ADMIN']],
			['manager', ['USER']],
			['teamLead', ['USER']],
			['analyst', ['USER']],
			...(args.has('--verify-acceptance-http')
				? [['workflow', ['USER']]]
				: [])
		]) {
			const password = `Qa1!${generated()}`;
			secrets.add(password);
			const email = `wincrm-${name.toLowerCase()}@example.test`;
			const userId = `wincrm-local-${name}-${runId}`;
			const passwordHash = await hash(password, 10);
			secrets.add(passwordHash);
			const workspace = await prisma.$transaction(async transaction => {
				await transaction.user.create({
					data: {
						id: userId,
						name: `WinCRM QA ${name}`,
						password: passwordHash,
						rights,
						authIdentities: {
							create: {
								type: 'EMAIL',
								value: email,
								verifiedAt: new Date()
							}
						}
					}
				});
				return workspaces.provisionPersonalWorkspace(transaction, userId);
			});
			accounts[name] = {
				email,
				password,
				userId,
				workspaceId: workspace.id
			};
		}
	} finally {
		await prisma.$disconnect();
	}
	return accounts;
}

async function seedWidgets(account) {
	assert.ok(
		withWidgets && byApp.widgets,
		'Widgets fixture requires its explicit profile'
	);
	assert.equal(account.userId, `wincrm-local-owner-${runId}`);
	const widgets = byApp.widgets,
		billing = byApp.billing;
	const widgetsRequire = createRequire(join(widgets.root, 'package.json'));
	const billingRequire = createRequire(join(billing.root, 'package.json'));
	const widgetsDb = new (widgetsRequire(
		'@prisma/widgets-client'
	).PrismaClient)({
		datasources: {
			db: { url: databaseUrl(widgets, widgets.runtimeRole) }
		},
		log: []
	});
	const billingDb = new (billingRequire(
		'@prisma/billing-client'
	).PrismaClient)({
		datasources: {
			db: { url: databaseUrl(billing, billing.runtimeRole) }
		},
		log: []
	});
	try {
		const now = new Date(),
			startsAt = new Date(now.getTime() - 60000),
			expiresAt = new Date(now.getTime() + 30 * 86400000);
		assert.equal(
			await billingDb.subscription.count({
				where: { userId: account.userId }
			}),
			0,
			'Synthetic owner must not already have a subscription'
		);
		// Isolated fixture, not checkout or a simulated payment. No shared DB access enters a runtime.
		const subscription = await billingDb.subscription.create({
			data: {
				userId: account.userId,
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				status: 'ACTIVE',
				startsAt,
				expiresAt,
				periodResetsAt: expiresAt,
				aggregateVersion: 1n,
				sourceSequence: 1n
			}
		});
		const { getWidgetDefinition, WidgetType } = widgetsRequire(
			join(widgets.root, 'dist/src/domain/widgets-domain.types.js')
		);
		const config = getWidgetDefinition(WidgetType.QUIZ).defaultConfig();
		const publicKey = randomBytes(6).toString('hex');
		const quiz = await widgetsDb.$transaction(async tx => {
			await tx.widgetOwnerProjection.create({
				data: {
					userId: account.userId,
					status: 'ACTIVE',
					aggregateVersion: 1n,
					sourceSequence: 1n,
					sourceOccurredAt: now
				}
			});
			await tx.widgetEntitlementProjection.create({
				data: {
					// The projection key is the actual Billing subscription CUID, never a new local ID.
					id: subscription.id,
					userId: account.userId,
					plan: subscription.plan,
					billingPeriod: subscription.billingPeriod,
					status: subscription.status,
					startsAt: subscription.startsAt,
					expiresAt: subscription.expiresAt,
					periodResetsAt: subscription.periodResetsAt,
					maxWidgets: 100,
					maxLeadsPerPeriod: 100,
					unlimited: false,
					aggregateVersion: subscription.aggregateVersion,
					sourceSequence: subscription.sourceSequence,
					sourceOccurredAt: now,
					sourceCreatedAt: subscription.createdAt,
					sourceUpdatedAt: subscription.updatedAt
				}
			});
			if (withNativeWidgetHttp)
				await tx.widgetUsageCounter.create({
					data: {
						userId: account.userId,
						widgetCount: 1,
						leadCount: 0,
						leadPeriodKey: expiresAt.toISOString(),
						leadPeriodStartsAt: startsAt,
						leadPeriodEndsAt: expiresAt,
						entitlementVersion: subscription.aggregateVersion
					}
				});
			return tx.quiz.create({
				data: {
					userId: account.userId,
					publicKey,
					name: 'WinCRM local QA Quiz',
					isActive: true,
					installDomain: 'localhost',
					config,
					draftRevision: 1,
					publishedVersion: 1,
					publishedFromDraftRevision: 1,
					publishedAt: now
				}
			});
		});
		log(
			'Seeded one synthetic published Quiz and matching Billing EASY/Widgets projection; no payment or historical lead import'
		);
		return {
			widgetType: 'QUIZ',
			widgetId: quiz.id,
			publicKey,
			workspaceId: account.workspaceId,
			ownerSubject: account.userId,
			subscriptionId: subscription.id,
			subscriptionVersion: subscription.aggregateVersion.toString(),
			startsAt: startsAt.toISOString(),
			expiresAt: expiresAt.toISOString()
		};
	} catch {
		throw new Error(
			'Synthetic Widgets/Billing fixture creation failed; database details suppressed'
		);
	} finally {
		await Promise.all([widgetsDb.$disconnect(), billingDb.$disconnect()]);
	}
}

async function verifyWidgetsControlHttp(
	account,
	widget,
	environmentValues
) {
	const intake = byApp['crm-intake'];
	const intakeEnvironment = ownedEnvironment(
		'crm-intake',
		environmentValues
	);
	const previous = new Map(
		Object.keys(intakeEnvironment).map(key => [key, process.env[key]])
	);
	for (const [key, value] of Object.entries(intakeEnvironment))
		process.env[key] = value;
	const require = createRequire(join(intake.root, 'package.json'));
	require('reflect-metadata');
	const { PrismaClient } = require('@prisma/crm-intake-client');
	const prisma = new PrismaClient({
		datasources: { db: { url: databaseUrl(intake, intake.runtimeRole) } },
		log: []
	});
	const request = async (
		path,
		{ method = 'GET', token, body, expected = 200 } = {}
	) => {
		const response = await fetch(`${publicApi}${path}`, {
			method,
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body?.commandId ? { 'Idempotency-Key': body.commandId } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			throw new Error(
				`Local Widget control HTTP expected ${expected}, received ${response.status}`
			);
		}
		return response.json();
	};
	try {
		const session = await request('/auth/login', {
			method: 'POST',
			body: { email: account.email, password: account.password }
		});
		assert.equal(session.user.id, account.userId);
		assert.ok(
			typeof session.accessToken === 'string' &&
				session.accessToken.length > 100
		);
		secrets.add(session.accessToken);
		const token = session.accessToken;
		const candidatesPath = `/crm/intake/widget-sources/candidates?workspaceId=${account.workspaceId}&page=1&pageSize=25`;
		const candidates = await request(candidatesPath, { token });
		assert.equal(candidates.schemaVersion, 1);
		assert.equal(candidates.workspaceId, account.workspaceId);
		assert.equal(candidates.eligibility.eligible, true);
		assert.equal(candidates.eligibility.plan, 'EASY');
		assert.equal(candidates.items.length, 1);
		assert.equal(candidates.items[0].widgetId, widget.widgetId);
		assert.equal(candidates.items[0].widgetType, 'QUIZ');
		assert.equal(candidates.items[0].connection, 'NONE');
		const command = {
			schemaVersion: 1,
			workspaceId: account.workspaceId,
			commandId: randomUUID(),
			name: 'Local Quiz control proof',
			widgetType: 'QUIZ',
			widgetId: widget.widgetId,
			teamId: null
		};
		const created = await request('/crm/intake/widget-sources', {
			token,
			method: 'POST',
			body: command,
			expected: 202
		});
		assert.equal(created.command.id, command.commandId);
		assert.equal(created.command.state, 'QUEUED');
		assert.equal(created.source.syncState, 'PENDING');
		assert.equal(created.source.workspaceId, account.workspaceId);
		const sourceId = created.source.id;
		assert.match(
			sourceId,
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
		);
		const job = await prisma.widgetControlJob.findUniqueOrThrow({
			where: { commandId: command.commandId }
		});
		const outbox = await prisma.widgetControlOutbox.findFirstOrThrow({
			where: { eventId: job.activeEventId, route: 'MAIN' }
		});
		assert.equal(outbox.status, 'PENDING');
		assert.equal(outbox.publishedAt, null);
		const { WidgetControlConfig } = require(
			join(intake.root, 'dist/src/widget-sources/widget-control.config.js')
		);
		const { WidgetsControlClient } = require(
			join(
				intake.root,
				'dist/src/widget-sources/widgets-control.client.js'
			)
		);
		const { IntakeAuthorizationClient } = require(
			join(intake.root, 'dist/src/access/intake-authorization.client.js')
		);
		const { WidgetControlProcessor } = require(
			join(
				intake.root,
				'dist/src/widget-sources/widget-control.processor.js'
			)
		);
		const { parseControlEvent } = require(
			join(
				intake.root,
				'dist/src/widget-sources/widget-control.contract.js'
			)
		);
		const event = parseControlEvent(outbox.payload);
		assert.equal(event.sourceId, sourceId);
		assert.equal(event.workspaceId, account.workspaceId);
		const processor = new WidgetControlProcessor(
			prisma,
			new IntakeAuthorizationClient(),
			new WidgetsControlClient(new WidgetControlConfig())
		);
		// Deliberately drive one real durable claim; no publisher, broker or PUBLISHED substitution.
		const claim = await processor.claim(event, 0);
		assert.equal(claim.state, 'CLAIMED');
		await processor.run(event, claim.token);
		assert.equal((await processor.claim(event, 0)).state, 'DONE');
		const applied = await request(
			`/crm/intake/widget-sources/${sourceId}?workspaceId=${account.workspaceId}`,
			{ token }
		);
		assert.equal(applied.source.syncState, 'SYNCED');
		assert.equal(applied.source.enabled, true);
		assert.equal(applied.source.appliedControlVersion, 1);
		assert.equal(applied.source.appliedGeneration, 1);
		assert.equal(applied.source.widgetId, widget.widgetId);
		const connected = await request(candidatesPath, { token });
		assert.equal(connected.items[0].connection, 'THIS_WORKSPACE');
		assert.equal(connected.items[0].sourceId, sourceId);
		const retained = await prisma.widgetControlOutbox.findUniqueOrThrow({
			where: { id: outbox.id }
		});
		assert.equal(retained.status, 'PENDING');
		assert.equal(retained.publishedAt, null);
		const replay = await request('/crm/intake/widget-sources', {
			token,
			method: 'POST',
			body: command,
			expected: 202
		});
		assert.deepEqual(
			replay,
			created,
			'Replay must return the historical queued command, not the current synchronized state'
		);
		log(
			'Widget control HTTP proof passed: fresh public candidates/create, real Widgets configure and durable Intake claim; no RabbitMQ or lead-transfer proof'
		);
		return {
			...widget,
			sourceId,
			connectorId: job.connectorId,
			controlCommandId: command.commandId,
			controlEventId: event.eventId,
			controlOutboxId: outbox.id,
			controlHttpVerified: true,
			outboxPublicationVerified: false,
			leadTransfersVerified: false
		};
	} catch (error) {
		throw new Error(
			safeFailure(
				'Local Widget control HTTP proof',
				error?.message || 'FAILED'
			)
		);
	} finally {
		await prisma.$disconnect();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function seedTeamFixtures(accounts, workspaceId) {
	// A real Trial snapshot, not the mutable policy defaults, owns this capacity.
	// Only the manager persona is needed by the HTTP workflow and browser seed.
	const owner = Object.values(accounts).find(
		account => account.workspaceId === workspaceId
	);
	assert.ok(
		owner,
		'The team fixture requires its synthetic workspace owner'
	);
	const request = async (path, { body, token } = {}) => {
		const response = await fetch(`${publicApi}${path}`, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== 200) {
			await response.body?.cancel();
			throw new Error(
				'Team fixture authorization or capacity unavailable'
			);
		}
		return response.json();
	};
	const session = await request('/auth/login', {
		body: { email: owner.email, password: owner.password }
	});
	assert.equal(session.user.id, owner.userId);
	assert.ok(
		typeof session.accessToken === 'string' &&
			session.accessToken.length > 100
	);
	secrets.add(session.accessToken);
	const rosterPath = `/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=100`;
	const before = await request(rosterPath, { token: session.accessToken });
	assert.equal(before.schemaVersion, 1);
	assert.equal(before.workspaceId, workspaceId);
	assert.equal(before.ownerSubject, owner.userId);
	assert.ok(
		Number.isSafeInteger(before.quota?.seatLimit) &&
			before.quota.seatLimit >= 2 &&
			before.quota.seatLimit <= 10000
	);
	assert.equal(before.quota.usedSeats, 1);
	assert.equal(before.quota.waitingCount, 0);
	assert.equal(before.total, 0);
	assert.deepEqual(before.items, []);
	assert.ok(before.quota.seatLimit - before.quota.usedSeats >= 1);
	const identity = byApp.identity;
	const accessService = byApp['crm-access'];
	const identityRequire = createRequire(
		join(identity.root, 'package.json')
	);
	const accessRequire = createRequire(
		join(accessService.root, 'package.json')
	);
	const identityDb = new (identityRequire(
		'@prisma/identity-client'
	).PrismaClient)({
		datasources: {
			db: { url: databaseUrl(identity, identity.runtimeRole) }
		}
	});
	const accessDb = new (accessRequire(
		'@prisma/crm-access-client'
	).PrismaClient)({
		datasources: {
			db: { url: databaseUrl(accessService, accessService.runtimeRole) }
		}
	});
	const teamId = randomUUID();
	try {
		const membership = await identityDb.workspaceMember.create({
			data: {
				workspaceId,
				userId: accounts.manager.userId,
				role: 'MEMBER',
				status: 'ACTIVE'
			}
		});
		const members = [
			{
				id: randomUUID(),
				workspaceId,
				subject: accounts.manager.userId,
				membershipId: membership.id,
				role: 'MANAGER'
			}
		];
		await accessDb.$transaction(async tx => {
			await tx.crmTeam.create({
				data: { id: teamId, workspaceId, name: 'Локальная команда QA' }
			});
			await tx.crmWorkspaceMember.createMany({ data: members });
			await tx.crmMemberTeam.createMany({
				data: members.map(member => ({
					workspaceId,
					memberId: member.id,
					teamId
				}))
			});
		});
		const after = await request(rosterPath, {
			token: session.accessToken
		});
		assert.equal(after.schemaVersion, 1);
		assert.equal(after.workspaceId, workspaceId);
		assert.equal(after.ownerSubject, owner.userId);
		assert.deepEqual(after.quota, {
			seatLimit: before.quota.seatLimit,
			usedSeats: 2,
			waitingCount: 0
		});
		assert.equal(after.total, 1);
		assert.equal(after.items.length, 1);
		assert.equal(after.items[0].id, members[0].id);
		assert.equal(after.items[0].subject, accounts.manager.userId);
		assert.equal(after.items[0].role, 'MANAGER');
		assert.equal(after.items[0].disabledAt, null);
		Object.assign(accounts.manager, {
			crmWorkspaceId: workspaceId,
			crmMemberId: members[0].id,
			crmTeamId: teamId,
			workflowMemberId: members[0].id
		});
		log(
			`Seeded two-role CRM fixture (OWNER + MANAGER), 2/${before.quota.seatLimit} seats verified through public Access; other personas keep their own workspaces; invitation/admission/email delivery is not simulated`
		);
	} finally {
		await Promise.all([identityDb.$disconnect(), accessDb.$disconnect()]);
	}
}

function start(label, command, commandArgs, env, cwd = stateDirectory) {
	const child = spawn(command, commandArgs, {
		cwd,
		env: { ...safeEnvironment, ...env },
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const state = { child, output: '', exited: false };
	children.set(label, state);
	const collect = chunk => {
		state.output = (state.output + chunk.toString()).slice(-12_000);
	};
	child.stdout.on('data', collect);
	child.stderr.on('data', collect);
	child.once('error', error => {
		state.output += error.message;
		state.exited = true;
	});
	child.once('exit', () => {
		state.exited = true;
		if (ready && !stopping) {
			console.error(safeFailure(label, state.output));
			void shutdown(1);
		}
	});
}

async function waitForHttp(label, url, status = 200) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const child = children.get(label);
		if (child?.exited)
			throw new Error(safeFailure(`${label} startup`, child.output));
		try {
			const response = await fetch(url, {
				redirect: 'manual',
				signal: AbortSignal.timeout(3000)
			});
			if (response.status === status) {
				log(`${label} ready`);
				return;
			}
		} catch {
			/* Wait for real startup, never substitute a fake response. */
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 500));
	}
	throw new Error(
		safeFailure(`${label} readiness`, children.get(label)?.output || '')
	);
}

async function startFrontend(folder, port, env) {
	const root = join(workspaceRoot, folder);
	const mirror = join(stateDirectory, folder);
	await mkdir(mirror);
	// Next's route discovery does not follow a symlinked src/app tree.
	const sourceHash = await copyFrontendSource(root, mirror);
	frontendSnapshots[folder] = { mirror, sourceHash };
	log(`${folder} source SHA-256 ${sourceHash}`);
	for (const entry of ['node_modules']) {
		await access(join(root, entry));
		await symlink(join(root, entry), join(mirror, entry), 'dir');
	}
	const cli = join(root, 'node_modules/next/dist/bin/next');
	start(
		folder,
		process.execPath,
		[
			cli,
			'dev',
			mirror,
			'--hostname',
			'127.0.0.1',
			'--port',
			String(port),
			...(folder.endsWith('_crm') ? ['--webpack'] : [])
		],
		env,
		mirror
	);
	await waitForHttp(
		folder,
		`http://127.0.0.1:${port}${folder.endsWith('_crm') ? '/inbox' : '/login'}`
	);
}

async function smoke(accounts) {
	const login = async account => {
		const response = await fetch(`${publicApi}/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: account.email,
				password: account.password
			}),
			signal: AbortSignal.timeout(15000)
		});
		if (response.status !== 200) {
			throw new Error(
				`Normal Identity login failed HTTP ${response.status}: ${scrub(await response.text())}; Billing: ${scrub(children.get('billing')?.output.slice(-2200) || '')}`
			);
		}
		const data = await response.json();
		assert.equal(data.user.id, account.userId);
		assert.ok(
			typeof data.accessToken === 'string' && data.accessToken.length > 100
		);
		secrets.add(data.accessToken);
		const cookie = response.headers.get('set-cookie');
		assert.match(cookie || '', /refreshToken=/);
		assert.doesNotMatch(cookie || '', /Domain=winwidget\.ru/i);
		return data.accessToken;
	};
	const ownerToken = await login(accounts.owner);
	const ownerHeaders = {
		authorization: `Bearer ${ownerToken}`,
		'content-type': 'application/json'
	};
	const anonymous = await fetch(`${publicApi}/crm/access/bootstrap`);
	assert.equal(
		anonymous.status,
		401,
		'Anonymous access must require normal login'
	);
	const bootstrap = await fetch(`${publicApi}/crm/access/bootstrap`, {
		headers: ownerHeaders
	});
	assert.equal(bootstrap.status, 200);
	const state = await bootstrap.json();
	assert.equal(state.state, 'NOT_ACTIVATED');
	const pricingResponse = await fetch(
		`${publicApi}/billing-settings/admin/crm`,
		{ headers: ownerHeaders }
	);
	assert.equal(pricingResponse.status, 200);
	const pricing = await pricingResponse.json();
	assert.equal(pricing.includedSeats, 2);
	assert.equal(
		(await fetch(`${publicApi}/billing-settings/crm`)).status,
		401,
		'Customer pricing must still require normal Identity login'
	);
	const customerToken = await login(accounts.workflow || accounts.manager);
	const customerPricing = await fetch(
		`${publicApi}/billing-settings/crm`,
		{
			headers: { authorization: `Bearer ${customerToken}` }
		}
	);
	assert.equal(customerPricing.status, 200);
	assert.equal(customerPricing.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await customerPricing.json(), pricing);
	assert.equal(
		(
			await fetch(`${publicApi}/billing-settings/admin/crm`, {
				headers: { authorization: `Bearer ${customerToken}` }
			})
		).status,
		403,
		'Customer pricing must not confer administrator access'
	);
	const adminToken = await login(accounts.admin);
	const adminHeaders = {
		authorization: `Bearer ${adminToken}`,
		'content-type': 'application/json'
	};
	assert.equal(
		(
			await fetch(`${publicApi}/billing-settings/admin/crm`, {
				headers: adminHeaders
			})
		).status,
		200
	);
	const commandId = randomUUID();
	assert.equal(
		(
			await fetch(`${publicApi}/billing-settings/admin/crm`, {
				method: 'PUT',
				headers: { ...adminHeaders, 'Idempotency-Key': commandId },
				body: JSON.stringify({
					schemaVersion: 1,
					commandId,
					expectedVersion: pricing.version,
					monthlyPriceMinor: pricing.monthlyPriceMinor,
					yearlyPriceMinor: pricing.yearlyPriceMinor,
					additionalSeatMonthlyPriceMinor:
						pricing.additionalSeatMonthlyPriceMinor,
					additionalSeatYearlyPriceMinor:
						pricing.additionalSeatYearlyPriceMinor,
					includedSeats: pricing.includedSeats,
					trialSeatLimit: pricing.trialSeatLimit
				})
			})
		).status,
		403,
		'ADMIN must not change commercial policy'
	);
	if (args.has('--activate-owner')) {
		const activationId = randomUUID();
		const activation = await fetch(`${publicApi}/crm/access/trial`, {
			method: 'POST',
			headers: { ...ownerHeaders, 'Idempotency-Key': activationId },
			body: JSON.stringify({
				schemaVersion: 1,
				commandId: activationId,
				workspaceId: accounts.owner.workspaceId
			})
		});
		assert.equal(activation.status, 200);
		const installationId = randomUUID();
		const installation = await fetch(
			`${publicApi}/crm/access/onboarding/template`,
			{
				method: 'POST',
				headers: { ...ownerHeaders, 'Idempotency-Key': installationId },
				body: JSON.stringify({
					schemaVersion: 1,
					commandId: installationId,
					workspaceId: accounts.owner.workspaceId,
					templateKey: 'universal-sales',
					templateVersion: 1
				})
			}
		);
		assert.equal(installation.status, 200);
	}
	log(
		'Normal login, JWT Gateway, anonymous access and ADMIN read-only HTTP smoke passed'
	);
}

async function shutdown(exitCode = 0) {
	if (stopping) return;
	stopping = true;
	for (const { child, exited } of children.values()) {
		if (!exited && child.pid) {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				/* Already stopped. */
			}
		}
	}
	const deadline = Date.now() + 20000;
	while (
		[...children.values()].some(state => !state.exited) &&
		Date.now() < deadline
	)
		await new Promise(resolveStop => setTimeout(resolveStop, 100));
	for (const { child, exited } of children.values()) {
		if (!exited && child.pid) {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				/* Process group stopped. */
			}
		}
	}
	log(
		'Stopped owned child processes. Local test databases remain for shared cleanup.'
	);
	process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
	const nativeWidgetBroker = withNativeWidgetHttp
		? nativeWidgetHttpBrokerEnvironment()
		: null;
	await verifyLocalPostgres();
	const ports = [
		4100,
		...serviceDefinitions.map(service => service.port),
		...(args.has('--backend-only') ? [] : [3000, 3001])
	];
	for (const port of ports) await assertFreePort(port);
	for (const service of serviceDefinitions) await prepareDatabase(service);
	if (args.has('--verify-domain')) await verifyDomain();
	const accounts = await seedIdentity();
	let widgetsFixture = withWidgets
		? await seedWidgets(accounts.owner)
		: null;
	const common = environment();
	for (const service of serviceDefinitions) {
		start(
			service.app,
			process.execPath,
			[join(service.root, 'dist/src/main.js')],
			{
				...ownedEnvironment(service.app, common),
				[service.databaseVariable]: databaseUrl(
					service,
					service.runtimeRole
				)
			}
		);
		await waitForHttp(
			service.app,
			`http://127.0.0.1:${service.port}/health/ready`
		);
	}
	const gatewayRoot = join(servicesRoot, 'apps/api-gateway');
	await execute(
		process.execPath,
		[
			join(gatewayRoot, 'node_modules/typescript/bin/tsc'),
			'-p',
			join(gatewayRoot, 'tsconfig.json')
		],
		{ label: 'Gateway build' }
	);
	const routes = [
		['identity-auth', '/auth', 4900, 'optional'],
		['identity-users', '/users', 4900, 'required'],
		['identity-invitations', '/workspace-invitations', 4900, 'required'],
		[
			'billing-crm-customer-pricing',
			'/billing-settings/crm',
			4800,
			'required'
		],
		[
			'billing-crm-pricing',
			'/billing-settings/admin/crm',
			4800,
			'required'
		],
		['crm-access', '/crm/access', 5300, 'optional'],
		['crm-templates', '/crm/templates', 5330, 'optional'],
		['crm-customers', '/crm/customers', 5320, 'required'],
		['crm-sales', '/crm/sales', 5330, 'required'],
		['crm-source-ingest', '/crm/intake/ingest', 5310, 'crm-source'],
		['crm-intake', '/crm/intake', 5310, 'required']
	].map(([id, path, port, authPolicy]) => ({
		id,
		pathPrefix: `/api/v1${path}`,
		upstreamUrl: `http://127.0.0.1:${port}`,
		authPolicy,
		timeoutMs: 60000
	}));
	start(
		'api-gateway',
		process.execPath,
		[join(gatewayRoot, 'dist/src/main.js')],
		{
			GATEWAY_LISTEN_HOST: '127.0.0.1',
			GATEWAY_PORT: '4100',
			GATEWAY_ROUTES_JSON: JSON.stringify(routes),
			CORS_ALLOWED_ORIGINS: cors,
			JWT_JWKS_URL: jwksUrl,
			JWT_ISSUER: jwtIssuer,
			JWT_AUDIENCE: 'winwidget-api'
		}
	);
	await waitForHttp('api-gateway', 'http://127.0.0.1:4100/health/ready');
	await smoke(accounts);
	if (withWidgets)
		widgetsFixture = await verifyWidgetsControlHttp(
			accounts.owner,
			widgetsFixture,
			common
		);
	if (withNativeWidgetHttp) {
		const { verifyNativeWidgetHttp } =
			await import('./local-native-widget-http.integration.mjs');
		const widgets = byApp.widgets;
		const intake = byApp['crm-intake'];
		const evidence = await verifyNativeWidgetHttp({
			servicesRoot,
			runId,
			apiUrl: publicApi,
			widgetsApiUrl: 'http://127.0.0.1:4700/api/v1',
			account: accounts.owner,
			widget: widgetsFixture,
			widgetsDatabaseUrl: databaseUrl(widgets, widgets.runtimeRole),
			intakeDatabaseUrl: databaseUrl(intake, intake.runtimeRole),
			intakeEnvironment: ownedEnvironment('crm-intake', common),
			broker: nativeWidgetBroker,
			registerSecret: value => secrets.add(value),
			log
		});
		widgetsFixture = {
			...widgetsFixture,
			leadTransfersVerified: true,
			nativeLeadHttpBroker: evidence
		};
	}
	if (args.has('--verify-acceptance-http')) {
		const { verifyAcceptanceHttp } =
			await import('./local-acceptance-http.integration.mjs');
		const intake = byApp['crm-intake'];
		await verifyAcceptanceHttp({
			servicesRoot,
			apiUrl: publicApi,
			account: accounts.workflow,
			managerAccount: accounts.manager,
			prepareTeamFixtures: () =>
				seedTeamFixtures(accounts, accounts.workflow.workspaceId),
			intakeDatabaseUrl: databaseUrl(intake, intake.runtimeRole),
			environment: ownedEnvironment('crm-intake', common),
			registerSecret: value => secrets.add(value),
			log
		});
	} else if (args.has('--activate-owner')) {
		await seedTeamFixtures(accounts, accounts.owner.workspaceId);
	}
	if (!args.has('--backend-only')) {
		const frontendEnv = {
			NEXT_PUBLIC_MODE: 'development',
			NEXT_PUBLIC_API_URL: publicApi,
			NEXT_PUBLIC_PRODUCTION_HOST: '',
			NEXT_PUBLIC_WIDGETS_HOST: 'http://localhost:4700',
			NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
			NEXT_PUBLIC_RECAPTCHA_SITE_KEY: '',
			JWT_JWKS_URL: jwksUrl,
			JWT_ISSUER: jwtIssuer,
			JWT_AUDIENCE: 'winwidget-api',
			JWT_CLOCK_TOLERANCE_SECONDS: '0',
			JWT_MAX_TOKEN_LIFETIME_SECONDS: '900',
			NEXT_PUBLIC_MAIN_APP_URL: 'http://localhost:3000',
			NEXT_PUBLIC_APP_URL: 'http://localhost:3001'
		};
		await startFrontend('winwidget.ru_client', 3000, frontendEnv);
		await startFrontend('winwidget.ru_client_crm', 3001, frontendEnv);
	}
	await writeFile(
		fixturePath,
		`${JSON.stringify(
			{
				runId,
				harnessPid: process.pid,
				startedAt,
				ownedMarker: `wincrm-local-stack:${runId}`,
				mainUrl: 'http://localhost:3000',
				crmUrl: 'http://localhost:3001',
				apiUrl: publicApi,
				accounts,
				frontendSnapshots,
				activatedOwner: args.has('--activate-owner'),
				acceptanceHttpVerified: args.has('--verify-acceptance-http'),
				widgets: widgetsFixture,
				rabbitTransportVerified: false,
				databases: serviceDefinitions.map(
					({ app, database, migrationRole, runtimeRole }) => ({
						app,
						database,
						migrationRole,
						runtimeRole
					})
				),
				children: Object.fromEntries(
					[...children].map(([label, { child }]) => [label, child.pid])
				)
			},
			null,
			2
		)}\n`,
		{ mode: 0o600 }
	);
	ready = true;
	log(`READY fixture=${fixturePath}`);
	if (args.has('--smoke-and-stop')) await shutdown();
} catch (error) {
	console.error(
		scrub(error instanceof Error ? error.message : 'Local stack failed')
	);
	await shutdown(1);
}
