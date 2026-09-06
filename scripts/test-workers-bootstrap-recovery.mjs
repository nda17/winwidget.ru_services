import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Node 20 service images, own internal Docker network, own PG18 and Rabbit.
// No production env is read, no port is published, external providers cannot be
// reached from the internal network. This proves cold-start recovery, not every
// previously documented crash-after-external-effect or busy-lease boundary.
assert.equal(
	process.env.WORKER_BOOTSTRAP_PROOF_ALLOW_LOCAL_DOCKER,
	'true'
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomBytes(5).toString('hex');
const prefix = `winwidget-bootstrap-proof-${runId}`;
const revision = 'b'.repeat(40);
const label = `winwidget.bootstrap-proof=${runId}`;
const network = `${prefix}-network`;
const postgres = `${prefix}-postgres`;
const rabbit = `${prefix}-rabbit`;
const utility = `${prefix}-utility`;
const brokerUser = `fixture_admin_${runId}`;
const brokerPassword = randomBytes(32).toString('hex');
const ownedContainers = [];
let ownedNetwork = false;
let utilityReady = false;
const services = ['billing', 'operations', 'support'];
const roles = [
	['billing', 'worker', 4802],
	['billing', 'outbox-publisher', 4803],
	['operations', 'worker', 5201],
	['operations', 'outbox-publisher', 5202],
	['operations', 'restore-worker', 5203],
	['support', 'worker', 5101],
	['support', 'outbox-publisher', 5102]
].map(([service, role, port]) => ({
	service,
	role,
	port,
	name: `${prefix}-${service}-${role}`,
	username: `fixture_${service}_${role.replaceAll('-', '_')}`,
	password: randomBytes(32).toString('hex')
}));
const databases = Object.fromEntries(
	services.map(service => [
		service,
		{
			name: `worker_bootstrap_${service}_${runId}`,
			migration: `worker_bootstrap_${service}_${runId}_migration`,
			runtime: `worker_bootstrap_${service}_${runId}_runtime`
		}
	])
);
const images = {};
const operationsFixturePrelude = `
const fs = require('node:fs');
fs.mkdirSync('/tmp/bootstrap-staging', { recursive: true, mode: 0o700 });
fs.mkdirSync('/tmp/bootstrap-sealed', { recursive: true, mode: 0o700 });
if (process.env.OPERATIONS_PROCESS_ROLE === 'worker') {
  const file = '/tmp/bootstrap-provenance-private.pem';
  if (!fs.existsSync(file)) {
    const pair = require('node:crypto').generateKeyPairSync('ed25519');
    fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o400 });
    fs.writeFileSync('/app/restore-manifests/database-backup-provenance-public-keys.json', JSON.stringify({
      schemaVersion: 1, domain: 'winwidget.operations.database-backup-provenance.v1',
      keys: [{ keyId: 'bootstrap-proof', publicKeySpkiDerBase64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }]
    }));
  }
  process.env.DATABASE_BACKUP_PROVENANCE_KEY_ID = 'bootstrap-proof';
  process.env.DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE = file;
}
require('/app/dist/src/main.js');
`;
const log = message => console.log(`[worker-bootstrap-proof] ${message}`);
const delay = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

async function command(
	command,
	args,
	{ input, timeout = 120_000, allowFailure = false } = {}
) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let output = '',
			errors = '';
		const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
		child.stdout.on('data', value => {
			output += value;
		});
		child.stderr.on('data', value => {
			errors += value;
		});
		child.once('error', () => {
			clearTimeout(timer);
			reject(
				new Error('Local command failed to start; arguments suppressed')
			);
		});
		child.once('close', code => {
			clearTimeout(timer);
			if (code !== 0 && !allowFailure) {
				if (args.includes('rabbitmqctl')) {
					let safe = output + errors;
					for (const secret of [
						brokerPassword,
						...roles.map(target => target.password)
					])
						safe = safe.replaceAll(secret, '[redacted]');
					log(
						`Broker CLI diagnostic: ${safe.replace(/(?:amqp|https?):\/\/\S+/g, '[redacted-url]').slice(-2500)}`
					);
				}
				// CLI errors can contain fixture credentials. Never echo full command,
				// stdout or stderr. Show only stable coarse diagnostic categories.
				const category = /permission denied/i.test(errors)
					? 'permission'
					: /already exists/i.test(errors)
						? 'exists'
						: /not found/i.test(errors)
							? 'missing'
							: 'other';
				reject(
					new Error(
						`Local ${command} failed exit=${code} category=${category}`
					)
				);
			} else resolve({ code, output: output.trim(), errors });
		});
		child.stdin.end(input);
	});
}
const docker = (args, options) => command('docker', args, options);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = async (database, statement) =>
	(
		await docker(
			[
				'exec',
				'-i',
				postgres,
				'psql',
				'-X',
				'-A',
				'-t',
				'-v',
				'ON_ERROR_STOP=1',
				'-U',
				'fixture_bootstrap',
				'-d',
				database
			],
			{ input: statement }
		)
	).output;
