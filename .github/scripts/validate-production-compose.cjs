const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const fail = message => {
	throw new Error(message);
};
const assert = (condition, message) => {
	if (!condition) fail(message);
};
const normalizeCommand = command =>
	Array.isArray(command) ? command.join(' ') : String(command ?? '');
const sorted = values => [...values].sort();
const parseUrl = (value, label) => {
	try {
		return new URL(value);
	} catch {
		fail(label + ' is not a valid URL');
	}
};

const parseExample = path => {
	const values = new Map();
	for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separator = line.indexOf('=');
		if (separator < 1) continue;
		const key = line.slice(0, separator);
		if (values.has(key)) fail(path + ' contains duplicate ' + key);
		values.set(key, line.slice(separator + 1));
	}
	return values;
};

const config = JSON.parse(readFileSync(0, 'utf8'));
const services = config.services ?? {};
const rootExample = parseExample('.env.example');
const gatewayExample = parseExample('apps/api-gateway/.env.example');
const notificationDeliveryExample = parseExample(
	'apps/notification-delivery/.env.example'
);
const expected = key => process.env[key] ?? rootExample.get(key);

const composeUnusedLegacyRootExampleKeys = [
	'NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS',
	'CAMPAIGNS_AUDIENCE_EXPORT_CHUNK_SIZE',
	'BILLING_PROCESS_ROLE',
	'IDENTITY_PROCESS_ROLE',
	'PLATFORM_PROCESS_ROLE',
	'PLATFORM_INTERNAL_TIMEOUT_MS',
	'SUPPORT_PROCESS_ROLE',
	'OPERATIONS_PROCESS_ROLE',
	'YOOKASSA_SHOP_ID',
	'YOOKASSA_SECRET_KEY',
	'TELEGRAM_INFO_BOT_CONFIGURED',
	'RABBITMQ_USER',
	'RABBITMQ_PASSWORD',
	'RABBITMQ_URL',
	'RABBITMQ_ASSERT_TOPOLOGY',
	'MESSAGING_ALERTS_ENABLED',
	'MESSAGING_ACTIVITY_STALE_MS',
	'MESSAGING_QUEUE_BACKLOG_ALERT_THRESHOLD'
];
const reintroducedLegacyRootExampleKeys =
	composeUnusedLegacyRootExampleKeys.filter(key => rootExample.has(key));
assert(
	reintroducedLegacyRootExampleKeys.length === 0,
	'.env.example reintroduced Compose-unused legacy keys: ' +
		reintroducedLegacyRootExampleKeys.join(',')
);

assert(config.name === 'winwidget', 'Unexpected Compose project name');
for (const [name, service] of Object.entries(services)) {
	assert(
		!('container_name' in service),
		name + ' must use the standard Compose container name'
	);
}

const restoreGateLines = readFileSync('.env.example', 'utf8')
	.split('\n')
	.filter(line => line.startsWith('DATABASE_RESTORE_ENABLED='));
assert(
	restoreGateLines.length === 1 &&
		restoreGateLines[0] === 'DATABASE_RESTORE_ENABLED=false',
	'.env.example must keep Operations restore disabled by default'
);

const retiredCoreServices = [
	'api',
	'outbox-publisher',
	'integration-worker',
	'maintenance-worker',
	'database-restore-worker',
	'migrate'
];
const remainingRetiredServices = retiredCoreServices.filter(
	name => services[name]
);
assert(
	remainingRetiredServices.length === 0,
	'Retired Core services remain: ' + remainingRetiredServices.join(',')
);

const expectedPersistentServices = sorted([
	'api-gateway',
	'billing-api',
	'billing-outbox-publisher',
	'billing-scheduler',
	'billing-worker',
	'campaigns-service',
	'identity-api',
	'identity-outbox-publisher',
	'identity-worker',
	'notification-delivery-worker',
	'operations-api',
	'operations-outbox-publisher',
	'operations-restore-worker',
	'operations-worker',
	'platform-api',
	'platform-outbox-publisher',
	'rabbitmq',
	'reporting-service',
	'support-api',
	'support-outbox-publisher',
	'support-worker',
	'widgets-service'
]);
const actualPersistentServices = sorted(
	Object.entries(services)
		.filter(([, service]) => (service.profiles ?? []).length === 0)
		.map(([name]) => name)
);
assert(
	JSON.stringify(actualPersistentServices) ===
		JSON.stringify(expectedPersistentServices),
	'Unexpected apps-only persistent services: ' +
		actualPersistentServices.join(',')
);

const requireService = name => {
	const service = services[name];
	if (!service) fail('Missing production service ' + name);
	return service;
};
const environmentOf = name => requireService(name).environment ?? {};
const requireCommand = (name, command) => {
	assert(
		normalizeCommand(requireService(name).command) === command,
		name + ' command drifted'
	);
};
const usesStandaloneBuild = (build, slug) => {
	const context = resolve(String(build?.context ?? ''));
	if (slug === 'widgets') {
		return (
			context === resolve(process.cwd()) &&
			build?.dockerfile === 'apps/widgets/Dockerfile'
		);
	}
	return (
		context.replaceAll('\\', '/').endsWith('/apps/' + slug) &&
		build?.dockerfile === 'Dockerfile'
	);
};
const assertNoCommand = name => {
	assert(
		requireService(name).command == null,
		name + ' command must be owned by its image'
	);
};
const assertExactKeys = (object, expectedKeys, label) => {
	const actualKeys = sorted(Object.keys(object));
	const wantedKeys = sorted(expectedKeys);
	assert(
		JSON.stringify(actualKeys) === JSON.stringify(wantedKeys),
		label + ' key boundary drifted: ' + actualKeys.join(',')
	);
};

for (const [name, service] of Object.entries(services)) {
	assert(
		!String(service.image ?? '').startsWith('winwidget-api:'),
		name + ' still uses the retired Core image'
	);
	for (const [key, value] of Object.entries(service.environment ?? {})) {
		assert(
			!/(^|_)CORE($|_)/.test(key),
			name + ' still receives Core env ' + key
		);
		assert(
			!String(value).includes('127.0.0.1:4200') &&
				!String(value).includes('localhost:4200'),
			name + ' still points to Core through ' + key
		);
	}
}

