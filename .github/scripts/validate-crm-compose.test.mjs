import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	CRM_SERVICES,
	validateCrmCompose,
	validateCrmCompanionCompose
} from './validate-crm-compose.mjs';
import {
	CRM_IMAGE_SERVICES,
	CRM_IMAGE_PROCESSES
} from '../../apps/crm-access/test/integration/local-crm-image-topology.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const example = readFileSync(
	resolve(root, 'deploy/crm/.env.example'),
	'utf8'
);
const template = readFileSync(
	resolve(root, 'deploy/docker-compose.crm.yml'),
	'utf8'
);
const fixtureSecret = key =>
	createHash('sha256')
		.update('synthetic-compose-test-only:' + key)
		.digest('hex');
const upper = value => value.toUpperCase().replaceAll('-', '_');
const environment = Object.fromEntries(
	example
		.split('\n')
		.filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
		.map(line => {
			const offset = line.indexOf('=');
			return [line.slice(0, offset), line.slice(offset + 1)];
		})
);
for (const key of Object.keys(environment)) {
	if (key.endsWith('_TOKEN')) environment[key] = fixtureSecret(key);
	if (key.endsWith('_MEMORY_LIMIT')) environment[key] = '384m';
	if (key.endsWith('_CPUS')) environment[key] = '0.5';
}
environment.CRM_POSTGRES_SHM_SIZE = '64m';
environment.CRM_POSTGRES_IMAGE =
	'postgres:18-bookworm@sha256:' + 'a'.repeat(64);
for (const [app, schema, port, , roles] of CRM_SERVICES) {
	const prefix = upper(app);
	environment[prefix + '_IMAGE'] =
		'sha256:' + fixtureSecret(app + '-image');
	environment[prefix + '_REVISION'] = fixtureSecret(
		app + '-revision'
	).slice(0, 40);
	environment[prefix + '_POSTGRES_ADMIN_PASSWORD_FILE'] =
		'/opt/winwidget/deploy/backend/secrets/' +
		app +
		'-postgres-admin-password';
	const databaseUrl = (pool, migration = false) =>
		'postgresql://winwidget_' +
		schema +
		(migration ? '_migration' : '_runtime') +
		':' +
		fixtureSecret(app + (migration ? '-migration' : '-runtime')) +
		'@127.0.0.1:' +
		port +
		'/winwidget_' +
		schema +
		'?schema=' +
		schema +
		'&sslmode=disable&connection_limit=' +
		pool +
		'&pool_timeout=10';
	environment[prefix + '_MIGRATION_DATABASE_URL'] = databaseUrl(1, true);
	for (const [role, , pool] of roles) {
		environment[prefix + '_' + upper(role) + '_DATABASE_URL'] =
			databaseUrl(pool);
		if (role !== 'api')
			environment[prefix + '_' + upper(role) + '_RABBITMQ_URL'] =
				'amqp://winwidget-' +
				app +
				'-' +
				role +
				':' +
				fixtureSecret(app + '-' + role + '-broker') +
				'@127.0.0.1:5672/winwidget';
	}
}
const compose = (profiles, args = ['--format', 'json'], overrides = {}) =>
	spawnSync(
		'docker',
		[
			'compose',
			'--env-file',
			'/dev/null',
			'-f',
			'deploy/docker-compose.crm.yml',
			...profiles.flatMap(profile => ['--profile', profile]),
			'config',
			...args
		],
		{
			cwd: root,
			encoding: 'utf8',
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				COMPOSE_DISABLE_ENV_FILE: 'true',
				...environment,
				...overrides
			}
		}
	);
const rendered = compose(['*']);
assert.equal(
	rendered.status,
	0,
	'CRM Compose must render with synthetic inputs; captured output deliberately omitted'
);
const config = JSON.parse(rendered.stdout);