const inspect = async name =>
	JSON.parse((await docker(['inspect', name])).output)[0];
const requireFor = service =>
	createRequire(resolve(root, `apps/${service}/package.json`));
const constants = Object.fromEntries(
	services.map(service => [
		service,
		requireFor(service)(
			`./dist/src/messaging/${service}-messaging.constants.js`
		)
	])
);
function exact(names) {
	// Rabbit rejects long permission patterns. A finite prefix trie shares
	// literal prefixes without broadening access to any additional resource.
	function branch(values) {
		const groups = new Map();
		for (const value of values.filter(Boolean)) {
			const suffixes = groups.get(value[0]) ?? [];
			suffixes.push(value.slice(1));
			groups.set(value[0], suffixes);
		}
		const parts = [...groups].map(
			([character, suffixes]) =>
				character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + branch(suffixes)
		);
		const expression =
			parts.length > 1 ? `(?:${parts.join('|')})` : (parts[0] ?? '');
		return values.includes('') && expression
			? `(?:${expression})?`
			: expression;
	}
	assert.ok(
		names.length > 0 &&
			names.every(name => typeof name === 'string' && name.length > 0)
	);
	const pattern = `^${branch([...new Set(names)])}$`;
	assert.ok(pattern.length < 2048);
	const regex = new RegExp(pattern);
	for (const name of names) {
		assert.equal(regex.test(name), true);
		assert.equal(regex.test(`${name}.not-authorized`), false);
	}
	return pattern;
}

async function runContainer(
	name,
	image,
	args = [],
	env = {},
	options = []
) {
	assert.ok(name.startsWith(`${prefix}-`));
	ownedContainers.push(name);
	const result = await docker([
		'run',
		'-d',
		'--name',
		name,
		'--label',
		label,
		'--network',
		network,
		...options,
		...Object.entries(env).flatMap(([key, value]) => [
			'--env',
			`${key}=${value}`
		]),
		image,
		...args
	]);
	assert.match(result.output, /^[a-f0-9]{64}$/);
	return result.output;
}

async function until(description, probe, milliseconds = 90_000) {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await delay(1_000);
	}
	throw new Error(`Timed out: ${description}`);
}

async function utilityNode(source) {
	assert.ok(utilityReady);
	return await docker(['exec', '-i', utility, 'node', '-'], {
		input: source
	});
}

