import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Local shape validation only. No Docker mutation, provisioning or release approval.
export const CRM_SERVICES = [
	[
		'crm-access',
		'crm_access',
		55442,
		32,
		[
			['api', 5300, 5],
			['worker', 5301, 4],
			['outbox-publisher', 5302, 1]
		]
	],
	[
		'crm-intake',
		'crm_intake',
		55443,
		48,
		[
			['api', 5310, 5],
			['worker', 5311, 4],
			['publisher', 5312, 1],
			['widget-control-worker', 5313, 4],
			['widget-control-publisher', 5314, 1],
			['widget-transfer-worker', 5315, 4],
			['widget-transfer-publisher', 5316, 1]
		]
	],
	['crm-customers', 'crm_customers', 55444, 16, [['api', 5320, 5]]],
	['crm-sales', 'crm_sales', 55445, 16, [['api', 5330, 5]]]
];
const tokenNames = {
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
};
const origins = {
	'crm-access': {
		IDENTITY_INTERNAL_BASE_URL: 4900,
		BILLING_INTERNAL_BASE_URL: 4800,
		CRM_SALES_INTERNAL_BASE_URL: 5330
	},
	'crm-intake': {
		CRM_ACCESS_INTERNAL_BASE_URL: 5300,
		CRM_CUSTOMERS_INTERNAL_BASE_URL: 5320,
		CRM_SALES_INTERNAL_BASE_URL: 5330,
		WIDGETS_INTERNAL_BASE_URL: 4700
	},
	'crm-customers': {
		CRM_ACCESS_INTERNAL_BASE_URL: 5300
	},
	'crm-sales': {
		CRM_ACCESS_INTERNAL_BASE_URL: 5300,
		CRM_CUSTOMERS_INTERNAL_BASE_URL: 5320
	}
};

const check = (condition, message) => {
	if (!condition) throw new Error(message);
};
const same = (actual, expected, message) =>
	check(isDeepStrictEqual(actual, expected), message);
const keys = value => Object.keys(value ?? {}).sort();
const exactKeys = (value, expected, message) =>
	same(keys(value), [...expected].sort(), message);
const parseUrl = value => {
	try {
		return new URL(value);
	} catch {
		throw new Error('Invalid CRM endpoint');
	}
};
const strong = value =>
	typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value);
const immutableImage = value =>
	typeof value === 'string' &&
	/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(value);
const bytes = value => Number.isSafeInteger(value) && value > 0;
const upper = value => value.toUpperCase().replaceAll('-', '_');

function checkResources(service) {
	check(bytes(service.mem_limit), 'A measured memory cap is required');
	same(
		service.memswap_limit,
		service.mem_limit,
		'CRM must not rely on swap'
	);
	const cpus = Number(service.cpus);
	check(
		Number.isFinite(cpus) && cpus > 0,
		'An explicit CPU cap is required'
	);
	same(
		service.logging,
		{
			driver: 'json-file',
			options: { 'max-size': '10m', 'max-file': '3' }
		},
		'Bounded CRM logging is required'
	);
}

function checkProcess(service, app, purpose, migration = false) {
	const common = [
		'image',
		'profiles',
		'network_mode',
		'user',
		'read_only',
		'tmpfs',
		'cap_drop',
		'security_opt',
		'pids_limit',
		'init',
		'restart',
		'stop_grace_period',
		'logging',
		'labels',
		'environment',
		'mem_limit',
		'memswap_limit',
		'cpus'
	];
	exactKeys(
		service,
		[
			...common,
			...(migration ? ['entrypoint', 'command'] : ['healthcheck'])
		],
		'Unexpected CRM process configuration or privilege'
	);
	check(immutableImage(service.image), 'CRM image must be immutable');
	same(
		service.labels,
		{
			'com.winwidget.owner': app,
			'com.winwidget.purpose': purpose,
			...(migration ? {} : { 'com.winwidget.singleton': 'true' })
		},
		'CRM process ownership differs'
	);
	same(
		service.profiles,
		[migration ? 'crm-migrations' : 'crm-runtime'],
		'CRM must remain opt-in'
	);
	same(
		service.network_mode,
		'host',
		'CRM same-VPS process must use private loopback'
	);
	same(
		service.user,
		'1001:1001',
		'CRM must run as its non-root image user'
	);
	same(service.read_only, true, 'CRM root filesystem must be read-only');
	same(
		service.tmpfs,
		['/tmp:rw,nosuid,nodev,noexec,size=64m'],
		'Unexpected CRM writable mount'
	);
	same(service.cap_drop, ['ALL'], 'CRM capabilities must be dropped');
	same(
		service.security_opt,
		['no-new-privileges:true'],
		'CRM privilege escalation must be disabled'
	);
	same(service.pids_limit, 128, 'CRM PID cap differs');
	same(service.init, true, 'CRM PID reaping is required');
	same(
		service.restart,
		migration ? 'no' : 'unless-stopped',
		'CRM restart policy differs'
	);
	same(
		service.stop_grace_period,
		migration ? '1m0s' : '45s',
		'CRM graceful shutdown budget differs'
	);
	checkResources(service);
}