const databaseTargets = [
	{
		slug: 'notification-delivery',
		prefix: 'NOTIFICATION_DELIVERY',
		port: '55432',
		database: 'winwidget_notification_delivery',
		schema: 'notification_delivery',
		runtimeService: 'notification-delivery-worker',
		runtimeKey: 'NOTIFICATION_DELIVERY_DATABASE_URL',
		migrationKey: 'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION',
		migrationEnvironmentKey: 'NOTIFICATION_DELIVERY_DATABASE_URL',
		backupKey: 'NOTIFICATION_DELIVERY_BACKUP_URL'
	},
	{
		slug: 'campaigns',
		prefix: 'CAMPAIGNS',
		port: '55433',
		database: 'winwidget_campaigns',
		schema: 'campaigns',
		runtimeService: 'campaigns-service',
		runtimeKey: 'CAMPAIGNS_DATABASE_URL',
		migrationKey: 'CAMPAIGNS_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'CAMPAIGNS_DATABASE_URL',
		backupKey: 'CAMPAIGNS_BACKUP_URL'
	},
	{
		slug: 'reporting',
		prefix: 'REPORTING',
		port: '55435',
		database: 'winwidget_reporting',
		schema: 'reporting',
		runtimeService: 'reporting-service',
		runtimeKey: 'REPORTING_DATABASE_URL',
		migrationKey: 'REPORTING_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'REPORTING_DATABASE_URL',
		backupKey: 'REPORTING_BACKUP_URL'
	},
	{
		slug: 'widgets',
		prefix: 'WIDGETS',
		port: '55436',
		database: 'winwidget_widgets',
		schema: 'widgets',
		runtimeService: 'widgets-service',
		runtimeKey: 'WIDGETS_DATABASE_URL',
		migrationKey: 'WIDGETS_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'WIDGETS_DATABASE_URL',
		backupKey: 'WIDGETS_BACKUP_URL'
	},
	{
		slug: 'billing',
		prefix: 'BILLING',
		port: '55437',
		database: 'winwidget_billing',
		schema: 'billing',
		runtimeService: 'billing-api',
		runtimeKey: 'BILLING_DATABASE_URL',
		migrationKey: 'BILLING_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'BILLING_DATABASE_URL',
		backupKey: 'BILLING_BACKUP_URL'
	},
	{
		slug: 'identity',
		prefix: 'IDENTITY',
		port: '55438',
		database: 'winwidget_identity',
		schema: 'identity',
		runtimeService: 'identity-api',
		runtimeKey: 'IDENTITY_DATABASE_URL',
		migrationKey: 'IDENTITY_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'IDENTITY_DATABASE_URL',
		backupKey: 'IDENTITY_BACKUP_URL'
	},
	{
		slug: 'platform',
		prefix: 'PLATFORM',
		port: '55439',
		database: 'winwidget_platform',
		schema: 'platform',
		runtimeService: 'platform-api',
		runtimeKey: 'PLATFORM_DATABASE_URL',
		migrationKey: 'PLATFORM_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'PLATFORM_DATABASE_URL',
		backupKey: 'PLATFORM_BACKUP_URL'
	},
	{
		slug: 'support',
		prefix: 'SUPPORT',
		port: '55440',
		database: 'winwidget_support',
		schema: 'support',
		runtimeService: 'support-api',
		runtimeKey: 'SUPPORT_DATABASE_URL',
		migrationKey: 'SUPPORT_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'SUPPORT_DATABASE_URL',
		backupKey: 'SUPPORT_BACKUP_URL'
	},
	{
		slug: 'operations',
		prefix: 'OPERATIONS',
		port: '55441',
		database: 'winwidget_operations',
		schema: 'operations',
		runtimeService: 'operations-api',
		runtimeKey: 'OPERATIONS_DATABASE_URL',
		migrationKey: 'OPERATIONS_MIGRATION_DATABASE_URL',
		migrationEnvironmentKey: 'OPERATIONS_DATABASE_URL',
		backupKey: 'OPERATIONS_BACKUP_URL'
	}
];