async function setupDatabase(service) {
	const db = databases[service];
	await sql(
		'postgres',
		`CREATE ROLE ${db.migration} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; CREATE ROLE ${db.runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; CREATE DATABASE ${db.name};`
	);
	await sql(
		db.name,
		`REVOKE ALL ON DATABASE ${db.name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db.name} TO ${db.migration}, ${db.runtime}; REVOKE ALL ON SCHEMA public FROM PUBLIC; CREATE SCHEMA ${service} AUTHORIZATION ${db.migration}; CREATE SCHEMA foreign_service_guard; CREATE TABLE foreign_service_guard.sentinel(id int); REVOKE ALL ON SCHEMA foreign_service_guard FROM PUBLIC;`
	);
	const migrationUrl = `postgresql://${db.migration}@postgres:5432/${db.name}?schema=${service}`;
	await docker([
		'run',
		'--rm',
		'--label',
		label,
		'--network',
		network,
		'--entrypoint',
		'node',
		'--env',
		`${service.toUpperCase()}_DATABASE_URL=${migrationUrl}`,
		images[service],
		'node_modules/prisma/build/index.js',
		'migrate',
		'deploy',
		'--schema',
		'prisma/schema.prisma'
	]);
	// No DDL, CREATE, foreign-schema access or privileged database role is given
	// to applications. This fixture is not a replacement for per-table ACL tests.
	await sql(
		db.name,
		`GRANT USAGE ON SCHEMA ${service} TO ${db.runtime}; GRANT SELECT ON ALL TABLES IN SCHEMA ${service} TO ${db.runtime}; GRANT INSERT, UPDATE, DELETE ON ${service}.outbox_events TO ${db.runtime};`
	);
	const mutations = {
		billing: [
			'integration_delivery_receipts',
			'integration_delivery_failures',
			'offer_projections',
			'settings',
			'provider_operations'
		],
		operations: [
			'telegram_bot_settings',
			'operational_alerts',
			'messaging_heartbeats',
			'scheduled_job_runs',
			'audit_event_receipts',
			'admin_event_logs',
			'database_restore_jobs',
			'database_restore_permits',
			'database_restore_recovery_actions',
			'database_restore_execution_lease'
		],
		support: [
			'messaging_heartbeats',
			'telegram_webhook_inbox',
			'telegram_outbound_deliveries',
			'consumer_receipts',
			'consumer_failures'
		]
	};
	for (const table of mutations[service]) {
		const exists = await sql(
			db.name,
			`SELECT to_regclass(${quote(`${service}.${table}`)}) IS NOT NULL;`
		);
		assert.equal(exists, 't', `Unknown fixture grant ${service}.${table}`);
		await sql(
			db.name,
			`GRANT INSERT, UPDATE, DELETE ON ${service}.${table} TO ${db.runtime};`
		);
	}
	assert.equal(
		await sql(
			db.name,
			`SELECT has_schema_privilege(${quote(db.runtime)}, ${quote(service)}, 'CREATE') OR has_schema_privilege(${quote(db.runtime)}, 'foreign_service_guard', 'USAGE');`
		),
		'f'
	);
	log(
		`Migrated isolated ${service} PG18 database with non-DDL runtime role`
	);
}