function checkDatabaseUrl(value, schema, port, pool, migration) {
	const url = parseUrl(value);
	const role =
		'winwidget_' + schema + (migration ? '_migration' : '_runtime');
	check(strong(url.password), 'CRM database password must be strong');
	same(
		value,
		'postgresql://' +
			role +
			':' +
			url.password +
			'@127.0.0.1:' +
			port +
			'/winwidget_' +
			schema +
			'?schema=' +
			schema +
			'&sslmode=disable&connection_limit=' +
			pool +
			'&pool_timeout=10',
		'CRM database URL must target its own role/schema with a bounded pool'
	);
	return url.password;
}

// Validate only the existing services' CRM environment wiring. This does not
// validate private file provenance, deployed revisions or approve a rollout.
export function validateCrmCompanionCompose(config, source) {
	// Operations backup URLs have a separate exact endpoint validator. They do
	// not give this companion check ownership of CRM databases or restore roles.
	const backupOnlyKeys = [
		'CRM_ACCESS_BACKUP_URL',
		'CRM_INTAKE_BACKUP_URL',
		'CRM_CUSTOMERS_BACKUP_URL',
		'CRM_SALES_BACKUP_URL'
	];
	const targets = {
		IDENTITY_CRM_ACCESS_TOKEN: ['identity-api'],
		IDENTITY_NOTIFICATION_DELIVERY_TOKEN: [
			'identity-api',
			'notification-delivery-worker'
		],
		WINCRM_INVITATION_EMAIL_ENABLED: ['identity-api'],
		BILLING_CRM_ACCESS_TOKEN: ['billing-api'],
		BILLING_WINCRM_PAYMENTS_ENABLED: [
			'billing-api',
			'billing-worker',
			'billing-scheduler'
		],
		BILLING_WINCRM_RECONCILIATION_ENABLED: [
			'billing-worker',
			'billing-scheduler'
		],
		BILLING_WINCRM_FRONTEND_ORIGIN: ['billing-api', 'billing-worker'],
		BILLING_CRM_ACCESS_COMMERCE_BASE_URL: ['billing-worker'],
		BILLING_CRM_ACCESS_COMMERCE_TOKEN: ['billing-worker'],
		BILLING_WINCRM_PROVIDER_RABBITMQ_URL: ['billing-worker'],
		BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY: ['billing-worker'],
		BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: ['billing-api'],
		BILLING_WINCRM_WIDGETS_TOKEN: ['billing-api', 'widgets-service'],
		BILLING_WINCRM_CRM_INTAKE_TOKEN: ['billing-api'],
		WIDGETS_WINCRM_CONNECTOR_ENABLED: ['widgets-service'],
		WIDGETS_CRM_INTAKE_TOKEN: ['widgets-service'],
		WIDGETS_WINCRM_HTTP_TIMEOUT_MS: ['widgets-service']
	};
	check(
		config?.name === 'winwidget' && config.services && source,
		'Invalid CRM companion inputs'
	);
	if (
		backupOnlyKeys.some(
			key =>
				Object.hasOwn(source, key) ||
				Object.hasOwn(
					config.services['operations-worker']?.environment ?? {},
					key
				)
		)
	) {
		for (const key of backupOnlyKeys) targets[key] = ['operations-worker'];
	}
	for (const [key, names] of Object.entries(targets)) {
		// New backup-only placeholders may be absent from an older canonical env.
		// The Operations admission validator still requires all four exact URLs.
		const expected =
			backupOnlyKeys.includes(key) && source[key] === undefined
				? ''
				: source[key];
		check(
			typeof expected === 'string',
			'Missing canonical CRM companion setting'
		);
		for (const name of names)
			same(
				config.services[name]?.environment?.[key],
				expected,
				'CRM companion environment differs'
			);
	}
	for (const [name, service] of Object.entries(config.services))
		for (const key of Object.keys(service.environment ?? {}))
			if (
				/CRM/.test(key) ||
				key === 'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
			)
				check(
					targets[key]?.includes(name),
					'CRM setting escaped its process role'
				);
	for (const name of ['notification-delivery-worker', 'widgets-service']) {
		const key =
			name === 'widgets-service'
				? 'BILLING_INTERNAL_BASE_URL'
				: 'IDENTITY_INTERNAL_BASE_URL';
		same(
			config.services[name].environment[key],
			source[key],
			'CRM dependency origin differs'
		);
	}
	same(
		source.BILLING_WINCRM_PROVIDER_ASSERT_TOPOLOGY,
		'false',
		'Runtime cannot provision the CRM provider topology'
	);
	const enabled = key => {
		check(
			['false', 'true'].includes(source[key]),
			'Invalid CRM companion switch'
		);
		return source[key] === 'true';
	};
	const payments = enabled('BILLING_WINCRM_PAYMENTS_ENABLED');
	const reconciliation = enabled('BILLING_WINCRM_RECONCILIATION_ENABLED');
	const brokerConfigured = Boolean(
		source.BILLING_WINCRM_PROVIDER_RABBITMQ_URL
	);
	check(
		!brokerConfigured || reconciliation,
		'Provider drain requires credential-free scheduler reconciliation'
	);
	const widgets = enabled('WIDGETS_WINCRM_CONNECTOR_ENABLED');
	const eligibility = enabled(
		'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED'
	);
	const email = enabled('WINCRM_INVITATION_EMAIL_ENABLED');
	const kinds = source.NOTIFICATION_DELIVERY_KINDS?.split(',');
	same(
		config.services['notification-delivery-worker'].environment
			.NOTIFICATION_DELIVERY_KINDS,
		source.NOTIFICATION_DELIVERY_KINDS,
		'Invitation reader set differs from canonical configuration'
	);
	check(
		Array.isArray(kinds) && new Set(kinds).size === kinds.length,
		'Invalid notification reader set'
	);
	const reader = kinds.includes('wincrm-invitation-email');
	check(!email || reader, 'Invitation producer requires its reader');
	check(
		!widgets || eligibility,
		'Widgets connector requires Billing eligibility'
	);
	check(
		!payments || reconciliation,
		'Paid CRM requires durable reconciliation after sales close'
	);
	check(
		['disabled', 'mvp-v1'].includes(source.CRM_RABBITMQ_CONTRACT),
		'Invalid CRM broker contract'
	);
	if (
		payments ||
		reconciliation ||
		widgets ||
		eligibility ||
		email ||
		reader
	)
		same(
			source.CRM_RABBITMQ_CONTRACT,
			'mvp-v1',
			'CRM activation requires the full broker contract'
		);
	const secret = key =>
		check(
			strong(source[key]),
			'CRM companion requires a separately provisioned secret'
		);
	if (payments || reconciliation) {
		const url = parseUrl(source.BILLING_WINCRM_PROVIDER_RABBITMQ_URL);
		check(
			url.protocol === 'amqp:' &&
				url.hostname === '127.0.0.1' &&
				(url.port === '' || url.port === '5672') &&
				url.pathname === '/winwidget' &&
				url.username === 'winwidget-billing-wincrm-provider-worker' &&
				strong(url.password) &&
				!url.search &&
				!url.hash,
			'Billing requires its process-scoped local broker credential'
		);
	}
	if (payments) {
		same(
			source.BILLING_CRM_ACCESS_COMMERCE_BASE_URL,
			'http://127.0.0.1:5300',
			'Billing payment authority origin differs'
		);
		secret('BILLING_CRM_ACCESS_COMMERCE_TOKEN');
	}
	if (widgets) secret('WIDGETS_CRM_INTAKE_TOKEN');
	if (eligibility) {
		secret('BILLING_WINCRM_WIDGETS_TOKEN');
		secret('BILLING_WINCRM_CRM_INTAKE_TOKEN');
	}
	if (email || reader) secret('IDENTITY_NOTIFICATION_DELIVERY_TOKEN');
	const activeTokens = Object.keys(targets)
		.filter(key => key.endsWith('_TOKEN') && source[key])
		.map(key => source[key]);
	check(
		new Set(activeTokens).size === activeTokens.length,
		'CRM companion secrets must be pairwise distinct'
	);
	return {
		wiringVerified: true,
		credentialsProvisioned: false,
		releaseApproved: false
	};
}