const expectedPostgresHealth = JSON.stringify({
	test: [
		'CMD-SHELL',
		'pg_isready --username "$$POSTGRES_USER" --dbname "$$POSTGRES_DB"'
	],
	timeout: '5s',
	interval: '10s',
	retries: 12,
	start_period: '10s'
});
for (const target of databaseTargets) {
	const appExample = parseExample(`apps/${target.slug}/.env.example`);
	for (const [key, role] of [
		[target.runtimeKey, 'runtime'],
		[target.migrationKey, 'migration']
	]) {
		const url = parseUrl(
			appExample.get(key),
			`apps/${target.slug}/.env.example ${key}`
		);
		assert(
			url.protocol === 'postgresql:',
			target.slug + ' example protocol drifted'
		);
		assert(
			url.hostname === '127.0.0.1',
			target.slug + ' example host drifted'
		);
		assert(
			url.port === target.port,
			target.slug + ' example port drifted'
		);
		assert(
			url.pathname === '/' + target.database,
			target.slug + ' example database drifted'
		);
		assert(
			decodeURIComponent(url.username) === `${target.database}_${role}`,
			target.slug + ' example database role drifted'
		);
		assert(
			url.password.length > 0,
			target.slug + ' example database password is empty'
		);
		assert(
			url.searchParams.get('schema') === target.schema,
			target.slug + ' example schema drifted'
		);
		assert(
			url.searchParams.get('sslmode') === 'disable',
			target.slug + ' example sslmode drifted'
		);
	}
	const postgresName = target.slug + '-postgres';
	const postgres = requireService(postgresName);
	const environment = environmentOf(postgresName);
	const volumeKey = 'winwidget-' + target.slug + '-postgres-data';
	const secretKey = target.slug + '-postgres-admin-password';
	const networkKey = target.slug + '-postgres';
	const port = (postgres.ports ?? [])[0];
	const mount = (postgres.volumes ?? [])[0];
	const secret = (postgres.secrets ?? [])[0];

	assert(
		(postgres.profiles ?? []).includes(target.slug + '-database'),
		postgresName + ' profile drifted'
	);
	assert(
		postgres.image === expected(target.prefix + '_POSTGRES_IMAGE'),
		postgresName + ' image drifted'
	);
	assert(
		/^postgres:18(?:-|@)/.test(postgres.image),
		postgresName + ' must stay on PostgreSQL 18'
	);
	assert(
		environment.POSTGRES_DB === target.database,
		postgresName + ' database name drifted'
	);
	assert(
		environment.POSTGRES_USER ===
			expected(target.prefix + '_POSTGRES_ADMIN_USER'),
		postgresName + ' admin user drifted'
	);
	assert(
		environment.POSTGRES_PASSWORD_FILE === '/run/secrets/' + secretKey,
		postgresName + ' password file drifted'
	);
	assert(
		environment.PGDATA === '/var/lib/postgresql/18/docker',
		postgresName + ' PGDATA drifted'
	);
	assert(
		String(environment.POSTGRES_INITDB_ARGS).includes(
			'--data-checksums'
		) &&
			String(environment.POSTGRES_INITDB_ARGS).includes(
				'--auth-host=scram-sha-256'
			),
		postgresName + ' init safeguards drifted'
	);
	assert(
		port?.host_ip === '127.0.0.1' &&
			String(port.published) === target.port &&
			Number(port.target) === 5432,
		postgresName + ' must publish only the exact loopback port'
	);
	assert(
		mount?.type === 'volume' &&
			mount.source === expected(target.prefix + '_POSTGRES_DATA_VOLUME') &&
			mount.target === '/var/lib/postgresql',
		postgresName + ' external data volume drifted'
	);
	assert(
		secret?.source === secretKey,
		postgresName + ' admin secret drifted'
	);
	assert(
		Object.hasOwn(postgres.networks ?? {}, networkKey),
		postgresName + ' network drifted'
	);
	assert(
		postgres.restart === 'unless-stopped',
		postgresName + ' restart policy drifted'
	);
	assert(
		postgres.stop_grace_period === '1m0s',
		postgresName + ' stop grace drifted'
	);
	assert(
		Number(postgres.pids_limit) === 200,
		postgresName + ' pids limit drifted'
	);
	assert(
		JSON.stringify(postgres.healthcheck) === expectedPostgresHealth,
		postgresName + ' healthcheck drifted'
	);
	assert(
		postgres.labels?.['com.winwidget.owner'] === target.slug,
		postgresName + ' owner label drifted'
	);
	assert(
		postgres.labels?.['com.winwidget.purpose'] === 'postgres',
		postgresName + ' purpose label drifted'
	);

	const externalVolume = config.volumes?.[volumeKey];
	assert(
		externalVolume?.external === true &&
			externalVolume.name ===
				expected(target.prefix + '_POSTGRES_DATA_VOLUME'),
		postgresName + ' must use the exact external volume'
	);
	const composeSecret = config.secrets?.[secretKey];
	assert(
		composeSecret?.file ===
			expected(target.prefix + '_POSTGRES_ADMIN_PASSWORD_FILE'),
		postgresName + ' Compose secret file drifted'
	);
	const network = config.networks?.[networkKey];
	assert(
		network?.driver === 'bridge' &&
			network.internal !== true &&
			network.labels?.['com.winwidget.owner'] === target.slug,
		postgresName + ' dedicated network drifted'
	);

	const migrateName = target.slug + '-migrate';
	const migrate = requireService(migrateName);
	const migrateEnvironment = environmentOf(migrateName);
	assert(
		(migrate.profiles ?? []).includes(target.slug + '-migration'),
		migrateName + ' profile drifted'
	);
	assert(
		migrate.image === expected(target.prefix + '_IMAGE'),
		migrateName + ' image drifted'
	);
	assert(
		usesStandaloneBuild(migrate.build, target.slug) &&
			migrate.build?.args?.APP_REVISION ===
				expected(target.prefix + '_REVISION'),
		migrateName + ' standalone build drifted'
	);
	assert(
		normalizeCommand(migrate.entrypoint) === './node_modules/.bin/prisma',
		migrateName + ' entrypoint drifted'
	);
	assert(
		normalizeCommand(migrate.command) ===
			'migrate deploy --schema prisma/schema.prisma',
		migrateName + ' command drifted'
	);
	assert(
		migrateEnvironment[target.migrationEnvironmentKey] ===
			expected(target.migrationKey),
		migrateName + ' database URL drifted'
	);
	assert(
		Object.keys(migrate.depends_on ?? {}).length === 0 &&
			migrate.network_mode === 'host',
		migrateName + ' must not own a database lifecycle'
	);
}

const telegramRuntimeNames = [
	'notification-delivery-worker',
	'identity-api',
	'support-api',
	'support-worker',
	'operations-worker'
];
for (const name of telegramRuntimeNames) {
	const service = requireService(name);
	assert(
		service.environment?.TELEGRAM_API_BASE_URL ===
			'https://tg.winwidget.ru/telegram-api',
		name + ' Telegram relay URL drifted'
	);
	assert(
		JSON.stringify(service.extra_hosts ?? []) ===
			JSON.stringify(['tg.winwidget.ru=185.184.122.62']),
		name + ' Telegram relay host mapping drifted'
	);
}
const operationsApiTelegramEnvironment =
	requireService('operations-api').environment ?? {};
assert(
	operationsApiTelegramEnvironment.TELEGRAM_INFO_BOT_CONFIGURED ===
		'true' &&
		!Object.hasOwn(
			operationsApiTelegramEnvironment,
			'TELEGRAM_INFO_BOT_TOKEN'
		) &&
		!Object.hasOwn(
			operationsApiTelegramEnvironment,
			'TELEGRAM_API_BASE_URL'
		) &&
		JSON.stringify(requireService('operations-api').extra_hosts ?? []) ===
			'[]',
	'operations-api must not receive Telegram transport credentials or routing'
);
for (const slug of [
	'notification-delivery',
	'identity',
	'support',
	'operations'
]) {
	const example = parseExample(`apps/${slug}/.env.example`);
	assert(
		example.get('TELEGRAM_API_BASE_URL') ===
			'https://tg.winwidget.ru/telegram-api' &&
			example.get('TELEGRAM_API_PROXY_IP') === '185.184.122.62',
		slug + ' Telegram relay example drifted'
	);
}

