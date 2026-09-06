import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../..'
);
export const CRM_IMAGE_SERVICES = Object.freeze(
	[
		{
			app: 'crm-access',
			schema: 'crm_access',
			port: 55442,
			maxConnections: 32
		},
		{
			app: 'crm-intake',
			schema: 'crm_intake',
			port: 55443,
			maxConnections: 48
		},
		{
			app: 'crm-customers',
			schema: 'crm_customers',
			port: 55444,
			maxConnections: 16
		},
		{
			app: 'crm-sales',
			schema: 'crm_sales',
			port: 55445,
			maxConnections: 16
		}
	].map(Object.freeze)
);
export const CRM_IMAGE_PROCESSES = Object.freeze(
	[
		['crm-access', 'api', 5300, 5],
		['crm-access', 'worker', 5301, 4],
		['crm-access', 'outbox-publisher', 5302, 1],
		['crm-intake', 'api', 5310, 5],
		['crm-intake', 'worker', 5311, 4],
		['crm-intake', 'publisher', 5312, 1],
		['crm-intake', 'widget-control-worker', 5313, 4],
		['crm-intake', 'widget-control-publisher', 5314, 1],
		['crm-intake', 'widget-transfer-worker', 5315, 4],
		['crm-intake', 'widget-transfer-publisher', 5316, 1],
		['crm-customers', 'api', 5320, 5],
		['crm-sales', 'api', 5330, 5]
	].map(([app, role, port, connections]) =>
		Object.freeze({ app, role, port, connections })
	)
);