export function validateCrmCompose(config) {
	check(
		config && typeof config === 'object',
		'Missing CRM Compose configuration'
	);
	// Compose versions may materialize absent image defaults as explicit null.
	config = {
		...config,
		services: Object.fromEntries(
			Object.entries(config.services ?? {}).map(([name, service]) => [
				name,
				Object.fromEntries(
					Object.entries(service)
						.filter(
							([key, value]) =>
								!(
									['command', 'entrypoint'].includes(key) && value === null
								)
						)
						.map(([key, value]) => [
							key,
							['mem_limit', 'memswap_limit', 'shm_size'].includes(key) &&
							typeof value === 'string' &&
							/^[0-9]+$/.test(value)
								? Number(value)
								: value
						])
				)
			])
		)
	};
	exactKeys(
		Object.fromEntries(
			Object.entries(config).filter(([key]) => !key.startsWith('x-'))
		),
		['name', 'services', 'networks', 'volumes', 'secrets'],
		'Unexpected CRM project configuration'
	);
	same(
		config.name,
		'winwidget-crm',
		'CRM must use a separate Compose project'
	);
	const expectedServices = CRM_SERVICES.flatMap(([app, , , , roles]) => [
		...roles.map(([role]) => app + '-' + role),
		app + '-migrate',
		app + '-postgres'
	]);
	exactKeys(
		config.services,
		expectedServices,
		'CRM requires exactly twelve processes and four own databases/migrations'
	);
	exactKeys(
		config.networks,
		CRM_SERVICES.map(([app]) => app + '-postgres'),
		'CRM networks are not isolated'
	);
	exactKeys(
		config.volumes,
		CRM_SERVICES.map(([app]) => app + '-postgres-data'),
		'CRM volumes are not isolated'
	);
	exactKeys(
		config.secrets,
		CRM_SERVICES.map(([app]) => app + '-postgres-admin-password'),
		'Unexpected CRM secret mount'
	);
	const pairwise = new Map();
	const passwords = new Set();
	const addPassword = password => {
		check(!passwords.has(password), 'CRM credentials must be independent');
		passwords.add(password);
	};
	const imageIds = new Set();
	let runtimeConnections = 0;
	let runtimeMemoryBytes = 0;
	let databaseMemoryBytes = 0;
	let maxMigrationMemoryBytes = 0;
	for (const [
		app,
		schema,
		dbPort,
		maxConnections,
		roles
	] of CRM_SERVICES) {
		const prefix = upper(app);
		let runtimePassword;
		const first = config.services[app + '-api'];
		check(first && first.environment, 'Missing CRM API environment');
		const revision = first.environment.APP_REVISION;
		check(
			/^[a-f0-9]{40}$/.test(revision),
			'CRM revision must be an exact commit'
		);
		check(
			!imageIds.has(first.image),
			'Each CRM service needs its own image'
		);
		imageIds.add(first.image);
		for (const [role, port, pool] of roles) {
			const service = config.services[app + '-' + role];
			checkProcess(service, app, role);
			same(
				service.image,
				first.image,
				'Roles of one CRM service must use the same image'
			);
			const env = service.environment;
			const envKeys = [
				'NODE_ENV',
				'MODE',
				'APP_REVISION',
				prefix + '_LISTEN_HOST',
				prefix + '_PROCESS_ROLE',
				prefix + '_PORT',
				prefix + '_DATABASE_URL',
				'CORS_ALLOWED_ORIGINS',
				...Object.keys(origins[app]),
				...tokenNames[app],
				...(app === 'crm-customers' && role === 'api'
					? ['CRM_CUSTOMERS_DADATA_API_KEY']
					: []),
				...(app === 'crm-access'
					? [
							'TRUST_PROXY',
							'CRM_ACCESS_BILLING_ENABLED',
							'CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY'
						]
					: []),
				...(app === 'crm-intake'
					? [
							'CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY',
							'CRM_INTAKE_WIDGETS_ENABLED',
							'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED'
						]
					: []),
				...(role !== 'api'
					? app === 'crm-access'
						? ['RABBITMQ_URL', 'RABBITMQ_CONNECTION_NAME']
						: ['CRM_INTAKE_RABBITMQ_URL']
					: [])
			];
			exactKeys(
				env,
				envKeys,
				'CRM process received an unexpected credential or setting'
			);
			if (app === 'crm-customers' && role === 'api') {
				const key = env.CRM_CUSTOMERS_DADATA_API_KEY;
				check(
					typeof key === 'string' &&
						(key === '' ||
							(key.length <= 512 &&
								!/[\x00-\x20\x7f-\uffff]/.test(key) &&
								!/^(?:change|replace|example|placeholder)/i.test(key))),
					'Invalid optional Customers lookup credential'
				);
			}
			same(env.NODE_ENV, 'production', 'CRM NODE_ENV must be production');
			same(env.MODE, 'production', 'CRM MODE must be production');
			same(env.APP_REVISION, revision, 'CRM role revision drift');
			same(
				env[prefix + '_LISTEN_HOST'],
				'127.0.0.1',
				'CRM must not listen publicly'
			);
			same(
				env[prefix + '_PROCESS_ROLE'],
				role,
				'CRM role must be split, never all'
			);
			same(
				env[prefix + '_PORT'],
				String(port),
				'CRM canonical role port differs'
			);
			same(
				env.CORS_ALLOWED_ORIGINS,
				role === 'api'
					? 'https://crm.winwidget.ru,https://winwidget.ru'
					: 'https://crm.winwidget.ru',
				'Unexpected CRM origin'
			);
			for (const [key, dependencyPort] of Object.entries(origins[app])) {
				same(
					env[key],
					'http://127.0.0.1:' + dependencyPort,
					'Same-VPS CRM dependency origin differs'
				);
			}
			for (const key of tokenNames[app]) {
				check(strong(env[key]), 'CRM pairwise token must be strong');
				if (pairwise.has(key))
					same(
						env[key],
						pairwise.get(key),
						'CRM pairwise credential mismatch'
					);
				else {
					pairwise.set(key, env[key]);
					addPassword(env[key]);
				}
			}
			if (app === 'crm-access') {
				same(
					env.CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY,
					'false',
					'CRM Access must use pre-provisioned topology'
				);
				same(env.TRUST_PROXY, 'loopback', 'Unexpected CRM trusted proxy');
				check(
					['false', 'true'].includes(env.CRM_ACCESS_BILLING_ENABLED),
					'Invalid CRM commerce gate'
				);
				same(
					env.CRM_ACCESS_BILLING_ENABLED,
					first.environment.CRM_ACCESS_BILLING_ENABLED,
					'CRM commerce gate differs between roles'
				);
			}
			if (app === 'crm-intake') {
				same(
					env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY,
					'false',
					'CRM Intake must use pre-provisioned topology'
				);
				for (const key of [
					'CRM_INTAKE_WIDGETS_ENABLED',
					'CRM_INTAKE_WIDGET_TRANSFERS_ENABLED'
				]) {
					check(
						['false', 'true'].includes(env[key]),
						'Invalid CRM connector gate'
					);
					same(
						env[key],
						(role.startsWith('widget-') &&
							key === 'CRM_INTAKE_WIDGETS_ENABLED') ||
							role.startsWith('widget-transfer-')
							? 'true'
							: role.startsWith('widget-control-')
								? 'false'
								: first.environment[key],
						'CRM connector consumer readiness differs from its role contract'
					);
				}
				check(
					env.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED !== 'true' ||
						env.CRM_INTAKE_WIDGETS_ENABLED === 'true',
					'CRM transfers require managed connector gate'
				);
			}
			const password = checkDatabaseUrl(
				env[prefix + '_DATABASE_URL'],
				schema,
				dbPort,
				pool,
				false
			);
			if (runtimePassword)
				same(
					password,
					runtimePassword,
					'CRM own runtime credential mismatch'
				);
			else {
				runtimePassword = password;
				addPassword(password);
			}
			if (role !== 'api') {
				const url = parseUrl(
					env[
						app === 'crm-access'
							? 'RABBITMQ_URL'
							: 'CRM_INTAKE_RABBITMQ_URL'
					]
				);
				same(
					url.protocol,
					'amqp:',
					'Same-VPS broker must use loopback AMQP'
				);
				same(url.hostname, '127.0.0.1', 'CRM broker must not be public');
				same(url.port, '5672', 'Unexpected CRM broker port');
				same(
					url.pathname,
					'/winwidget',
					'CRM must use the existing event vhost'
				);
				same(
					url.username,
					'winwidget-' + app + '-' + role,
					'CRM broker principal must be process-scoped'
				);
				check(
					strong(url.password) && !url.search && !url.hash,
					'Invalid CRM broker credential'
				);
				addPassword(url.password);
				if (app === 'crm-access')
					same(
						env.RABBITMQ_CONNECTION_NAME,
						url.username,
						'CRM connection name differs'
					);
			}
			same(
				service.healthcheck,
				{
					test: [
						'CMD',
						'node',
						'-e',
						"fetch('http://127.0.0.1:" +
							port +
							"/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
					],
					interval: '10s',
					timeout: '3s',
					retries: 6,
					start_period: '45s'
				},
				'CRM readiness must check the actual role'
			);
			runtimeConnections += pool;
			runtimeMemoryBytes += service.mem_limit;
		}
		const migration = config.services[app + '-migrate'];
		checkProcess(migration, app, 'migration', true);
		same(
			migration.image,
			first.image,
			'CRM migration must use the exact runtime image'
		);
		exactKeys(
			migration.environment,
			['NODE_ENV', 'MODE', 'APP_REVISION', prefix + '_DATABASE_URL'],
			'Migration must not receive runtime tokens'
		);
		same(
			migration.environment.NODE_ENV,
			'production',
			'Migration NODE_ENV differs'
		);
		same(
			migration.environment.MODE,
			'production',
			'Migration MODE differs'
		);
		same(
			migration.environment.APP_REVISION,
			revision,
			'Migration revision drift'
		);
		addPassword(
			checkDatabaseUrl(
				migration.environment[prefix + '_DATABASE_URL'],
				schema,
				dbPort,
				1,
				true
			)
		);
		same(
			migration.entrypoint,
			['./node_modules/.bin/prisma'],
			'Unexpected CRM migration entrypoint'
		);
		same(
			migration.command,
			['migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
			'Unexpected CRM migration command'
		);
		maxMigrationMemoryBytes = Math.max(
			maxMigrationMemoryBytes,
			migration.mem_limit
		);

		const database = config.services[app + '-postgres'];
		exactKeys(
			database,
			[
				'profiles',
				'image',
				'restart',
				'stop_grace_period',
				'shm_size',
				'mem_limit',
				'memswap_limit',
				'cpus',
				'pids_limit',
				'logging',
				'healthcheck',
				'labels',
				'environment',
				'command',
				'ports',
				'volumes',
				'networks',
				'secrets'
			],
			'Unexpected CRM database configuration'
		);
		check(
			/^postgres:18(?:[.][0-9]+)?(?:-[a-z0-9-]+)?@sha256:[a-f0-9]{64}$/.test(
				database.image
			),
			'CRM PostgreSQL 18 must be digest-pinned'
		);
		same(
			database.labels,
			{ 'com.winwidget.owner': app, 'com.winwidget.purpose': 'postgres' },
			'CRM database owner differs'
		);
		same(
			database.profiles,
			['crm-databases'],
			'CRM database must remain opt-in'
		);
		same(
			database.restart,
			'unless-stopped',
			'CRM PostgreSQL restart policy differs'
		);
		same(
			database.stop_grace_period,
			'1m0s',
			'CRM PostgreSQL shutdown budget differs'
		);
		same(database.pids_limit, 200, 'CRM PostgreSQL PID cap differs');
		checkResources(database);
		check(
			bytes(database.shm_size) && database.shm_size <= database.mem_limit,
			'CRM shared memory exceeds its database budget'
		);
		same(
			database.environment,
			{
				POSTGRES_DB: 'winwidget_' + schema,
				POSTGRES_USER: 'winwidget_' + schema + '_admin',
				POSTGRES_PASSWORD_FILE:
					'/run/secrets/' + app + '-postgres-admin-password',
				POSTGRES_INITDB_ARGS:
					'--locale=C.UTF-8 --encoding=UTF8 --auth-host=scram-sha-256 --data-checksums',
				PGDATA: '/var/lib/postgresql/18/docker'
			},
			'CRM database authentication or ownership differs'
		);
		same(
			database.command,
			['postgres', '-c', 'max_connections=' + maxConnections],
			'CRM database connection ceiling differs'
		);
		same(
			database.ports,
			[
				{
					mode: 'ingress',
					host_ip: '127.0.0.1',
					target: 5432,
					published: String(dbPort),
					protocol: 'tcp'
				}
			],
			'CRM database must publish only its own loopback port'
		);
		same(
			database.volumes,
			[
				{
					type: 'volume',
					source: app + '-postgres-data',
					target: '/var/lib/postgresql',
					volume: {}
				}
			],
			'CRM database volume differs'
		);
		same(
			database.networks,
			{ [app + '-postgres']: null },
			'CRM databases must not share a network'
		);
		same(
			database.secrets,
			[
				{
					source: app + '-postgres-admin-password',
					target: '/run/secrets/' + app + '-postgres-admin-password'
				}
			],
			'CRM database secret differs'
		);
		same(
			database.healthcheck,
			{
				test: [
					'CMD',
					'pg_isready',
					'-h',
					'127.0.0.1',
					'-U',
					'winwidget_' + schema + '_admin',
					'-d',
					'winwidget_' + schema
				],
				interval: '10s',
				timeout: '5s',
				retries: 12,
				start_period: '10s'
			},
			'CRM PostgreSQL health check differs'
		);
		same(
			{ ipam: {}, internal: false, ...config.networks[app + '-postgres'] },
			{
				name: 'winwidget-crm_' + app + '-postgres',
				driver: 'bridge',
				internal: false,
				ipam: {},
				labels: {
					'com.winwidget.owner': app,
					'com.winwidget.purpose': 'postgres-network'
				}
			},
			'CRM database network must preserve the project-owned loopback publishing contract'
		);
		same(
			config.volumes[app + '-postgres-data'],
			{
				name: 'winwidget-crm_' + app + '-postgres-data',
				labels: { 'com.winwidget.owner': app }
			},
			'CRM database volume must be project-owned'
		);
		same(
			config.secrets[app + '-postgres-admin-password'],
			{
				name: 'winwidget-crm_' + app + '-postgres-admin-password',
				file:
					'/opt/winwidget/deploy/backend/secrets/' +
					app +
					'-postgres-admin-password'
			},
			'CRM admin password must come from the exact protected service-owned file'
		);
		databaseMemoryBytes += database.mem_limit;
	}
	return {
		schemaVersion: 1,
		kind: 'winwidget.crm.compose-shape.v1',
		runtimeProcesses: 12,
		databases: 4,
		migrationJobs: 4,
		runtimeConnections,
		runtimeMemoryBytes,
		databaseMemoryBytes,
		maxMigrationMemoryBytes,
		capacityVerified: false,
		credentialsProvisioned: false,
		releaseApproved: false
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const report = validateCrmCompose(JSON.parse(readFileSync(0, 'utf8')));
		process.stdout.write(JSON.stringify(report) + '\n');
	} catch (error) {
		// Do not print assertions, input, URLs, env values or nested error causes.
		process.stderr.write(
			'CRM Compose validation failed: ' +
				(error instanceof Error && error.constructor === Error
					? error.message
					: 'invalid input') +
				'\n'
		);
		process.exitCode = 1;
	}
}