const companionSource = Object.fromEntries(
	readFileSync(resolve(root, '.env.example'), 'utf8')
		.split('\n')
		.filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
		.map(line => {
			const offset = line.indexOf('=');
			return [line.slice(0, offset), line.slice(offset + 1)];
		})
);
const companion = (overrides = {}) => {
	const source = { ...companionSource, ...overrides };
	const result = spawnSync(
		'docker',
		[
			'compose',
			'--env-file',
			'/dev/null',
			'-f',
			'deploy/docker-compose.prod.yml',
			'--profile',
			'*',
			'config',
			'--format',
			'json'
		],
		{
			cwd: root,
			encoding: 'utf8',
			timeout: 20000,
			maxBuffer: 1024 * 1024,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				COMPOSE_DISABLE_ENV_FILE: 'true',
				...source
			}
		}
	);
	assert.equal(
		result.status,
		0,
		'Synthetic companion Compose must render; private details suppressed'
	);
	return { config: JSON.parse(result.stdout), source };
};
const activeCompanion = {
	CRM_RABBITMQ_CONTRACT: 'mvp-v1',
	BILLING_WINCRM_PAYMENTS_ENABLED: 'true',
	BILLING_WINCRM_RECONCILIATION_ENABLED: 'true',
	BILLING_CRM_ACCESS_COMMERCE_BASE_URL: 'http://127.0.0.1:5300',
	BILLING_WINCRM_PROVIDER_RABBITMQ_URL:
		'amqp://winwidget-billing-wincrm-provider-worker:' +
		fixtureSecret('provider') +
		'@127.0.0.1:5672/winwidget',
	WIDGETS_WINCRM_CONNECTOR_ENABLED: 'true',
	BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: 'true',
	WINCRM_INVITATION_EMAIL_ENABLED: 'true',
	NOTIFICATION_DELIVERY_KINDS:
		companionSource.NOTIFICATION_DELIVERY_KINDS +
		',wincrm-invitation-email'
};
for (const key of [
	'IDENTITY_CRM_ACCESS_TOKEN',
	'BILLING_CRM_ACCESS_TOKEN',
	'BILLING_CRM_ACCESS_COMMERCE_TOKEN',
	'IDENTITY_NOTIFICATION_DELIVERY_TOKEN',
	'WIDGETS_CRM_INTAKE_TOKEN',
	'BILLING_WINCRM_WIDGETS_TOKEN',
	'BILLING_WINCRM_CRM_INTAKE_TOKEN'
])
	activeCompanion[key] = fixtureSecret(key);

test('existing services keep CRM default-off with exact process-scoped variables', () => {
	const value = companion();
	assert.deepEqual(
		validateCrmCompanionCompose(value.config, value.source),
		{
			wiringVerified: true,
			credentialsProvisioned: false,
			releaseApproved: false
		}
	);
	assert.equal(
		value.config.services['billing-worker'].environment
			.BILLING_WINCRM_PROVIDER_RABBITMQ_URL,
		''
	);
	assert.equal(value.source.CRM_RABBITMQ_CONTRACT, 'disabled');
});

test('complete opt-in passes, and scheduler never receives the provider or reverse authority credentials', () => {
	const value = companion(activeCompanion);
	assert.equal(
		validateCrmCompanionCompose(value.config, value.source).wiringVerified,
		true
	);
	for (const name of [
		'billing-api',
		'billing-scheduler',
		'billing-outbox-publisher'
	]) {
		assert.equal(
			Object.hasOwn(
				value.config.services[name].environment,
				'BILLING_WINCRM_PROVIDER_RABBITMQ_URL'
			),
			false
		);
		assert.equal(
			Object.hasOwn(
				value.config.services[name].environment,
				'BILLING_CRM_ACCESS_COMMERCE_TOKEN'
			),
			false
		);
	}
	assert.equal(
		value.config.services['billing-worker'].environment
			.BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY,
		'false'
	);
	assert.deepEqual(
		value.source.NOTIFICATION_DELIVERY_KINDS.split(',').slice(0, -1),
		companionSource.NOTIFICATION_DELIVERY_KINDS.split(',')
	);
	const draining = companion({
		...activeCompanion,
		BILLING_WINCRM_PAYMENTS_ENABLED: 'false'
	});
	assert.equal(
		validateCrmCompanionCompose(draining.config, draining.source)
			.wiringVerified,
		true
	);
});

test('missing, drifted or leaked CRM settings are rejected for every process boundary', () => {
	const value = companion(activeCompanion);
	for (const [name, service] of Object.entries(value.config.services)) {
		for (const key of Object.keys(service.environment ?? {}).filter(
			key =>
				/CRM/.test(key) || key === 'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
		)) {
			for (const missing of [true, false]) {
				const changed = structuredClone(value.config);
				if (missing) delete changed.services[name].environment[key];
				else changed.services[name].environment[key] = 'incorrect';
				assert.throws(() =>
					validateCrmCompanionCompose(changed, value.source)
				);
			}
		}
		if (name === 'billing-worker') continue;
		const changed = structuredClone(value.config);
		changed.services[name].environment ??= {};
		changed.services[
			name
		].environment.BILLING_WINCRM_PROVIDER_RABBITMQ_URL =
			value.source.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
		assert.throws(() =>
			validateCrmCompanionCompose(changed, value.source)
		);
	}
});