function aclFor(target) {
	const c = constants[target.service];
	if (target.service === 'billing') {
		const queues = Object.values(c.BILLING_QUEUE_NAMES).flatMap(queue => [
			queue,
			`${queue}.dead-letter`,
			...[1, 2, 3].map(n => `${queue}.retry.${n}`)
		]);
		return target.role === 'worker'
			? {
					configure: exact([
						c.BILLING_RETRY_EXCHANGE,
						c.BILLING_DEAD_LETTER_EXCHANGE,
						...queues
					]),
					write: exact([
						c.BILLING_RETRY_EXCHANGE,
						c.BILLING_DEAD_LETTER_EXCHANGE,
						...queues
					]),
					read: exact([
						c.BILLING_EVENTS_EXCHANGE,
						c.BILLING_RETRY_EXCHANGE,
						c.BILLING_DEAD_LETTER_EXCHANGE,
						...queues
					]),
					topics: [
						{
							exchange: c.BILLING_EVENTS_EXCHANGE,
							write: '^$',
							read: exact(Object.values(c.BILLING_ROUTING_KEYS))
						}
					]
				}
			: {
					configure: '^$',
					write: exact([
						c.BILLING_EVENTS_EXCHANGE,
						c.BILLING_RETRY_EXCHANGE,
						c.BILLING_DEAD_LETTER_EXCHANGE
					]),
					read: '^$',
					topics: [
						{
							exchange: c.BILLING_EVENTS_EXCHANGE,
							write: exact(['billing.settings.changed.v1']),
							read: '^$'
						}
					]
				};
	}
	if (target.service === 'support') {
		const queues = [
			c.SUPPORT_WEBHOOK_QUEUE,
			`${c.SUPPORT_WEBHOOK_QUEUE}.dead-letter`,
			...[1, 2, 3].map(n => `${c.SUPPORT_WEBHOOK_QUEUE}.retry-v2.${n}`)
		];
		const exchanges = [
			c.EVENTS_EXCHANGE,
			c.RETRY_EXCHANGE,
			c.DEAD_LETTER_EXCHANGE,
			c.MANUAL_RETRY_EXCHANGE
		];
		return target.role === 'worker'
			? {
					configure: exact([...exchanges, ...queues]),
					write: exact(queues),
					read: exact([...exchanges, ...queues]),
					topics: [
						{
							exchange: c.EVENTS_EXCHANGE,
							write: '^$',
							read: exact([c.SUPPORT_WEBHOOK_EVENT])
						}
					]
				}
			: {
					configure: '^$',
					write: exact(exchanges),
					read: '^$',
					topics: [
						{
							exchange: c.EVENTS_EXCHANGE,
							write: exact([
								c.SUPPORT_WEBHOOK_EVENT,
								c.SUPPORT_ADMIN_AUDIT_ROUTING_KEY
							]),
							read: '^$'
						},
						{
							exchange: c.DEAD_LETTER_EXCHANGE,
							write: exact([c.SUPPORT_DEAD_ROUTING_KEY]),
							read: '^$'
						}
					]
				};
	}
	const auditQueues = c.OPERATIONS_AUDIT_SOURCES.flatMap(source => [
		c.getOperationsAuditQueue(source),
		c.getOperationsAuditRetryQueue(source),
		c.getOperationsAuditDeadLetterQueue(source)
	]);
	const jobQueues = [
		c.OPERATIONS_SCHEDULED_JOB_QUEUE,
		c.OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE,
		c.OPERATIONS_SCHEDULED_JOB_DLQ
	];
	const restoreQueues = [
		c.OPERATIONS_DATABASE_RESTORE_QUEUE,
		c.OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
		c.OPERATIONS_DATABASE_RESTORE_DLQ
	];
	if (target.role === 'worker')
		return {
			configure: exact([
				'winwidget.events',
				'winwidget.retry',
				'winwidget.dead-letter',
				'winwidget.manual-retry',
				...auditQueues,
				...jobQueues
			]),
			write: exact(['winwidget.retry', 'winwidget.dead-letter']),
			read: exact([...auditQueues, ...jobQueues]),
			topics: [
				{
					exchange: 'winwidget.dead-letter',
					write:
						'^operations\\.admin\\.audit\\.[a-z0-9-]+\\.dead-letter\\.v1$',
					read: '^$'
				}
			]
		};
	if (target.role === 'restore-worker')
		return {
			configure: exact(restoreQueues),
			write: exact(['winwidget.retry']),
			read: exact(restoreQueues),
			topics: []
		};
	return {
		configure: '^$',
		write: exact(['winwidget.events', 'winwidget.manual-retry']),
		read: '^$',
		topics: [
			{
				exchange: 'winwidget.events',
				write: '^operations\\.[a-z0-9.-]+\\.v1$',
				read: '^$'
			}
		]
	};
}