assert(
	!config.secrets?.['core-postgres-admin-password'],
	'Retired Core restore secret must be absent'
);

const rabbit = requireService('rabbitmq');
assert(
	rabbit.image ===
		'rabbitmq:4.2.9-management-alpine@sha256:0ab90fc05c41e9d2d8f11af5036e466c364adf5085ed83c477ab41aec0bdde86',
	'RabbitMQ image drifted'
);
assert(
	(rabbit.ports ?? []).every(
		port =>
			port.host_ip === '127.0.0.1' &&
			['5672', '15672'].includes(String(port.published))
	),
	'RabbitMQ ports must remain loopback-only'
);
const rabbitVolume = config.volumes?.['winwidget-rabbitmq-data'];
assert(
	rabbitVolume?.external === true && rabbitVolume.name,
	'RabbitMQ external volume drifted'
);

const appBuilds = [
	[
		'notification-delivery-worker',
		'notification-delivery',
		'NOTIFICATION_DELIVERY'
	],
	['campaigns-service', 'campaigns', 'CAMPAIGNS'],
	['reporting-service', 'reporting', 'REPORTING'],
	['widgets-service', 'widgets', 'WIDGETS'],
	['billing-api', 'billing', 'BILLING'],
	['identity-api', 'identity', 'IDENTITY'],
	['platform-api', 'platform', 'PLATFORM'],
	['support-api', 'support', 'SUPPORT'],
	['operations-api', 'operations', 'OPERATIONS']
];
for (const [name, slug, prefix] of appBuilds) {
	const service = requireService(name);
	assert(
		service.image === expected(prefix + '_IMAGE'),
		name + ' image drifted'
	);
	assert(
		usesStandaloneBuild(service.build, slug) &&
			service.build?.args?.APP_REVISION === expected(prefix + '_REVISION'),
		name + ' standalone build drifted'
	);
	assert(service.network_mode === 'host', name + ' must use host network');
}

const sharedImageFamilies = [
	[
		'billing',
		[
			'billing-api',
			'billing-scheduler',
			'billing-worker',
			'billing-outbox-publisher'
		]
	],
	[
		'identity',
		['identity-api', 'identity-worker', 'identity-outbox-publisher']
	],
	['platform', ['platform-api', 'platform-outbox-publisher']],
	[
		'support',
		['support-api', 'support-worker', 'support-outbox-publisher']
	],
	[
		'operations',
		[
			'operations-api',
			'operations-worker',
			'operations-restore-worker',
			'operations-outbox-publisher'
		]
	]
];
for (const [owner, names] of sharedImageFamilies) {
	const images = new Set(names.map(name => requireService(name).image));
	assert(
		images.size === 1,
		owner + ' roles must share one immutable image'
	);
	for (const name of names.slice(1)) {
		assert(
			requireService(name).build == null,
			name + ' must reuse the ' + owner + ' image'
		);
	}
}

for (const name of [
	'billing-api',
	'billing-scheduler',
	'billing-worker',
	'billing-outbox-publisher',
	'identity-api',
	'identity-worker',
	'identity-outbox-publisher',
	'platform-api',
	'platform-outbox-publisher',
	'support-api',
	'support-worker',
	'support-outbox-publisher',
	'operations-api',
	'operations-worker',
	'operations-restore-worker',
	'operations-outbox-publisher'
]) {
	requireCommand(name, 'node dist/src/main.js');
}
for (const name of [
	'api-gateway',
	'notification-delivery-worker',
	'campaigns-service',
	'reporting-service',
	'widgets-service'
]) {
	assertNoCommand(name);
}

const gateway = requireService('api-gateway');
const gatewayEnvironment = environmentOf('api-gateway');
assert(
	gatewayEnvironment.GATEWAY_LISTEN_HOST === '127.0.0.1',
	'Gateway listen host drifted'
);
assert(gatewayEnvironment.PORT === '4100', 'Gateway port drifted');
assert(
	!('API_UPSTREAM_URL' in gatewayEnvironment),
	'Gateway monolith fallback must be absent'
);
assert(
	!Object.hasOwn(gateway.depends_on ?? {}, 'api'),
	'Gateway must not depend on Core'
);
for (const dependency of [
	'widgets-service',
	'identity-api',
	'operations-api'
]) {
	assert(
		gateway.depends_on?.[dependency]?.condition === 'service_healthy',
		'Gateway must wait for healthy ' + dependency
	);
}