test('activation is rejected without prerequisites, valid worker credentials or retained reconciliation', () => {
	for (const invalid of [
		{ CRM_RABBITMQ_CONTRACT: 'disabled' },
		{ BILLING_WINCRM_RECONCILIATION_ENABLED: 'false' },
		{
			BILLING_WINCRM_PAYMENTS_ENABLED: 'false',
			BILLING_WINCRM_RECONCILIATION_ENABLED: 'false'
		},
		{ BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: 'false' },
		{
			NOTIFICATION_DELIVERY_KINDS:
				companionSource.NOTIFICATION_DELIVERY_KINDS
		},
		{ IDENTITY_NOTIFICATION_DELIVERY_TOKEN: 'placeholder' },
		{
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL:
				activeCompanion.BILLING_WINCRM_PROVIDER_RABBITMQ_URL.replace(
					'winwidget-billing-wincrm-provider-worker:',
					'winwidget-billing-worker:'
				)
		},
		{
			BILLING_WINCRM_PROVIDER_RABBITMQ_URL:
				activeCompanion.BILLING_WINCRM_PROVIDER_RABBITMQ_URL +
				'?ignore=true'
		},
		{
			WIDGETS_CRM_INTAKE_TOKEN:
				activeCompanion.BILLING_WINCRM_WIDGETS_TOKEN
		},
		{ BILLING_CRM_ACCESS_COMMERCE_BASE_URL: 'http://api.winwidget.ru' }
	]) {
		const value = companion({ ...activeCompanion, ...invalid });
		assert.throws(() =>
			validateCrmCompanionCompose(value.config, value.source)
		);
	}
});

test('real Compose normalization validates twenty isolated CRM definitions without starting Docker', () => {
	const report = validateCrmCompose(config);
	assert.equal(report.runtimeProcesses, 12);
	assert.equal(report.databases, 4);
	assert.equal(report.migrationJobs, 4);
	assert.equal(report.runtimeConnections, 40);
	assert.equal(report.runtimeMemoryBytes, 12 * 384 * 1024 * 1024);
	assert.equal(report.databaseMemoryBytes, 4 * 384 * 1024 * 1024);
	assert.equal(report.maxMigrationMemoryBytes, 384 * 1024 * 1024);
	assert.equal(report.capacityVerified, false);
	assert.equal(report.credentialsProvisioned, false);
	assert.equal(report.releaseApproved, false);
});

for (const [profiles, count] of [
	[[], 0],
	[['crm-runtime'], 12],
	[['crm-databases'], 4],
	[['crm-migrations'], 4]
]) {
	test(
		'only explicitly selected profiles are active: ' +
			(profiles.join(',') || 'none'),
		() => {
			const result = compose(profiles, ['--services']);
			assert.equal(result.status, 0, 'Compose profile rendering failed');
			assert.equal(
				result.stdout.trim().split('\n').filter(Boolean).length,
				count
			);
		}
	);
}