async function provisionBroker() {
	for (const target of roles) {
		const acl = aclFor(target);
		await docker([
			'exec',
			'--user',
			'rabbitmq',
			rabbit,
			'rabbitmqctl',
			'-q',
			'add_user',
			target.username,
			target.password
		]);
		await docker([
			'exec',
			'--user',
			'rabbitmq',
			rabbit,
			'rabbitmqctl',
			'-q',
			'set_permissions',
			'-p',
			'winwidget',
			target.username,
			acl.configure,
			acl.write,
			acl.read
		]);
		for (const topic of acl.topics)
			await docker([
				'exec',
				'--user',
				'rabbitmq',
				rabbit,
				'rabbitmqctl',
				'-q',
				'set_topic_permissions',
				'-p',
				'winwidget',
				target.username,
				topic.exchange,
				topic.write,
				topic.read
			]);
	}
	const c = constants.operations;
	const queues = [
		...c.OPERATIONS_AUDIT_SOURCES.flatMap(source => [
			c.getOperationsAuditQueue(source),
			c.getOperationsAuditRetryQueue(source),
			c.getOperationsAuditDeadLetterQueue(source)
		]),
		c.OPERATIONS_SCHEDULED_JOB_QUEUE,
		c.OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE,
		c.OPERATIONS_SCHEDULED_JOB_DLQ,
		c.OPERATIONS_DATABASE_RESTORE_QUEUE,
		c.OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
		c.OPERATIONS_DATABASE_RESTORE_DLQ
	];
	await utilityNode(
		`const amqp=require('amqplib');(async()=>{const connection=await amqp.connect(process.env.PROOF_BROKER_URL);const channel=await connection.createChannel();for(const [name,type] of [['winwidget.events','topic'],['winwidget.retry','direct'],['winwidget.dead-letter','topic'],['winwidget.manual-retry','direct']])await channel.assertExchange(name,type,{durable:true});for(const queue of ${JSON.stringify(queues)})await channel.assertQueue(queue,{durable:true});for(const source of ${JSON.stringify(c.OPERATIONS_AUDIT_SOURCES)})await channel.bindQueue('winwidget.operations.admin.audit.'+source.source+'.v1','winwidget.events',source.routingKey);await channel.assertQueue('winwidget.bootstrap-proof.billing-settings',{durable:true});await channel.bindQueue('winwidget.bootstrap-proof.billing-settings','winwidget.events','billing.settings.changed.v1');await channel.assertQueue('winwidget.bootstrap-proof.operations-routing',{durable:true});await channel.bindQueue('winwidget.bootstrap-proof.operations-routing','winwidget.events','operations.notification-routing.changed.v1');await connection.close();})().catch(()=>{console.error('broker_fixture_failed');process.exitCode=1;});`
	);
	const support = constants.support;
	await utilityNode(
		`const amqp=require('amqplib');(async()=>{
const connection=await amqp.connect(process.env.PROOF_BROKER_URL), channel=await connection.createChannel();
const queue=${JSON.stringify(support.SUPPORT_WEBHOOK_QUEUE)}, consumer=${JSON.stringify(support.SUPPORT_WEBHOOK_CONSUMER)};
await channel.assertQueue(queue,{durable:true});
await channel.bindQueue(queue,'winwidget.events',${JSON.stringify(support.SUPPORT_WEBHOOK_EVENT)});
await channel.bindQueue(queue,'winwidget.manual-retry',consumer);
await channel.assertQueue(queue+'.dead-letter',{durable:true});
await channel.bindQueue(queue+'.dead-letter','winwidget.dead-letter',${JSON.stringify(support.SUPPORT_DEAD_ROUTING_KEY)});
for(const [index,delay] of ${JSON.stringify(support.SUPPORT_RETRY_DELAYS_MS)}.entries()) {
  await channel.assertQueue(queue+'.retry-v2.'+(index+1),{durable:true,messageTtl:delay,deadLetterExchange:'winwidget.manual-retry',deadLetterRoutingKey:consumer});
  await channel.bindQueue(queue+'.retry-v2.'+(index+1),'winwidget.retry',consumer+'.retry.'+(index+1));
}
await connection.close();})().catch(()=>process.exit(1));`
	);
	log(
		'Provisioned seven isolated scoped broker principals; no application admin credential'
	);
}

function environment(target) {
	const service = target.service,
		prefix = service.toUpperCase(),
		db = databases[service];
	const env = {
		MODE: 'development',
		NODE_ENV: 'production',
		APP_REVISION: revision,
		[`${prefix}_PROCESS_ROLE`]: target.role,
		[`${prefix}_DATABASE_URL`]: `postgresql://${db.runtime}@postgres:5432/${db.name}?schema=${service}&connection_limit=3`,
		[`${prefix}_LISTEN_HOST`]: '127.0.0.1',
		RABBITMQ_URL: `amqp://${target.username}:${target.password}@rabbit:5672/winwidget`,
		RABBITMQ_CONNECTION_NAME: `winwidget-${service}-${target.role}`,
		RABBITMQ_ASSERT_TOPOLOGY: String(target.role !== 'outbox-publisher'),
		RABBITMQ_MAX_MESSAGE_BYTES: '262144',
		IDENTITY_INTERNAL_BASE_URL: 'http://127.0.0.1:4900',
		CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
		TRUST_PROXY: 'loopback'
	};
	for (const key of [
		`${prefix}_OPERATIONS_TOKEN`,
		`IDENTITY_${prefix}_TOKEN`,
		`${prefix}_IDENTITY_TOKEN`
	])
		env[key] = randomBytes(32).toString('hex');
	if (service === 'billing')
		Object.assign(env, {
			BILLING_CAMPAIGNS_TOKEN: randomBytes(32).toString('hex'),
			WIDGETS_INTERNAL_BASE_URL: 'http://127.0.0.1:4700',
			WIDGETS_INTERNAL_TOKEN: randomBytes(32).toString('hex'),
			PAYMENT_METHOD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
			YOOKASSA_SHOP_ID: '123456789',
			YOOKASSA_SECRET_KEY: randomBytes(32).toString('hex'),
			RECAPTCHA_CLIENT_URL: 'http://localhost:3000'
		});
	if (service === 'support') {
		env.SUPPORT_PORT = String(target.port);
		if (target.role === 'worker')
			Object.assign(env, {
				TELEGRAM_SUPPORT_BOT_TOKEN: `123456789:${randomBytes(24).toString('hex')}`,
				TELEGRAM_API_BASE_URL: 'http://127.0.0.1:9',
				TELEGRAM_API_PROXY_IP: '127.0.0.1'
			});
	}
	if (service === 'operations')
		Object.assign(env, {
			DATABASE_RESTORE_ENABLED: 'false',
			DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64:
				randomBytes(32).toString('base64'),
			DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID: 'bootstrap-proof',
			DATABASE_RESTORE_STAGING_DIR: '/tmp/bootstrap-staging',
			DATABASE_RESTORE_SEALED_DIR: '/tmp/bootstrap-sealed',
			REPORTING_INTERNAL_TOKEN: randomBytes(32).toString('hex'),
			TELEGRAM_INFO_BOT_CONFIGURED: 'false'
		});
	return env;
}