const route = (id, pathPrefix, port, authPolicy, timeoutMs) => ({
	id,
	pathPrefix,
	upstreamUrl: 'http://127.0.0.1:' + port,
	authPolicy,
	timeoutMs
});
const expectedGatewayRoutes = [
	route('identity-auth', '/api/v1/auth', 4900, 'optional', 60000),
	route('identity-users', '/api/v1/users', 4900, 'optional', 60000),
	route(
		'identity-telegram-auth',
		'/api/v1/telegram-auth',
		4900,
		'optional',
		60000
	),
	route(
		'identity-info-webhook',
		'/api/v1/telegram-bot/webhook',
		4900,
		'optional',
		60000
	),
	route(
		'support-webhook',
		'/api/v1/telegram-bot/support-webhook',
		5100,
		'optional',
		10000
	),
	route('support-admin', '/api/v1/support/admin', 5100, 'required', 60000),
	route('operations-notes', '/api/v1/notes', 5200, 'required', 30000),
	route(
		'operations-admin-event-log',
		'/api/v1/admin-event-log',
		5200,
		'required',
		30000
	),
	route(
		'operations-restores',
		'/api/v1/dev-tools/database-restores',
		5200,
		'required',
		600000
	),
	route(
		'operations-telegram',
		'/api/v1/telegram-bot/admin',
		5200,
		'required',
		600000
	),
	route(
		'operations-messaging',
		'/api/v1/messaging/admin',
		5200,
		'required',
		30000
	),
	route(
		'operations-alerts',
		'/api/v1/admin-alerts',
		5200,
		'required',
		30000
	),
	route(
		'operations-health-admin',
		'/api/v1/health/admin',
		5200,
		'required',
		30000
	),
	route(
		'operations-health-deployment',
		'/api/v1/health/deployment',
		5200,
		'optional',
		30000
	),
	route(
		'platform-site-settings',
		'/api/v1/site-settings',
		5000,
		'optional',
		60000
	),
	route(
		'platform-legal-pages',
		'/api/v1/legal-pages',
		5000,
		'optional',
		60000
	),
	route(
		'platform-home-page-content',
		'/api/v1/home-page-content',
		5000,
		'optional',
		60000
	),
	route('billing-payments', '/api/v1/payments', 4800, 'optional', 30000),
	route(
		'billing-subscriptions',
		'/api/v1/subscriptions',
		4800,
		'optional',
		30000
	),
	route(
		'billing-tariff-prices',
		'/api/v1/tariff-prices',
		4800,
		'optional',
		30000
	),
	route('billing-affiliate', '/api/v1/affiliate', 4800, 'optional', 30000),
	route(
		'billing-settings-public',
		'/api/v1/billing-settings/public',
		4800,
		'optional',
		30000
	),
	route(
		'billing-settings-admin',
		'/api/v1/billing-settings/admin',
		4800,
		'required',
		30000
	),
	route('campaigns', '/api/v1/admin/campaigns', 4500, 'required', 60000),
	route('reporting', '/api/v1/admin/reporting', 4600, 'required', 60000),
	route('widgets-admin', '/api/v1/widgets/admin', 4700, 'required', 60000),
	route('widgets-management', '/api/v1/widgets', 4700, 'required', 60000),
	route('quizzes-management', '/api/v1/quizzes', 4700, 'required', 60000),
	route(
		'callbacks-management',
		'/api/v1/callbacks',
		4700,
		'required',
		60000
	),
	route(
		'countdown-timers-management',
		'/api/v1/countdown-timers',
		4700,
		'required',
		60000
	),
	route(
		'stop-offers-management',
		'/api/v1/stop-offers',
		4700,
		'required',
		60000
	),
	route(
		'online-consultants-management',
		'/api/v1/online-consultants',
		4700,
		'required',
		60000
	),
	route(
		'calculators-management',
		'/api/v1/calculators',
		4700,
		'required',
		60000
	),
	route(
		'widget-settings',
		'/api/v1/widget-settings',
		4700,
		'required',
		60000
	),
	route(
		'widget-runtime',
		'/api/v1/widget-runtime',
		4700,
		'required',
		60000
	),
	route('widget-public', '/api/v1/widget', 4700, 'optional', 60000),
	route('quiz-public', '/api/v1/quiz', 4700, 'optional', 60000),
	route('callback-public', '/api/v1/callback', 4700, 'optional', 60000),
	route(
		'countdown-timer-public',
		'/api/v1/countdown-timer',
		4700,
		'optional',
		60000
	),
	route(
		'stop-offer-public',
		'/api/v1/stop-offer',
		4700,
		'optional',
		60000
	),
	route(
		'online-consultant-public',
		'/api/v1/online-consultant',
		4700,
		'optional',
		60000
	),
	route(
		'calculator-public',
		'/api/v1/calculator',
		4700,
		'optional',
		60000
	),
	route('widget-events', '/api/v1/widget-events', 4700, 'optional', 60000)
];
const gatewayRoutes = JSON.parse(gatewayEnvironment.GATEWAY_ROUTES_JSON);
assert(
	JSON.stringify(gatewayRoutes) === JSON.stringify(expectedGatewayRoutes),
	'Production Gateway route manifest drifted'
);
assert(
	JSON.stringify(JSON.parse(rootExample.get('GATEWAY_ROUTES_JSON'))) ===
		JSON.stringify(expectedGatewayRoutes),
	'.env.example Gateway route manifest drifted'
);
assert(
	JSON.stringify(JSON.parse(gatewayExample.get('GATEWAY_ROUTES_JSON'))) ===
		JSON.stringify(expectedGatewayRoutes),
	'apps/api-gateway/.env.example Gateway route manifest drifted'
);
assert(
	gatewayRoutes.length === 43,
	'Gateway must expose exactly 43 routes'
);
assert(
	gatewayRoutes.filter(
		item => item.upstreamUrl === 'http://127.0.0.1:5200'
	).length === 8,
	'Gateway must expose exactly eight Operations route families'
);
assert(
	gatewayRoutes.every(
		item =>
			item.pathPrefix !== '/api/v1' &&
			!item.pathPrefix.startsWith('/api/v1/internal') &&
			!item.upstreamUrl.includes(':4200')
	),
	'Gateway must not expose Core or internal fallbacks'
);

const notificationEnvironment = environmentOf(
	'notification-delivery-worker'
);
const campaignsEnvironment = environmentOf('campaigns-service');
const reportingEnvironment = environmentOf('reporting-service');
const widgetsEnvironment = environmentOf('widgets-service');
const billingEnvironment = environmentOf('billing-api');
const identityEnvironment = environmentOf('identity-api');
const platformEnvironment = environmentOf('platform-api');
const supportEnvironment = environmentOf('support-api');
const operationsApi = requireService('operations-api');
const operationsWorker = requireService('operations-worker');
const operationsRestoreWorker = requireService(
	'operations-restore-worker'
);
const operationsPublisher = requireService('operations-outbox-publisher');
const operationsApiEnvironment = environmentOf('operations-api');
const operationsWorkerEnvironment = environmentOf('operations-worker');
const operationsRestoreEnvironment = environmentOf(
	'operations-restore-worker'
);
const operationsPublisherEnvironment = environmentOf(
	'operations-outbox-publisher'
);