test('all structural inputs are documented and no placeholder can silently produce production resources', () => {
	const keys = [...template.matchAll(/\$\{([A-Z0-9_]+):[?-]/g)].map(
		match => match[1]
	);
	assert.deepEqual(
		[...new Set(keys)].sort(),
		Object.keys(environment).sort()
	);
	assert.equal(
		Object.keys(environment).length,
		example.split('\n').filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
			.length
	);
	for (const key of [
		'CRM_API_MEMORY_LIMIT',
		'CRM_WORKER_CPUS',
		'CRM_POSTGRES_MEMORY_LIMIT',
		'CRM_ACCESS_IMAGE',
		'CRM_ACCESS_REVISION',
		'CRM_ACCESS_API_DATABASE_URL',
		'CRM_ACCESS_POSTGRES_ADMIN_PASSWORD_FILE'
	]) {
		assert.notEqual(
			compose(['*'], ['--quiet'], { [key]: '' }).status,
			0,
			'Missing required input was accepted'
		);
	}
});

test('default CRM flags do not activate commerce or native Widgets', () => {
	assert.equal(
		config.services['crm-access-api'].environment
			.CRM_ACCESS_BILLING_ENABLED,
		'false'
	);
	assert.equal(
		config.services['crm-intake-api'].environment
			.CRM_INTAKE_WIDGETS_ENABLED,
		'false'
	);
	assert.equal(
		config.services['crm-intake-api'].environment
			.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED,
		'false'
	);
	// Existing services need opt-in CRM settings, not embedded CRM runtimes/DBs.
	const ordinary = companion().config;
	assert.equal(
		Object.keys(ordinary.services).some(name => name.startsWith('crm-')),
		false
	);
	assert.equal(
		Object.keys(ordinary.volumes ?? {}).some(name => /crm/.test(name)),
		false
	);
	assert.equal(
		Object.keys(ordinary.networks ?? {}).some(name => /crm/.test(name)),
		false
	);
});

test('Compose roles, ports and pool ceilings match the twelve-process image rehearsal', () => {
	assert.deepEqual(
		CRM_SERVICES.map(([app, schema, port, maxConnections]) => ({
			app,
			schema,
			port,
			maxConnections
		})),
		CRM_IMAGE_SERVICES
	);
	assert.deepEqual(
		CRM_SERVICES.flatMap(([app, , , , roles]) =>
			roles.map(([role, port, connections]) => ({
				app,
				role,
				port,
				connections
			}))
		),
		CRM_IMAGE_PROCESSES
	);
});

test('equivalent Compose versions may omit image-default nulls or return numeric resource bytes', () => {
	const candidate = structuredClone(config);
	for (const service of Object.values(candidate.services)) {
		for (const key of ['command', 'entrypoint'])
			if (service[key] === null) delete service[key];
		for (const key of ['mem_limit', 'memswap_limit', 'shm_size'])
			if (key in service) service[key] = Number(service[key]);
	}
	for (const network of Object.values(candidate.networks))
		delete network.ipam;
	assert.deepEqual(
		validateCrmCompose(candidate),
		validateCrmCompose(config)
	);
});

test('consistent enabled feature settings still cannot assert release approval', () => {
	const candidate = structuredClone(config);
	for (const service of Object.values(candidate.services))
		for (const key of [
			'CRM_ACCESS_BILLING_ENABLED',
			'CRM_INTAKE_WIDGETS_ENABLED',
			'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED'
		]) {
			if (key in service.environment) service.environment[key] = 'true';
		}
	assert.equal(validateCrmCompose(candidate).releaseApproved, false);
});

const reject = (name, mutate) =>
	test(name, () => {
		const candidate = structuredClone(config);
		mutate(candidate);
		assert.throws(() => validateCrmCompose(candidate));
	});
reject('no combined project or old backend', value => {
	value.name = 'winwidget';
});
reject('no fifth shared application', value => {
	value.services.core = value.services['crm-access-api'];
});
reject('no application without a profile', value => {
	delete value.services['crm-access-api'].profiles;
});
reject('no combined runtime role', value => {
	value.services['crm-intake-api'].environment.CRM_INTAKE_PROCESS_ROLE =
		'all';
});
reject('no public API listener', value => {
	value.services['crm-sales-api'].environment.CRM_SALES_LISTEN_HOST =
		'0.0.0.0';
});
reject('no privileged process', value => {
	value.services['crm-customers-api'].privileged = true;
});
reject('no writable application root', value => {
	value.services['crm-access-worker'].read_only = false;
});
reject('no floating application tag', value => {
	value.services['crm-access-api'].image = 'winwidget-crm-access:latest';
});
reject('no wrong migration image', value => {
	value.services['crm-access-migrate'].image =
		value.services['crm-sales-api'].image;
});
reject('no unbounded process memory', value => {
	delete value.services['crm-intake-worker'].mem_limit;
});
reject('no swap-dependent process', value => {
	value.services['crm-intake-worker'].memswap_limit = -1;
});
reject('no unbounded CPU', value => {
	value.services['crm-intake-worker'].cpus = 0;
});
reject('no public database bind', value => {
	value.services['crm-access-postgres'].ports[0].host_ip = '0.0.0.0';
});
reject('no shared database volume', value => {
	value.services['crm-intake-postgres'].volumes[0].source =
		'crm-access-postgres-data';
});
reject('no shared database network', value => {
	value.services['crm-intake-postgres'].networks =
		value.services['crm-access-postgres'].networks;
});
reject('no API migration credential', value => {
	value.services['crm-access-api'].environment.CRM_ACCESS_DATABASE_URL =
		value.services[
			'crm-access-migrate'
		].environment.CRM_ACCESS_DATABASE_URL;
});
reject('no foreign database role', value => {
	value.services['crm-intake-api'].environment.CRM_INTAKE_DATABASE_URL =
		value.services['crm-access-api'].environment.CRM_ACCESS_DATABASE_URL;
});
reject('no absent pool cap', value => {
	const env = value.services['crm-access-api'].environment;
	env.CRM_ACCESS_DATABASE_URL = env.CRM_ACCESS_DATABASE_URL.replace(
		'&connection_limit=5',
		''
	);
});
reject('no changed worker pool', value => {
	const env = value.services['crm-access-worker'].environment;
	env.CRM_ACCESS_DATABASE_URL = env.CRM_ACCESS_DATABASE_URL.replace(
		'connection_limit=4',
		'connection_limit=10'
	);
});
reject('no migration secrets in runtime', value => {
	value.services[
		'crm-access-api'
	].environment.CRM_ACCESS_MIGRATION_DATABASE_URL = 'unexpected';
});
reject('no HTTP secrets in migration job', value => {
	value.services[
		'crm-access-migrate'
	].environment.IDENTITY_CRM_ACCESS_TOKEN = fixtureSecret('unexpected');
});
reject('no broker credential in API', value => {
	value.services['crm-access-api'].environment.RABBITMQ_URL =
		value.services['crm-access-worker'].environment.RABBITMQ_URL;
});
reject('no shared broker principal', value => {
	value.services['crm-access-outbox-publisher'].environment.RABBITMQ_URL =
		value.services['crm-access-worker'].environment.RABBITMQ_URL;
});
reject('no broker admin principal', value => {
	const env = value.services['crm-access-worker'].environment;
	env.RABBITMQ_URL = env.RABBITMQ_URL.replace(
		'winwidget-crm-access-worker:',
		'guest:'
	);
});
reject('no mismatched pairwise token', value => {
	value.services['crm-sales-api'].environment.CRM_SALES_CRM_ACCESS_TOKEN =
		fixtureSecret('mismatched');
});
reject('no shared directional token', value => {
	const env = value.services['crm-access-api'].environment;
	env.BILLING_CRM_ACCESS_COMMERCE_TOKEN = env.BILLING_CRM_ACCESS_TOKEN;
});
reject('no public dependency shortcut', value => {
	value.services['crm-access-api'].environment.IDENTITY_INTERNAL_BASE_URL =
		'https://api.winwidget.ru';
});
reject('no automatic Intake topology provisioning', value => {
	value.services[
		'crm-intake-worker'
	].environment.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'true';
});
for (const role of ['api', 'worker', 'outbox-publisher']) {
	reject(`no automatic Access topology provisioning in ${role}`, value => {
		value.services[
			'crm-access-' + role
		].environment.CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY = 'true';
	});
	reject(`no absent Access topology policy in ${role}`, value => {
		delete value.services['crm-access-' + role].environment
			.CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY;
	});
}
reject('no new transfers without the managed connector', value => {
	value.services[
		'crm-intake-api'
	].environment.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED = 'true';
});
reject('no cross-role feature gate mismatch', value => {
	value.services[
		'crm-access-worker'
	].environment.CRM_ACCESS_BILLING_ENABLED = 'true';
});
reject('no health endpoint from another process', value => {
	value.services['crm-access-worker'].healthcheck =
		value.services['crm-access-api'].healthcheck;
});
reject('no PostgreSQL trust authentication', value => {
	value.services[
		'crm-access-postgres'
	].environment.POSTGRES_HOST_AUTH_METHOD = 'trust';
});
reject('no arbitrary privileged secret path', value => {
	value.secrets['crm-access-postgres-admin-password'].file = '/etc/shadow';
});

test('validator failure output never contains credentials, supplied input or a stack trace', () => {
	const candidate = structuredClone(config);
	candidate.services[
		'crm-access-api'
	].environment.CRM_ACCESS_DATABASE_URL =
		'postgresql://sensitive-value-that-must-not-appear';
	const result = spawnSync(
		process.execPath,
		['.github/scripts/validate-crm-compose.mjs'],
		{
			cwd: root,
			encoding: 'utf8',
			input: JSON.stringify(candidate),
			timeout: 5000
		}
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, '');
	assert.ok(
		!result.stderr.includes('sensitive-value') &&
			!result.stderr.includes('at validate')
	);
	assert.match(result.stderr, /^CRM Compose validation failed: [^\n]+\n$/);
	for (const value of Object.values(environment).filter(value =>
		/^[a-f0-9]{48,128}$/.test(value)
	))
		assert.ok(!result.stderr.includes(value));
});