async function roleReady(target) {
	const result = await docker(
		[
			'exec',
			target.name,
			'node',
			'-e',
			`fetch('http://127.0.0.1:${target.port}/health/ready',{signal:AbortSignal.timeout(2500)}).then(async r=>{const b=await r.json();if(!r.ok||b.status!=='ready'||b.service!==${JSON.stringify(target.service)}||b.role!==${JSON.stringify(target.role)}||b.revision!==${JSON.stringify(revision)})process.exit(1);}).catch(()=>process.exit(1));`
		],
		{ allowFailure: true, timeout: 5_000 }
	);
	return result.code === 0;
}

async function cleanup() {
	for (const name of [...ownedContainers].reverse()) {
		const result = await docker(['inspect', name], { allowFailure: true });
		if (result.code !== 0) continue;
		const detail = JSON.parse(result.output)[0];
		assert.equal(detail.Config.Labels['winwidget.bootstrap-proof'], runId);
		await docker(['rm', '--force', '--volumes', detail.Id]);
	}
	if (ownedNetwork) await docker(['network', 'rm', network]);
	log(
		"Removed only this proof's containers, anonymous volumes and isolated network; shared PG untouched"
	);
}

async function failureDiagnostics() {
	for (const name of ownedContainers) {
		const result = await docker(['inspect', name], { allowFailure: true });
		if (result.code !== 0) continue;
		const detail = JSON.parse(result.output)[0];
		assert.equal(detail.Config.Labels['winwidget.bootstrap-proof'], runId);
		const logs = await docker(['logs', '--tail', '150', name], {
			allowFailure: true
		});
		const content = logs.output + logs.errors;
		const patterns = {
			bootstrap: /bootstrap failed/i,
			thread:
				/Failed to create.*thread|Resource temporarily unavailable|eagain/i,
			permission: /permission denied|ACCESS_REFUSED/i,
			configuration: /is required|must be|is invalid/i,
			connection: /ECONNREFUSED|connect timeout/i,
			brokerBoot: /BOOT FAILED|Error during startup/i,
			brokerReady: /Server startup complete/i
		};
		log(
			`Diagnostic ${name.slice(prefix.length + 1)} ${JSON.stringify({ status: detail.State.Status, exit: detail.State.ExitCode, oom: detail.State.OOMKilled, restart: detail.RestartCount, categories: Object.keys(patterns).filter(key => patterns[key].test(content)) })}`
		);
	}
}