assert(
	notificationDeliveryExample.get('RECAPTCHA_CLIENT_URL') ===
		rootExample.get('RECAPTCHA_CLIENT_URL') &&
		notificationEnvironment.RECAPTCHA_CLIENT_URL ===
			expected('RECAPTCHA_CLIENT_URL'),
	'Notification Delivery public site URL contract drifted'
);

const mutualToken = (label, left, right) => {
	assert(
		typeof left === 'string' &&
			left.length >= 32 &&
			left === right &&
			!/change_me/i.test(left),
		label + ' token contract drifted'
	);
	return left;
};
const operationsPeerContracts = [
	[
		'Notification Delivery',
		'NOTIFICATION_DELIVERY_INTERNAL_URL',
		'http://127.0.0.1:4401',
		'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
		notificationEnvironment
	],
	[
		'Campaigns',
		'CAMPAIGNS_INTERNAL_BASE_URL',
		'http://127.0.0.1:4500',
		'CAMPAIGNS_OPERATIONS_TOKEN',
		campaignsEnvironment
	],
	[
		'Reporting',
		'REPORTING_INTERNAL_BASE_URL',
		'http://127.0.0.1:4600',
		'REPORTING_OPERATIONS_TOKEN',
		reportingEnvironment
	],
	[
		'Widgets',
		'WIDGETS_INTERNAL_BASE_URL',
		'http://127.0.0.1:4700',
		'WIDGETS_OPERATIONS_TOKEN',
		widgetsEnvironment
	],
	[
		'Billing',
		'BILLING_INTERNAL_BASE_URL',
		'http://127.0.0.1:4800',
		'BILLING_OPERATIONS_TOKEN',
		billingEnvironment
	],
	[
		'Identity',
		'IDENTITY_INTERNAL_BASE_URL',
		'http://127.0.0.1:4900',
		'IDENTITY_OPERATIONS_TOKEN',
		identityEnvironment
	],
	[
		'Platform',
		'PLATFORM_INTERNAL_BASE_URL',
		'http://127.0.0.1:5000',
		'PLATFORM_OPERATIONS_TOKEN',
		platformEnvironment
	],
	[
		'Support',
		'SUPPORT_INTERNAL_BASE_URL',
		'http://127.0.0.1:5100',
		'SUPPORT_OPERATIONS_TOKEN',
		supportEnvironment
	]
];
const operationsScopedTokens = [];
for (const [
	label,
	originKey,
	origin,
	tokenKey,
	peerEnvironment
] of operationsPeerContracts) {
	assert(
		operationsApiEnvironment[originKey] === origin,
		'Operations exact origin drifted: ' + originKey
	);
	operationsScopedTokens.push(
		mutualToken(
			label + ' to Operations',
			operationsApiEnvironment[tokenKey],
			peerEnvironment[tokenKey]
		)
	);
}
assert(
	reportingEnvironment.OPERATIONS_INTERNAL_BASE_URL ===
		'http://127.0.0.1:5200',
	'Reporting must use the exact Operations origin'
);
assert(
	identityEnvironment.OPERATIONS_INTERNAL_BASE_URL ===
		'http://127.0.0.1:5200',
	'Identity must use the exact Operations origin'
);
operationsScopedTokens.push(
	mutualToken(
		'Reporting to Operations',
		operationsApiEnvironment.REPORTING_INTERNAL_TOKEN,
		reportingEnvironment.REPORTING_INTERNAL_TOKEN
	)
);
operationsScopedTokens.push(
	mutualToken(
		'Identity to Operations',
		operationsApiEnvironment.OPERATIONS_IDENTITY_TOKEN,
		identityEnvironment.OPERATIONS_IDENTITY_TOKEN
	)
);
assert(
	new Set(operationsScopedTokens).size === operationsScopedTokens.length,
	'Operations peer tokens must stay direction- and audience-scoped'
);

const operationsRoles = [
	[
		'operations-api',
		operationsApiEnvironment,
		'api',
		'OPERATIONS_API_PORT',
		'5200'
	],
	[
		'operations-worker',
		operationsWorkerEnvironment,
		'worker',
		'OPERATIONS_WORKER_PORT',
		'5201'
	],
	[
		'operations-restore-worker',
		operationsRestoreEnvironment,
		'restore-worker',
		'OPERATIONS_RESTORE_WORKER_PORT',
		'5203'
	],
	[
		'operations-outbox-publisher',
		operationsPublisherEnvironment,
		'outbox-publisher',
		'OPERATIONS_OUTBOX_PUBLISHER_PORT',
		'5202'
	]
];
for (const [
	name,
	environment,
	roleName,
	portKey,
	port
] of operationsRoles) {
	assert(
		environment.APP_REVISION === expected('OPERATIONS_REVISION'),
		name + ' revision drifted'
	);
	assert(
		environment.OPERATIONS_DATABASE_URL ===
			expected('OPERATIONS_DATABASE_URL'),
		name + ' DB URL drifted'
	);
	assert(
		environment.OPERATIONS_PROCESS_ROLE === roleName,
		name + ' process role drifted'
	);
	assert(
		environment.OPERATIONS_LISTEN_HOST === '127.0.0.1',
		name + ' listen host drifted'
	);
	assert(environment[portKey] === port, name + ' port drifted');
}

const backupKeys = databaseTargets.map(target => target.backupKey);
for (const [name, service] of Object.entries(services)) {
	for (const key of backupKeys) {
		assert(
			key in (service.environment ?? {}) ===
				(name === 'operations-worker'),
			key + ' must be scoped only to operations-worker'
		);
	}
}