const mutableTables = {
	'crm-access': [
		'crm_workspace_access',
		'crm_workspace_members',
		'crm_teams',
		'crm_invitation_intents',
		'crm_admissions',
		'crm_team_outbox',
		'crm_team_deliveries',
		'crm_billing_capacity',
		'crm_billing_operations'
	],
	'crm-intake': [
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
	'crm-customers': ['contacts', 'companies'],
	'crm-sales': ['deals', 'tasks']
};
const appendOnlyTables = {
	'crm-access': ['crm_team_command_receipts', 'crm_team_audit'],
	'crm-intake': [
		'intake_commands',
		'intake_activities',
		'inbound_receipts',
		'csv_imports',
		'csv_import_rows',
		'export_audit',
		'widget_entry_snapshots'
	],
	'crm-customers': [
		'customer_commands',
		'customer_activities',
		'intake_operation_slots',
		'intake_operation_commands',
		'export_audit'
	],
	'crm-sales': [
		'deal_timeline',
		'command_receipts',
		'pipeline_template_installations',
		'pipeline_template_installation_commands',
		'intake_operation_slots',
		'intake_operation_commands',
		'export_audit'
	]
};

export function runtimeGrants(app) {
	const service = CRM_IMAGE_SERVICES.find(item => item.app === app);
	assert.ok(service, 'Unknown CRM service');
	const schema = service.schema;
	const grant = (rights, tables) =>
		`GRANT ${rights} ON ${tables.map(table => `${schema}.${table}`).join(', ')} TO image_runtime;`;
	return [
		`GRANT USAGE ON SCHEMA ${schema} TO image_runtime;`,
		grant('SELECT', ['service_identity']),
		grant('SELECT, INSERT, UPDATE', mutableTables[app]),
		grant('SELECT, INSERT', appendOnlyTables[app]),
		...(app === 'crm-access'
			? [
					grant('SELECT, INSERT, DELETE', ['crm_member_teams']),
					`GRANT USAGE, SELECT ON SEQUENCE crm_access.crm_admissions_position_seq TO image_runtime;`
				]
			: []),
		...(app === 'crm-intake'
			? [
					grant('SELECT, INSERT, UPDATE, DELETE', [
						'ingestion_rate_buckets'
					])
				]
			: []),
		...(app === 'crm-sales'
			? [
					grant('SELECT, INSERT, UPDATE, DELETE', [
						'pipelines',
						'pipeline_stages'
					])
				]
			: []),
		`REVOKE ALL ON ${schema}._prisma_migrations FROM image_runtime;`
	].join('\n');
}

export function serviceTokens(app, tokens) {
	const names = {
		'crm-access': [
			'IDENTITY_CRM_ACCESS_TOKEN',
			'BILLING_CRM_ACCESS_TOKEN',
			'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
			'CRM_SALES_CRM_ACCESS_TOKEN',
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
			'CRM_ACCESS_CRM_SALES_TOKEN',
			'CRM_ACCESS_CRM_INTAKE_TOKEN'
		],
		'crm-intake': [
			'CRM_ACCESS_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
			'CRM_SALES_CRM_INTAKE_TOKEN',
			'WIDGETS_CRM_INTAKE_TOKEN'
		],
		'crm-customers': [
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
			'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_SALES_TOKEN'
		],
		'crm-sales': [
			'CRM_ACCESS_CRM_SALES_TOKEN',
			'CRM_SALES_CRM_ACCESS_TOKEN',
			'CRM_SALES_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_SALES_TOKEN'
		]
	}[app];
	assert.ok(names, 'Unknown CRM service');
	for (const name of names) assert.match(tokens[name], /^[a-f0-9]{48}$/);
	return Object.fromEntries(names.map(name => [name, tokens[name]]));
}

export function databaseUrl(
	app,
	port,
	password,
	pool = 1,
	role = 'image_runtime'
) {
	const service = CRM_IMAGE_SERVICES.find(item => item.app === app);
	assert.ok(
		service && service.port === port,
		'Unexpected database endpoint'
	);
	assert.ok(['image_runtime', 'image_migration'].includes(role));
	assert.ok(Number.isInteger(pool) && pool >= 1 && pool <= 5);
	assert.match(password, /^[a-f0-9]{48}$/);
	return `postgresql://${role}:${password}@127.0.0.1:${port}/wincrm_image_test?schema=${service.schema}&sslmode=disable&connection_limit=${pool}&pool_timeout=10`;
}

export function assertOwnedContainer(item, id, label) {
	assert.equal(item.Id, id);
	assert.equal(item.Config.Labels['winwidget.test'], label);
	assert.ok(
		item.Name.startsWith(
			`/wincrm-image-${label.slice('crm-image-'.length)}-`
		)
	);
	assert.equal(
		item.State.OOMKilled,
		false,
		'Owned container was OOM killed'
	);
}

export function assertQuietQueues(rows, requireConsumers) {
	const main = [
		...['provision', 'acceptance', 'admission'].map(
			name => `winwidget.crm-access.team.${name}`
		),
		'winwidget.crm-intake.acceptance.v1',
		'winwidget.crm-intake.widget-control.v1',
		'winwidget.crm-intake.widget-transfer.v1'
	];
	const expected = main.flatMap(name => [
		name,
		`${name}.dead-letter`,
		...(name.includes('crm-access')
			? [1, 2, 3].map(index => `${name}.retry.${index}`)
			: [])
	]);
	assert.deepEqual(rows.map(row => row.name).sort(), expected.sort());
	for (const row of rows) {
		assert.equal(
			row.messages_ready,
			0,
			'Unexpected durable work; preserve resources'
		);
		assert.equal(
			row.messages_unacknowledged,
			0,
			'Unacknowledged work; preserve resources'
		);
		assert.equal(
			row.consumers,
			requireConsumers && main.includes(row.name) ? 1 : 0
		);
	}
}

async function run() {
	assert.equal(process.env.WINCRM_IMAGE_REHEARSAL_ALLOW_MUTATION, 'true');
	assert.deepEqual(process.argv.slice(2), ['--run']);
	assert.ok(
		!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
		'Remote overrides forbidden'
	);
	const runId = randomBytes(5).toString('hex');
	const label = `crm-image-${runId}`;
	const name = suffix => `wincrm-image-${runId}-${suffix}`;
	const environment = {
		PATH: process.env.PATH,
		HOME: homedir(),
		LANG: 'en_US.UTF-8'
	};
	const state = await mkdtemp(join(tmpdir(), 'wincrm-image-rehearsal-'));
	await chmod(state, 0o700);
	const containers = [];
	const volumes = [];
	const images = {};
	let stage = 'preflight';
	const say = value => console.log(`[crm-image] ${value}`);
	async function command(
		binary,
		args,
		{ input, env = {}, timeout = 60_000 } = {}
	) {
		return new Promise((resolve, reject) => {
			const child = spawn(binary, args, {
				cwd: root,
				env: { ...environment, ...env },
				stdio: ['pipe', 'pipe', 'pipe']
			});
			let output = '',
				diagnosticBytes = 0;
			const deadline = setTimeout(() => {
				child.kill('SIGTERM');
			}, timeout);
			child.stdout.on('data', bytes => {
				output = (output + bytes).slice(-2 * 1024 * 1024);
			});
			child.stderr.on('data', bytes => {
				diagnosticBytes += bytes.length;
			});
			child.once('error', () => {
				clearTimeout(deadline);
				reject(new Error('Local command startup failed'));
			});
			child.once('close', code => {
				clearTimeout(deadline);
				resolve({ code, output: output.trim(), diagnosticBytes });
			});
			child.stdin.on('error', () => {});
			child.stdin.end(input);
		});
	}
	const result = (args, options) =>
		command('docker', ['--context', 'colima', ...args], options);
	const docker = async (args, options) => {
		const reply = await result(args, options);
		assert.equal(
			reply.code,
			0,
			`Local Docker failed during ${stage}; diagnostics suppressed`
		);
		return reply.output;
	};
	const inspect = async id => JSON.parse(await docker(['inspect', id]))[0];
	const record = async () =>
		writeFile(
			join(state, 'ownership.json'),
			JSON.stringify(
				{ runId, label, containers, volumes, images, stage },
				null,
				2
			),
			{ mode: 0o600 }
		);
	const sql = (
		id,
		query,
		database = 'wincrm_image_test',
		role = 'image_bootstrap'
	) =>
		docker(
			[
				'exec',
				'-i',
				id,
				'psql',
				'-XAtq',
				'-v',
				'ON_ERROR_STOP=1',
				'-U',
				role,
				'-d',
				database
			],
			{ input: query }
		);
	const wait = async (predicate, seconds, description) => {
		const deadline = Date.now() + seconds * 1000;
		do {
			if (await predicate()) return;
			await new Promise(resolve => setTimeout(resolve, 1000));
		} while (Date.now() < deadline);
		throw new Error(description);
	};
	const ownRun = async (suffix, args, env = {}) => {
		const id = await docker(
			[
				'run',
				'-d',
				'--pull=never',
				'--name',
				name(suffix),
				'--label',
				`winwidget.test=${label}`,
				...args
			],
			{ env }
		);
		assert.match(id, /^[a-f0-9]{64}$/);
		containers.push(id);
		await record();
		assertOwnedContainer(await inspect(id), id, label);
		return id;
	};
	const stop = async id => {
		const item = await inspect(id);
		assertOwnedContainer(item, id, label);
		await docker(['update', '--restart=no', id]);
		if (item.State.Running) await docker(['kill', '--signal=TERM', id]);
		await wait(
			async () => !(await inspect(id)).State.Running,
			40,
			'Owned process did not stop gracefully'
		);
	};
	try {
		assert.equal(
			(await command('docker', ['context', 'show'])).output,
			'colima'
		);
		assert.equal(
			await docker([
				'context',
				'inspect',
				'colima',
				'--format',
				'{{.Endpoints.docker.Host}}'
			]),
			`unix://${homedir()}/.colima/default/docker.sock`
		);
		assert.equal(
			await docker(['info', '--format', '{{.Name}}']),
			'colima'
		);
		assert.equal(
			await docker(['ps', '-aq']),
			'',
			'Run only on an otherwise empty local Docker context'
		);
		const revision = (await command('git', ['rev-parse', 'HEAD'])).output;
		assert.match(revision, /^[a-f0-9]{40}$/);
		stage = 'immutable-image-builds';
		for (const service of CRM_IMAGE_SERVICES) {
			say(`Building immutable ${service.app} ${revision.slice(0, 8)}`);
			// Git archive prevents ignored env, local builds and uncommitted source from entering the image.
			const archive = spawn(
				'git',
				['archive', '--format=tar', `${revision}:apps/${service.app}`],
				{ cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }
			);
			const build = spawn(
				'docker',
				[
					'--context',
					'colima',
					'build',
					'--build-arg',
					`APP_REVISION=${revision}`,
					'-t',
					`winwidget-${service.app}:rehearsal-${revision}`,
					'-'
				],
				{
					cwd: root,
					env: environment,
					stdio: ['pipe', 'ignore', 'ignore']
				}
			);
			archive.stderr.resume();
			archive.stdout.pipe(build.stdin);
			build.stdin.on('error', () => {});
			const deadline = setTimeout(() => {
				archive.kill('SIGTERM');
				build.kill('SIGTERM');
			}, 25 * 60_000);
			const statuses = await Promise.all(
				[archive, build].map(
					child =>
						new Promise((resolve, reject) => {
							child.once('error', reject);
							child.once('close', resolve);
						})
				)
			);
			clearTimeout(deadline);
			assert.deepEqual(
				statuses,
				[0, 0],
				'Immutable image build failed; no runtime started'
			);
			const image = JSON.parse(
				await docker([
					'image',
					'inspect',
					`winwidget-${service.app}:rehearsal-${revision}`
				])
			)[0];
			assert.equal(
				image.Config.Labels['org.opencontainers.image.revision'],
				revision
			);
			assert.ok(
				['node', 'crmaccess', '1000', '1001'].includes(image.Config.User)
			);
			images[service.app] = image.Id;
			await record();
			say(`Built ${service.app}`);
		}
		stage = 'isolated-data-services';
		for (const tag of [
			'postgres:18-alpine',
			'rabbitmq:4.2.9-management-alpine@sha256:0ab90fc05c41e9d2d8f11af5036e466c364adf5085ed83c477ab41aec0bdde86'
		]) {
			await docker(['pull', tag], { timeout: 180_000 });
			images[tag.startsWith('postgres') ? 'postgres' : 'rabbitmq'] =
				JSON.parse(await docker(['image', 'inspect', tag]))[0].Id;
		}
		const databases = [];
		for (const service of CRM_IMAGE_SERVICES) {
			const volume = name(`${service.app}-data`);
			await docker([
				'volume',
				'create',
				'--label',
				`winwidget.test=${label}`,
				volume
			]);
			volumes.push(volume);
			await record();
			const password = randomBytes(24).toString('hex');
			const migrationPassword = randomBytes(24).toString('hex');
			const runtimePassword = randomBytes(24).toString('hex');
			const id = await ownRun(
				`${service.app}-postgres`,
				[
					'--memory=256m',
					'--memory-swap=256m',
					'--cpus=1',
					'-p',
					`127.0.0.1:${service.port}:5432`,
					'-v',
					`${volume}:/var/lib/postgresql`,
					'-e',
					'POSTGRES_USER=image_bootstrap',
					'-e',
					'POSTGRES_PASSWORD',
					'-e',
					'POSTGRES_DB=wincrm_image_test',
					images.postgres,
					'-c',
					`max_connections=${service.maxConnections}`,
					'-c',
					'shared_buffers=32MB'
				],
				{ POSTGRES_PASSWORD: password }
			);
			await wait(
				async () =>
					(
						await result([
							'exec',
							id,
							'pg_isready',
							'-U',
							'image_bootstrap',
							'-d',
							'wincrm_image_test'
						])
					).code === 0,
				60,
				'Local PostgreSQL readiness deadline'
			);
			assert.equal(
				await sql(
					id,
					"SELECT current_setting('server_version_num')::int BETWEEN 180000 AND 189999;"
				),
				't'
			);
			await sql(
				id,
				`CREATE ROLE image_migration LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; CREATE ROLE image_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; REVOKE ALL ON DATABASE wincrm_image_test FROM PUBLIC; GRANT CONNECT ON DATABASE wincrm_image_test TO image_migration, image_runtime; REVOKE ALL ON SCHEMA public FROM PUBLIC; CREATE SCHEMA ${service.schema} AUTHORIZATION image_migration; CREATE SCHEMA foreign_service_guard AUTHORIZATION image_bootstrap; CREATE TABLE foreign_service_guard.sentinel(id integer PRIMARY KEY); REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC;`
			);
			const variable = `${service.schema.toUpperCase()}_DATABASE_URL`;
			const migration = await ownRun(
				`${service.app}-migration`,
				[
					'--network=host',
					'--memory=384m',
					'--memory-swap=384m',
					'-e',
					variable,
					images[service.app],
					'node',
					'node_modules/prisma/build/index.js',
					'migrate',
					'deploy',
					'--schema',
					'prisma/schema.prisma'
				],
				{
					[variable]: databaseUrl(
						service.app,
						service.port,
						migrationPassword,
						1,
						'image_migration'
					)
				}
			);
			await wait(
				async () => !(await inspect(migration)).State.Running,
				90,
				'Image migration deadline'
			);
			assert.equal(
				(await inspect(migration)).State.ExitCode,
				0,
				'Image-owned migration failed'
			);
			await sql(id, runtimeGrants(service.app));
			assert.equal(
				await sql(
					id,
					`SELECT NOT has_schema_privilege(current_user,'${service.schema}','CREATE') AND NOT has_table_privilege(current_user,'${service.schema}._prisma_migrations','SELECT') AND NOT has_schema_privilege(current_user,'foreign_service_guard','USAGE') AND NOT has_database_privilege(current_user,current_database(),'CREATE');`,
					'wincrm_image_test',
					'image_runtime'
				),
				't'
			);
			databases.push({ ...service, id, password: runtimePassword });
			say(
				`${service.app}: separate PostgreSQL 18, image migrations, restricted runtime verified`
			);
		}
		const evidence = await runRuntime({
			runId,
			label,
			state,
			revision,
			images,
			databases,
			docker,
			result,
			ownRun,
			inspect,
			stop,
			sql,
			wait,
			say,
			setStage: value => {
				stage = value;
			}
		});
		stage = 'owned-cleanup';
		for (const id of [...containers].reverse()) {
			await stop(id);
			await docker(['rm', '-v', id]);
		}
		for (const volume of volumes) {
			const item = JSON.parse(
				await docker(['volume', 'inspect', volume])
			)[0];
			assert.equal(item.Labels['winwidget.test'], label);
			await docker(['volume', 'rm', volume]);
		}
		stage = 'complete';
		await record();
		await writeFile(
			join(state, 'result.pending.json'),
			JSON.stringify({ ...evidence, ownedCleanupVerified: true }, null, 2),
			{ mode: 0o600 }
		);
		await rename(
			join(state, 'result.pending.json'),
			join(state, 'result.json')
		);
		say(
			`PASS: owned containers/volumes removed; root must clean local images/cache and stop Colima. Evidence ${state}`
		);
	} catch (error) {
		await record();
		say(
			`FAILED stage=${stage}; owned resources preserved for diagnosis; no production touched. Evidence ${state}`
		);
		throw new Error(
			`CRM image rehearsal failed: ${error instanceof assert.AssertionError ? 'assertion' : 'runtime'}`
		);
	}
}

async function runRuntime(context) {
	const {
		runId,
		revision,
		images,
		databases,
		docker,
		ownRun,
		inspect,
		stop,
		sql,
		wait,
		say,
		setStage
	} = context;
	setStage('scoped-rabbit-topology');
	const vhost = `wincrm_image_${runId}_test`;
	const brokerPassword = randomBytes(24).toString('hex');
	const broker = await ownRun(
		'rabbitmq',
		[
			'--memory=512m',
			'--memory-swap=512m',
			'--cpus=1',
			'-p',
			'127.0.0.1:5675:5672',
			'-e',
			'RABBITMQ_DEFAULT_USER=image_provisioner',
			'-e',
			'RABBITMQ_DEFAULT_PASS',
			'-e',
			'RABBITMQ_DEFAULT_VHOST',
			'-e',
			'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2',
			images.rabbitmq
		],
		{
			RABBITMQ_DEFAULT_PASS: brokerPassword,
			RABBITMQ_DEFAULT_VHOST: vhost
		}
	);
	const brokerReady = async () =>
		(
			await context.result([
				'exec',
				'--user=rabbitmq',
				broker,
				'rabbitmq-diagnostics',
				'-q',
				'check_port_connectivity'
			])
		).code === 0;
	await wait(brokerReady, 60, 'Local RabbitMQ readiness deadline');
	const ctl = args =>
		docker(['exec', '--user=rabbitmq', broker, 'rabbitmqctl', ...args]);
	const amqp = createRequire(join(root, 'apps/crm-access/package.json'))(
		'amqplib'
	);
	const provisioner = await amqp.connect(
		`amqp://image_provisioner:${brokerPassword}@127.0.0.1:5675/${vhost}`,
		{ timeout: 10_000 }
	);
	try {
		const channel = await provisioner.createChannel();
		await channel.assertExchange('winwidget.events', 'topic', {
			durable: true
		});
		for (const [prefix, queue, event] of [
			[
				'winwidget.crm-intake',
				'winwidget.crm-intake.acceptance.v1',
				'crm.intake.acceptance.requested.v1'
			],
			[
				'winwidget.crm-intake.widget-control',
				'winwidget.crm-intake.widget-control.v1',
				'crm.intake.widget-control.requested.v1'
			],
			[
				'winwidget.crm-intake.widget-transfer',
				'winwidget.crm-intake.widget-transfer.v1',
				'widgets.wincrm.lead-transfer.requested.v1'
			]
		]) {
			for (const suffix of ['events', 'dead-letter'])
				await channel.assertExchange(`${prefix}.${suffix}`, 'direct', {
					durable: true
				});
			await channel.assertQueue(queue, { durable: true });
			await channel.bindQueue(queue, `${prefix}.events`, event);
			await channel.assertQueue(`${queue}.dead-letter`, { durable: true });
			await channel.bindQueue(
				`${queue}.dead-letter`,
				`${prefix}.dead-letter`,
				event
			);
			if (prefix.endsWith('widget-transfer'))
				await channel.bindQueue(queue, 'winwidget.events', event);
		}
		await channel.close();
	} finally {
		await provisioner.close();
	}
	const brokerPrincipals = new Map();
	for (const process of CRM_IMAGE_PROCESSES.filter(
		item => item.role !== 'api'
	)) {
		const key = `${process.app}-${process.role}`;
		const user = `${key.replaceAll('-', '_')}_${runId}`;
		const password = randomBytes(24).toString('hex');
		await ctl(['add_user', user, password]);
		if (process.app === 'crm-access') {
			const resources =
				'^(winwidget\\.(events|retry|dead-letter|manual-retry)|winwidget\\.crm-access\\.team\\.(provision|acceptance|admission)(\\.dead-letter|\\.retry\\.[123])?)$';
			const worker = process.role === 'worker';
			const writes = worker
				? '^(winwidget\\.manual-retry|winwidget\\.crm-access\\.team\\.(provision|acceptance|admission)(\\.dead-letter|\\.retry\\.[123])?)$'
				: '^winwidget\\.(events|retry|dead-letter|manual-retry)$';
			await ctl([
				'set_permissions',
				'-p',
				vhost,
				user,
				worker ? resources : '^$',
				writes,
				worker ? resources : '^$'
			]);
			const accessEvents =
				'^crm\\.access\\.(invitation-provision|admission-wake)\\.v1$';
			const allEvents =
				'^(crm\\.access\\.(invitation-provision|admission-wake)\\.v1|identity\\.wincrm\\.invitation-accepted\\.v1)$';
			const routes =
				'^crm-access\\.team\\.(provision|acceptance|admission)(\\.dead-letter|\\.retry\\.[123])?$';
			await ctl([
				'set_topic_permissions',
				'-p',
				vhost,
				user,
				'winwidget.events',
				worker ? '^$' : accessEvents,
				worker ? allEvents : '^$'
			]);
			await ctl([
				'set_topic_permissions',
				'-p',
				vhost,
				user,
				'winwidget.dead-letter',
				worker ? '^$' : routes,
				worker ? routes : '^$'
			]);
		} else {
			const kind = process.role.startsWith('widget-control')
				? 'widget-control'
				: process.role.startsWith('widget-transfer')
					? 'widget-transfer'
					: 'acceptance';
			const queue =
				kind === 'acceptance'
					? 'winwidget.crm-intake.acceptance.v1'
					: `winwidget.crm-intake.${kind}.v1`;
			const prefix =
				kind === 'acceptance'
					? 'winwidget.crm-intake'
					: `winwidget.crm-intake.${kind}`;
			const worker = process.role.endsWith('worker');
			await ctl([
				'set_permissions',
				'-p',
				vhost,
				user,
				'^$',
				worker
					? '^$'
					: `^${prefix.replaceAll('.', '\\.')}\\.(events|dead-letter)$`,
				worker ? `^${queue.replaceAll('.', '\\.')}$` : '^$'
			]);
		}
		brokerPrincipals.set(
			key,
			`amqp://${user}:${password}@127.0.0.1:5675/${vhost}`
		);
	}
	// No public identities, customer content or domain commands are seeded here.
	// Only owned health endpoints and empty outboxes are exercised by this stage.
	const tokens = Object.fromEntries(
		[
			'IDENTITY_CRM_ACCESS_TOKEN',
			'BILLING_CRM_ACCESS_TOKEN',
			'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
			'CRM_SALES_CRM_ACCESS_TOKEN',
			'CRM_ACCESS_CRM_CUSTOMERS_TOKEN',
			'CRM_ACCESS_CRM_SALES_TOKEN',
			'CRM_ACCESS_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_INTAKE_TOKEN',
			'CRM_SALES_CRM_INTAKE_TOKEN',
			'CRM_CUSTOMERS_CRM_SALES_TOKEN',
			'WIDGETS_CRM_INTAKE_TOKEN'
		].map(key => [key, randomBytes(24).toString('hex')])
	);
	await stop(broker);
	setStage('late-broker-cold-start');
	say(
		'RabbitMQ intentionally stopped; starting twelve real entrypoints with isolated databases'
	);
	const runtime = [];
	for (const process of CRM_IMAGE_PROCESSES) {
		const database = databases.find(item => item.app === process.app);
		const prefix = database.schema.toUpperCase();
		const key = `${process.app}-${process.role}`;
		const env = {
			NODE_ENV: 'production',
			MODE: 'production',
			APP_REVISION: revision,
			[`${prefix}_DATABASE_URL`]: databaseUrl(
				process.app,
				database.port,
				database.password,
				process.connections
			),
			[`${prefix}_PROCESS_ROLE`]: process.role,
			[`${prefix}_LISTEN_HOST`]: '127.0.0.1',
			[`${prefix}_PORT`]: String(process.port),
			CORS_ALLOWED_ORIGINS: 'https://crm.winwidget.ru',
			TRUST_PROXY: 'loopback',
			IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
			BILLING_INTERNAL_BASE_URL: 'http://127.0.0.1:4800',
			CRM_ACCESS_INTERNAL_BASE_URL: 'http://127.0.0.1:5300',
			CRM_CUSTOMERS_INTERNAL_BASE_URL: 'http://127.0.0.1:5320',
			CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330',
			WIDGETS_INTERNAL_BASE_URL: 'http://127.0.0.1:4700',
			CRM_ACCESS_BILLING_ENABLED: 'true',
			CRM_INTAKE_WIDGETS_ENABLED: 'true',
			CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'true',
			CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'false',
			...serviceTokens(process.app, tokens),
			...(process.role !== 'api'
				? process.app === 'crm-access'
					? {
							RABBITMQ_URL: brokerPrincipals.get(key),
							RABBITMQ_CONNECTION_NAME: `winwidget-crm-access-${process.role}`
						}
					: { CRM_INTAKE_RABBITMQ_URL: brokerPrincipals.get(key) }
				: {})
		};
		const health = `node -e "fetch('http://127.0.0.1:${process.port}/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"`;
		const id = await ownRun(
			key,
			[
				'--network=host',
				'--restart=on-failure:5',
				'--memory=384m',
				'--memory-swap=384m',
				'--cpus=1',
				'--pids-limit=128',
				'--read-only',
				'--tmpfs',
				'/tmp:rw,nosuid,nodev,size=64m',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--health-cmd',
				health,
				'--health-interval=2s',
				'--health-timeout=3s',
				'--health-retries=30',
				...Object.keys(env).flatMap(key => ['-e', key]),
				images[process.app]
			],
			env
		);
		runtime.push({ ...process, id });
	}
	await wait(
		async () => {
			const states = await Promise.all(
				runtime
					.filter(item => item.role !== 'api')
					.map(item => inspect(item.id))
			);
			return states.every(
				item => item.RestartCount >= 1 && !item.State.OOMKilled
			);
		},
		65,
		'A background process remained alive after bootstrap failure or hit OOM'
	);
	for (const process of runtime.filter(item => item.role === 'api'))
		assert.equal((await inspect(process.id)).RestartCount, 0);
	say(
		'All eight background processes exited on unavailable broker and restarted; four APIs stayed alive'
	);
	await docker(['start', broker]);
	await wait(brokerReady, 60, 'RabbitMQ restart deadline');
	setStage('all-role-readiness');
	await wait(
		async () => {
			const states = await Promise.all(
				runtime.map(item => inspect(item.id))
			);
			return states.every(
				item =>
					item.State.Running &&
					!item.State.OOMKilled &&
					item.State.Health?.Status === 'healthy'
			);
		},
		100,
		'CRM role readiness deadline'
	);
	const queues = async () =>
		JSON.parse(
			await ctl([
				'list_queues',
				'-p',
				vhost,
				'name',
				'messages_ready',
				'messages_unacknowledged',
				'consumers',
				'--formatter=json'
			])
		);
	assertQuietQueues(await queues(), true);
	setStage('running-broker-outage');
	const restartsBeforeOutage = new Map(
		await Promise.all(
			runtime.map(async process => [
				process.id,
				(await inspect(process.id)).RestartCount
			])
		)
	);
	await stop(broker);
	const readinessCode = async process => {
		const reply = await context.result([
			'exec',
			process.id,
			'node',
			'-e',
			`fetch('http://127.0.0.1:${process.port}/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.stdout.write(String(r.status))).catch(()=>process.exit(1))`
		]);
		return reply.code === 0 ? Number(reply.output) : 0;
	};
	await wait(
		async () => {
			const codes = await Promise.all(runtime.map(readinessCode));
			return runtime.every(
				(process, index) =>
					codes[index] === (process.role === 'api' ? 200 : 503)
			);
		},
		30,
		'Running broker outage did not fail readiness closed'
	);
	await docker(['start', broker]);
	await wait(brokerReady, 60, 'Running RabbitMQ recovery deadline');
	await wait(
		async () =>
			(await Promise.all(runtime.map(readinessCode))).every(
				code => code === 200
			),
		60,
		'Running CRM roles did not recover readiness'
	);
	await wait(
		async () => {
			try {
				assertQuietQueues(await queues(), true);
				return true;
			} catch {
				return false;
			}
		},
		30,
		'Push consumers did not recover after running broker outage'
	);
	for (const process of runtime) {
		const item = await inspect(process.id);
		assertOwnedContainer(item, process.id, context.label);
		assert.equal(
			item.RestartCount,
			restartsBeforeOutage.get(process.id),
			'Running broker reconnect unexpectedly restarted a process'
		);
	}
	say(
		'Running broker outage: eight readiness endpoints failed closed, all roles and six push consumers recovered without process restarts'
	);
	const evidence = [];
	for (const process of runtime) {
		const item = await inspect(process.id);
		assert.equal(item.Image, images[process.app]);
		assert.equal(
			item.Config.Labels['org.opencontainers.image.revision'],
			revision
		);
		evidence.push({
			app: process.app,
			role: process.role,
			image: item.Image,
			port: process.port,
			restartCount: item.RestartCount,
			healthy: item.State.Health.Status === 'healthy',
			poolLimit: process.connections
		});
	}
	const databaseEvidence = [];
	for (const database of databases) {
		const connections = Number(
			await sql(
				database.id,
				"SELECT count(*) FROM pg_stat_activity WHERE usename='image_runtime';"
			)
		);
		const poolCeiling = runtime
			.filter(item => item.app === database.app)
			.reduce((sum, item) => sum + item.connections, 0);
		assert.ok(connections > 0 && connections <= poolCeiling);
		const databaseId = await sql(
			database.id,
			`SELECT database_id FROM ${database.schema}.service_identity WHERE id='singleton';`
		);
		assert.match(databaseId, /^[a-f0-9-]{36}$/);
		databaseEvidence.push({
			app: database.app,
			databaseId,
			connections,
			poolCeiling
		});
	}
	assert.equal(
		new Set(databaseEvidence.map(item => item.databaseId)).size,
		4
	);
	const statistics = (
		await docker([
			'stats',
			'--no-stream',
			'--format',
			'{{json .}}',
			...runtime.map(item => item.id),
			...databases.map(item => item.id),
			broker
		])
	)
		.split('\n')
		.map(row => JSON.parse(row));
	const report = {
		schemaVersion: 2,
		revision,
		createdAt: new Date().toISOString(),
		claim: 'isolated-image-runtime-recovery-only',
		productionCapacityProven: false,
		businessWorkflowsProven: false,
		coldStartRecoveryVerified: true,
		runningBrokerRecoveryVerified: true,
		processes: evidence,
		databases: databaseEvidence,
		idleStatistics: statistics
	};
	say(
		'Twelve image entrypoints healthy; 21 empty queues, six push consumers and four database identities verified'
	);
	setStage('graceful-role-shutdown');
	for (const process of [...runtime].reverse()) {
		await stop(process.id);
		assert.equal(
			(await inspect(process.id)).State.ExitCode,
			0,
			'Graceful CRM shutdown must exit successfully'
		);
	}
	assertQuietQueues(await queues(), false);
	say(
		'Graceful shutdown verified with no queued or unacknowledged messages; load/capacity gate remains open'
	);
	return { ...report, gracefulShutdownVerified: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	await run().catch(() => {
		process.exitCode = 1;
	});
}