try {
	assert.equal((await docker(['context', 'show'])).output, 'colima');
	for (const service of services) {
		const image = JSON.parse(
			(
				await docker([
					'image',
					'inspect',
					`winwidget-bootstrap-proof-${service}:local`
				])
			).output
		)[0];
		assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
		images[service] = image.Id;
		const files = [
			'dist/src/main.js',
			'dist/src/runtime/bootstrap-failure.js'
		];
		const localHashes = await Promise.all(
			files.map(async file =>
				createHash('sha256')
					.update(await readFile(resolve(root, `apps/${service}/${file}`)))
					.digest('hex')
			)
		);
		const probeName = `${prefix}-image-${service}`;
		ownedContainers.push(probeName);
		const probe = JSON.parse(
			(
				await docker([
					'run',
					'--rm',
					'--name',
					probeName,
					'--label',
					label,
					'--network',
					'none',
					'--read-only',
					'--cap-drop',
					'ALL',
					'--security-opt',
					'no-new-privileges',
					'--entrypoint',
					'node',
					image.Id,
					'-e',
					`const fs=require('node:fs'),crypto=require('node:crypto');console.log(JSON.stringify({node:process.version,hashes:${JSON.stringify(files)}.map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))}));`
				])
			).output
		);
		assert.match(probe.node, /^v20\./);
		assert.deepEqual(
			probe.hashes,
			localHashes,
			`${service} image contains stale bootstrap code`
		);
		log(
			`${service} immutable test image ${image.Id}; Node ${probe.node}; main/helper sha256 ${localHashes.join('/')}`
		);
	}
	await docker([
		'network',
		'create',
		'--internal',
		'--label',
		label,
		network
	]);
	ownedNetwork = true;
	await runContainer(
		postgres,
		'postgres:18-bookworm',
		[],
		{
			POSTGRES_USER: 'fixture_bootstrap',
			POSTGRES_HOST_AUTH_METHOD: 'trust'
		},
		['--network-alias', 'postgres']
	);
	await until(
		'own PG18 ready',
		async () =>
			(
				await docker(
					[
						'exec',
						postgres,
						'pg_isready',
						'-U',
						'fixture_bootstrap',
						'-d',
						'postgres'
					],
					{ allowFailure: true }
				)
			).code === 0
	);
	const postgresVersion = Number(
		await sql('postgres', 'SHOW server_version_num;')
	);
	assert.ok(postgresVersion >= 180000 && postgresVersion < 190000);
	for (const service of services) await setupDatabase(service);
	await runContainer(
		rabbit,
		'rabbitmq:4.2.9-management-alpine@sha256:0ab90fc05c41e9d2d8f11af5036e466c364adf5085ed83c477ab41aec0bdde86',
		[],
		{
			RABBITMQ_DEFAULT_USER: brokerUser,
			RABBITMQ_DEFAULT_PASS: brokerPassword,
			RABBITMQ_DEFAULT_VHOST: 'winwidget'
		},
		['--network-alias', 'rabbit']
	);
	await runContainer(
		utility,
		images.billing,
		['-e', 'setInterval(()=>{},60000)'],
		{
			PROOF_BROKER_URL: `amqp://${brokerUser}:${brokerPassword}@rabbit:5672/winwidget`
		},
		['--entrypoint', 'node']
	);
	utilityReady = true;
	// Erlang ping/port checks can succeed before the Rabbit application and
	// its vhost are ready. Probe an actual AMQP handshake before provisioning.
	await until('own Rabbit AMQP ready', async () => {
		try {
			await utilityNode(
				"const amqp=require('amqplib');const deadline=setTimeout(()=>process.exit(1),4000);amqp.connect(process.env.PROOF_BROKER_URL,{timeout:3000}).then(c=>c.close()).then(()=>clearTimeout(deadline)).catch(()=>process.exit(1));"
			);
			return true;
		} catch {
			return false;
		}
	});
	await provisionBroker();
	// Seed one durable audit before the broker disappears. No external provider
	// effect is needed to prove message preservation and successful consumption.
	const eventId = randomUUID();
	const audit = {
		schemaVersion: 1,
		eventType: 'admin.audit.event.v1',
		eventId,
		occurredAt: new Date().toISOString(),
		correlationId: randomUUID(),
		actorId: 'bootstrap-proof-admin',
		section: 'PLATFORM_CONTENT',
		action: 'PLATFORM_SITE_SETTINGS_UPDATE',
		description: 'Synthetic cold-start proof',
		entity: {
			type: 'site_settings',
			id: 'singleton',
			label: null,
			targetUserId: null
		},
		metadata: {
			actorRole: 'ADMIN',
			requestIp: null,
			requestUserAgent: null,
			changedFields: ['bannerEnabled'],
			bannerTextChanged: false,
			bannerEnabled: true
		}
	};
	await utilityNode(
		`const amqp=require('amqplib');(async()=>{const c=await amqp.connect(process.env.PROOF_BROKER_URL);const ch=await c.createConfirmChannel();ch.publish('winwidget.events','admin.audit.platform.v1',Buffer.from(${JSON.stringify(JSON.stringify(audit))}),{persistent:true,mandatory:true,messageId:${JSON.stringify(eventId)},type:'admin.audit.event.v1'});await ch.waitForConfirms();const q=await ch.checkQueue('winwidget.operations.admin.audit.platform.v1');if(q.messageCount!==1)throw new Error();await c.close();})().catch(()=>{console.error('audit_seed_failed');process.exitCode=1;});`
	);
	await docker(['stop', '--time', '15', rabbit]);
	log(
		'Broker is unavailable. Starting all seven real role containers with restart=unless-stopped'
	);
	for (const target of roles)
		await runContainer(
			target.name,
			images[target.service],
			target.service === 'operations'
				? ['node', '-e', operationsFixturePrelude]
				: [],
			environment(target),
			['--restart', 'unless-stopped', '--memory', '512m', '--cpus', '0.75']
		);
	const negativeControl = {
		...roles[0],
		name: `${prefix}-negative-control`
	};
	await runContainer(
		negativeControl.name,
		images.billing,
		[
			'-e',
			`const fs=require('node:fs'),Module=require('node:module');const file='/app/dist/src/main.js';const source=fs.readFileSync(file,'utf8');const boundary='return (0, bootstrap_failure_1.terminateFailedBootstrap)(application);';if(source.split(boundary).length!==2)throw new Error('negative control boundary mismatch');const entry=new Module(file);entry.filename=file;entry.paths=Module._nodeModulePaths('/app/dist/src');entry._compile(source.replace(boundary,'process.exitCode = 1;'),file);`
		],
		environment(negativeControl),
		[
			'--entrypoint',
			'node',
			'--restart',
			'unless-stopped',
			'--memory',
			'512m',
			'--cpus',
			'0.75'
		]
	);
	await delay(36_000);
	const control = await inspect(negativeControl.name);
	assert.equal(control.State.Status, 'running');
	assert.equal(control.RestartCount, 0);
	assert.equal(control.State.OOMKilled, false);
	assert.equal(await roleReady(negativeControl), false);
	log(
		'Negative control with previous exitCode-only catch reproduced a running, non-ready bootstrap zombie'
	);
	await docker(['stop', '--time', '15', negativeControl.name]);
	for (const target of roles) {
		const detail = await inspect(target.name);
		assert.ok(
			detail.RestartCount >= 1,
			`${target.service}/${target.role} remained a bootstrap zombie`
		);
		assert.equal(detail.State.OOMKilled, false);
		log(
			`${target.service}/${target.role} exited and Docker restarted it ${detail.RestartCount} time(s) while Rabbit was unavailable`
		);
	}
	await docker(['start', rabbit]);
	for (const target of roles)
		await until(
			`${target.service}/${target.role} actual readiness after broker recovery`,
			() => roleReady(target),
			120_000
		);
	for (const target of roles) {
		const detail = await inspect(target.name);
		assert.equal(detail.Image, images[target.service]);
		assert.ok(detail.RestartCount >= 1);
		log(
			`${target.service}/${target.role} recovered actual role/revision readiness on the same image`
		);
	}
	await until(
		'queued audit delivered once',
		async () =>
			(await sql(
				databases.operations.name,
				`SELECT count(*) FROM operations.audit_event_receipts WHERE event_id=${quote(eventId)}::uuid AND status='DELIVERED';`
			)) === '1'
	);
	assert.equal(
		await sql(
			databases.operations.name,
			`SELECT count(*) FROM operations.admin_event_logs WHERE id=${quote(eventId)};`
		),
		'1'
	);
	assert.equal(
		await sql(
			databases.billing.name,
			'SELECT count(*) FROM billing.provider_operations;'
		),
		'0'
	);
	assert.equal(
		await sql(
			databases.operations.name,
			'SELECT count(*) FROM operations.database_restore_jobs;'
		),
		'0'
	);
	log(
		'PASS: seven image roles recovered from >30s broker outage; seeded durable audit survived and was delivered exactly once; no payment/restore operations'
	);
} catch (error) {
	await failureDiagnostics();
	throw error;
} finally {
	await cleanup();
}