const validate_operations_database_urls = () => {
	for (const target of databaseTargets) {
		const runtimeValue = environmentOf(target.runtimeService)[
			target.runtimeKey
		];
		const migrationValue = environmentOf(target.slug + '-migrate')[
			target.migrationEnvironmentKey
		];
		const backupValue = operationsWorkerEnvironment[target.backupKey];
		assert(
			runtimeValue === expected(target.runtimeKey),
			target.runtimeKey + ' interpolation drifted'
		);
		assert(
			migrationValue === expected(target.migrationKey),
			target.migrationKey + ' interpolation drifted'
		);
		assert(
			backupValue === expected(target.backupKey),
			target.backupKey + ' interpolation drifted'
		);
		const urls = [
			parseUrl(runtimeValue, target.runtimeKey),
			parseUrl(migrationValue, target.migrationKey),
			parseUrl(backupValue, target.backupKey)
		];
		for (const url of urls) {
			assert(
				url.protocol === 'postgresql:' &&
					url.hostname === '127.0.0.1' &&
					url.port === target.port &&
					url.pathname === '/' + target.database &&
					url.searchParams.get('schema') === target.schema &&
					url.searchParams.get('sslmode') === 'disable',
				target.slug + ' database endpoint drifted'
			);
		}
		assert(
			JSON.stringify(urls.map(url => decodeURIComponent(url.username))) ===
				JSON.stringify([
					target.database + '_runtime',
					target.database + '_migration',
					target.database + '_backup'
				]),
			target.slug + ' database roles drifted'
		);
		assert(
			new Set(urls.map(url => decodeURIComponent(url.password))).size ===
				3,
			target.slug + ' runtime/migration/backup passwords must be distinct'
		);
	}
};
validate_operations_database_urls();

assert(
	(operationsWorker.volumes ?? []).length === 0 &&
		!Object.keys(operationsWorkerEnvironment).some(key =>
			key.startsWith('DATABASE_RESTORE_')
		),
	'operations-worker must not receive restore storage or credentials'
);
assert(
	operationsApiEnvironment.DATABASE_RESTORE_ENABLED ===
		expected('DATABASE_RESTORE_ENABLED') &&
		operationsApiEnvironment.DATABASE_RESTORE_STORAGE_DIR ===
			'/var/lib/winwidget-operations/restores',
	'operations-api restore enqueue boundary drifted'
);

const restoreBaseKeys = [
	'APP_REVISION',
	'NODE_ENV',
	'MODE',
	'OPERATIONS_DATABASE_URL',
	'OPERATIONS_LISTEN_HOST',
	'OPERATIONS_RESTORE_WORKER_PORT',
	'OPERATIONS_PROCESS_ROLE',
	'RABBITMQ_URL',
	'RABBITMQ_CONNECTION_NAME',
	'RABBITMQ_ASSERT_TOPOLOGY',
	'RABBITMQ_MAX_MESSAGE_BYTES',
	'DATABASE_RESTORE_STORAGE_DIR'
];
const restoreCredentialKeys = databaseTargets.flatMap(target => [
	target.prefix + '_POSTGRES_ADMIN_USER',
	target.prefix + '_POSTGRES_PORT',
	'DATABASE_RESTORE_' + target.prefix + '_ADMIN_PASSWORD_FILE'
]);
assertExactKeys(
	operationsRestoreEnvironment,
	[...restoreBaseKeys, ...restoreCredentialKeys],
	'operations-restore-worker environment'
);
for (const target of databaseTargets) {
	assert(
		operationsRestoreEnvironment[
			target.prefix + '_POSTGRES_ADMIN_USER'
		] === expected(target.prefix + '_POSTGRES_ADMIN_USER'),
		target.slug + ' restore admin user drifted'
	);
	assert(
		operationsRestoreEnvironment[target.prefix + '_POSTGRES_PORT'] ===
			target.port,
		target.slug + ' restore port drifted'
	);
	assert(
		operationsRestoreEnvironment[
			'DATABASE_RESTORE_' + target.prefix + '_ADMIN_PASSWORD_FILE'
		] ===
			'/run/secrets/database-restore-' + target.slug + '-admin-password',
		target.slug + ' restore password file drifted'
	);
	assert(
		!(
			'DATABASE_RESTORE_' + target.prefix + '_ADMIN_URL' in
			operationsRestoreEnvironment
		),
		target.slug + ' restore admin URL must be absent'
	);
}
assert(
	operationsRestoreEnvironment.RABBITMQ_URL ===
		expected('RABBITMQ_OPERATIONS_RESTORE_WORKER_URL') &&
		operationsRestoreEnvironment.RABBITMQ_CONNECTION_NAME ===
			'winwidget-operations-restore-worker' &&
		operationsRestoreEnvironment.RABBITMQ_ASSERT_TOPOLOGY === 'true',
	'operations-restore-worker RabbitMQ contract drifted'
);
assert(
	!('TELEGRAM_INFO_BOT_TOKEN' in operationsRestoreEnvironment),
	'restore-worker must not receive Telegram token'
);

const expectedRestoreSecrets = databaseTargets
	.map(target => [
		target.slug + '-postgres-admin-password',
		'database-restore-' + target.slug + '-admin-password'
	])
	.sort(([left], [right]) => left.localeCompare(right));
const actualRestoreSecrets = (operationsRestoreWorker.secrets ?? [])
	.map(secret => [secret.source, secret.target])
	.sort(([left], [right]) => left.localeCompare(right));
assert(
	JSON.stringify(actualRestoreSecrets) ===
		JSON.stringify(expectedRestoreSecrets),
	'operations-restore-worker secret mount set drifted'
);

const assertRestoreMount = (service, name) => {
	const mounts = service.volumes ?? [];
	assert(
		mounts.length === 1 &&
			mounts[0].type === 'bind' &&
			mounts[0].source === expected('DATABASE_RESTORE_STORAGE_DIR') &&
			mounts[0].target === '/var/lib/winwidget-operations/restores',
		name + ' restore bind drifted'
	);
};
assertRestoreMount(operationsApi, 'operations-api');
assertRestoreMount(operationsRestoreWorker, 'operations-restore-worker');
for (const [name, service] of Object.entries(services)) {
	if (name === 'operations-api' || name === 'operations-restore-worker')
		continue;
	assert(
		!(service.volumes ?? []).some(
			mount =>
				mount.source === expected('DATABASE_RESTORE_STORAGE_DIR') ||
				mount.target === '/var/lib/winwidget-operations/restores'
		),
		name + ' must not mount Operations restore storage'
	);
}

const restoreTmpfs = (operationsRestoreWorker.tmpfs ?? []).map(String);
assert(
	operationsRestoreWorker.read_only === true,
	'operations-restore-worker must be read-only'
);
assert(
	operationsRestoreWorker.init === true,
	'operations-restore-worker must run with init'
);
assert(
	JSON.stringify(operationsRestoreWorker.security_opt ?? []) ===
		JSON.stringify(['no-new-privileges:true']),
	'operations-restore-worker no-new-privileges drifted'
);
assert(
	JSON.stringify(sorted(operationsRestoreWorker.cap_drop ?? [])) ===
		JSON.stringify(['ALL']) &&
		(operationsRestoreWorker.cap_add ?? []).length === 0,
	'operations-restore-worker Linux capabilities drifted'
);
assert(
	restoreTmpfs.some(
		value =>
			value.startsWith('/tmp:') &&
			value.includes('noexec') &&
			value.includes('nosuid') &&
			value.includes('nodev') &&
			value.includes('size=64m') &&
			value.includes('mode=1777')
	),
	'operations-restore-worker tmpfs hardening drifted'
);
assert(
	operationsRestoreWorker.depends_on?.rabbitmq?.condition ===
		'service_healthy' &&
		operationsRestoreWorker.depends_on?.['operations-outbox-publisher']
			?.condition === 'service_started',
	'operations-restore-worker dependencies drifted'
);
assert(
	JSON.stringify(operationsRestoreWorker.healthcheck?.test ?? []).includes(
		'OPERATIONS_RESTORE_WORKER_PORT||5203'
	),
	'operations-restore-worker readiness drifted'
);
assert(
	operationsRestoreWorker.stop_grace_period === '1m30s',
	'restore-worker stop grace drifted'
);
assert(
	operationsRestoreWorker.restart === 'unless-stopped',
	'restore-worker restart policy drifted'
);

for (const [name, service] of Object.entries(services)) {
	if (
		name.endsWith('-postgres') ||
		name === 'operations-restore-worker' ||
		(service.profiles ?? []).length > 0
	) {
		continue;
	}
	for (const key of Object.keys(service.environment ?? {})) {
		assert(
			!key.includes('POSTGRES_ADMIN') &&
				!key.endsWith('_ADMIN_URL') &&
				!key.endsWith('_ADMIN_PASSWORD_FILE'),
			name + ' must not receive privileged DB setting ' + key
		);
	}
}

const rabbitContracts = [
	['notification-delivery-worker', 'true'],
	['campaigns-service', 'true'],
	['reporting-service', 'true'],
	['widgets-service', 'true'],
	['billing-worker', 'true'],
	['billing-outbox-publisher', 'false'],
	['identity-worker', 'true'],
	['identity-outbox-publisher', 'false'],
	['platform-outbox-publisher', 'false'],
	['support-worker', 'true'],
	['support-outbox-publisher', 'false'],
	['operations-worker', 'true'],
	['operations-restore-worker', 'true'],
	['operations-outbox-publisher', 'false']
];
const rabbitUsers = [
	rabbit.environment?.RABBITMQ_DEFAULT_USER,
	operationsApiEnvironment.RABBITMQ_MONITOR_USER
];
for (const [name, topology] of rabbitContracts) {
	const environment = environmentOf(name);
	const url = parseUrl(environment.RABBITMQ_URL, name + ' RABBITMQ_URL');
	assert(url.pathname === '/winwidget', name + ' RabbitMQ vhost drifted');
	assert(
		environment.RABBITMQ_ASSERT_TOPOLOGY === topology,
		name + ' topology assertion drifted'
	);
	rabbitUsers.push(url.username);
}
assert(
	operationsRestoreEnvironment.RABBITMQ_CONNECTION_NAME ===
		'winwidget-operations-restore-worker' &&
		parseUrl(
			operationsRestoreEnvironment.RABBITMQ_URL,
			'operations-restore-worker RABBITMQ_URL'
		).username === 'winwidget-operations-restore-worker',
	'operations-restore-worker must use its dedicated RabbitMQ identity'
);
assert(
	rabbit.environment?.RABBITMQ_DEFAULT_VHOST === 'winwidget' &&
		operationsApiEnvironment.RABBITMQ_VHOST === 'winwidget' &&
		rabbitUsers.every(Boolean) &&
		new Set(rabbitUsers).size === rabbitUsers.length &&
		rabbitUsers.every(
			user =>
				![
					'winwidget-publisher',
					'winwidget-integration',
					'winwidget-maintenance'
				].includes(user)
		),
	'RabbitMQ admin, monitor and service identities must be distinct and Core-free'
);

const telegramProxyServices = [
	'notification-delivery-worker',
	'identity-api',
	'support-api',
	'support-worker',
	'operations-worker'
];
for (const name of telegramProxyServices) {
	const service = requireService(name);
	const entry = (service.extra_hosts ?? []).find(item =>
		item.startsWith('tg.winwidget.ru=')
	);
	assert(
		entry === 'tg.winwidget.ru=' + expected('TELEGRAM_API_PROXY_IP'),
		name + ' must route Telegram through the configured proxy'
	);
	assert(
		environmentOf(name).TELEGRAM_API_BASE_URL ===
			expected('TELEGRAM_API_BASE_URL'),
		name + ' Telegram origin drifted'
	);
}
assert(
	operationsApiEnvironment.TELEGRAM_INFO_BOT_CONFIGURED === 'true' &&
		!Object.hasOwn(operationsApiEnvironment, 'TELEGRAM_INFO_BOT_TOKEN') &&
		!Object.hasOwn(operationsApiEnvironment, 'TELEGRAM_API_BASE_URL') &&
		JSON.stringify(operationsApi.extra_hosts ?? []) === '[]',
	'operations-api Telegram least-privilege boundary drifted'
);

const operationsDockerfile = readFileSync(
	resolve(process.cwd(), 'apps/operations/Dockerfile'),
	'utf8'
);
assert(
	operationsDockerfile.includes('postgresql-client-18') &&
		operationsDockerfile.includes('pg_dump --version') &&
		operationsDockerfile.includes('pg_restore --version'),
	'Operations image must pin and verify PostgreSQL client 18'
);

process.stdout.write('Production Compose apps-only contract is valid.\n');
