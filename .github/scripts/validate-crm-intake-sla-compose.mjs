import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Standalone verifier for mounting into a release probe. This validates shape,
// not activation authority or live broker/reader readiness.
const reminderKinds =
	'email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram,wincrm-invitation-email,wincrm-task-reminder-email,wincrm-task-reminder-telegram';
export const INTAKE_SLA_ND_KINDS = `${reminderKinds},wincrm-intake-sla-email,wincrm-intake-sla-telegram`;
const pairKeys = [
	'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
	'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
];
const apiKeys = [
	...pairKeys,
	'CRM_INTAKE_SLA_ENABLED',
	'NOTIFICATION_DELIVERY_INTERNAL_BASE_URL'
];
const names = ['crm-intake-sla-worker', 'crm-intake-sla-publisher'];
const check = (value, message) => {
	if (!value) throw new Error(message);
};
const same = (actual, expected, message) =>
	check(isDeepStrictEqual(actual, expected), message);
const exact = (value, expected, message) =>
	same(Object.keys(value ?? {}).sort(), [...expected].sort(), message);
const immutable = value =>
	typeof value === 'string' &&
	/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(value);
const strong = value =>
	typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value);
const positive = value =>
	(typeof value === 'number' ||
		(typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) &&
	Number.isSafeInteger(Number(value)) &&
	Number(value) > 0;
function url(value) {
	try {
		return new URL(value);
	} catch {
		throw new Error('Invalid SLA connection URL');
	}
}
function pair(environment) {
	const values = pairKeys.map(key => environment?.[key]);
	check(
		values.every(strong) && new Set(values).size === 2,
		'Separate strong SLA pair credentials required'
	);
	for (const [key, value] of Object.entries(environment))
		if (key.endsWith('_TOKEN') && !pairKeys.includes(key))
			check(
				!values.includes(value),
				'SLA credentials alias an existing caller'
			);
	return Object.fromEntries(pairKeys.map(key => [key, environment[key]]));
}
function unchanged(before, after, target, added = []) {
	const { services: oldServices, ...oldRoot } = before;
	const { services: newServices, ...newRoot } = after;
	check(oldServices && newServices, 'Compose services required');
	same(newRoot, oldRoot, 'SLA overlay changes project metadata');
	exact(
		newServices,
		[...Object.keys(oldServices), ...added],
		'SLA overlay changes service inventory'
	);
	for (const [name, service] of Object.entries(oldServices))
		if (name !== target)
			same(
				newServices[name],
				service,
				'SLA overlay changes an unrelated process'
			);
	for (const [name, service] of Object.entries(newServices))
		if (name !== target && !added.includes(name))
			check(
				pairKeys.every(key => !(key in (service.environment ?? {}))),
				'SLA credentials leaked to an unrelated process'
			);
}
function database(apiValue, nextValue, pool) {
	const api = url(apiValue),
		next = url(nextValue);
	check(
		['postgres:', 'postgresql:'].includes(api.protocol) &&
			api.hostname === '127.0.0.1' &&
			api.port === '55443' &&
			api.username === 'winwidget_crm_intake_runtime' &&
			api.pathname === '/winwidget_crm_intake' &&
			api.password &&
			!api.hash,
		'Wrong owned Intake runtime database'
	);
	for (const value of [api, next]) {
		exact(
			Object.fromEntries(value.searchParams),
			['schema', 'sslmode', 'connection_limit', 'pool_timeout'],
			'Unexpected SLA database option'
		);
		check(
			[...value.searchParams].length === 4 &&
				value.searchParams.get('schema') === 'crm_intake' &&
				value.searchParams.get('sslmode') === 'disable' &&
				value.searchParams.get('pool_timeout') === '10',
			'Wrong SLA database options'
		);
	}
	api.searchParams.set('connection_limit', String(pool));
	same(
		next.toString(),
		api.toString(),
		'SLA database principal, credential or pool differs'
	);
}
export function validateCrmIntakeSlaOverlay(before, after) {
	check(
		names.every(name => !before.services?.[name]),
		'Existing SLA roles require the upgrade validator'
	);
	unchanged(before, after, 'crm-intake-api', names);
	const api = before.services['crm-intake-api'],
		next = after.services['crm-intake-api'];
	check(
		api &&
			next &&
			immutable(api.image) &&
			/^[a-f0-9]{40}$/.test(api.environment?.APP_REVISION),
		'Immutable Intake API is required'
	);
	check(
		before.services['crm-sales-reminders']?.environment
			?.CRM_TASK_REMINDERS_ENABLED === 'true' &&
			before.services['crm-sales-api']?.environment
				?.CRM_TASK_REMINDERS_ENABLED === 'true',
		'SLA requires the existing reminder topology'
	);
	check(
		apiKeys.every(key => !(key in api.environment)),
		'SLA extras already exist in the base API'
	);
	const shared = {
		...pair(next.environment),
		CRM_INTAKE_SLA_ENABLED: 'true',
		NOTIFICATION_DELIVERY_INTERNAL_BASE_URL: 'http://127.0.0.1:4401'
	};
	same(
		next,
		{ ...api, environment: { ...api.environment, ...shared } },
		'Intake API changes more than approved SLA environment'
	);
	check(
		api.environment.CRM_ACCESS_INTERNAL_BASE_URL ===
			'http://127.0.0.1:5300' &&
			strong(api.environment.CRM_ACCESS_CRM_INTAKE_TOKEN),
		'Existing Intake Access authority configuration required'
	);
	const brokerPasswords = [];
	for (const [index, name] of names.entries()) {
		const worker = after.services[name],
			role = index === 0 ? 'worker' : 'publisher',
			port = index === 0 ? 5317 : 5318;
		const resource = before.services[`crm-intake-${role}`];
		check(
			worker && resource && worker.image === api.image,
			'SLA role must use the existing Intake image and resource class'
		);
		exact(
			worker,
			[
				'profiles',
				'image',
				'command',
				...('entrypoint' in worker ? ['entrypoint'] : []),
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
				'labels',
				'environment',
				'mem_limit',
				'memswap_limit',
				'cpus',
				'logging',
				'healthcheck'
			],
			'Unexpected SLA process capability'
		);
		check(
			worker.entrypoint === undefined || worker.entrypoint === null,
			'SLA entrypoint override is forbidden'
		);
		for (const [key, value] of Object.entries({
			profiles: ['crm-intake-sla'],
			command: ['node', 'dist/src/main.js'],
			network_mode: 'host',
			user: '1001:1001',
			read_only: true,
			tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=64m'],
			cap_drop: ['ALL'],
			security_opt: ['no-new-privileges:true'],
			pids_limit: 128,
			init: true,
			restart: 'unless-stopped',
			stop_grace_period: '45s',
			labels: {
				'com.winwidget.owner': 'crm-intake',
				'com.winwidget.purpose': `sla-${role}`,
				'com.winwidget.singleton': 'true'
			},
			logging: {
				driver: 'json-file',
				options: { 'max-size': '10m', 'max-file': '3' }
			},
			healthcheck: {
				test: [
					'CMD',
					'node',
					'-e',
					`fetch('http://127.0.0.1:${port}/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))`
				],
				interval: '10s',
				timeout: '3s',
				retries: 6,
				start_period: '45s'
			}
		}))
			same(worker[key], value, 'SLA runtime isolation or health differs');
		check(
			positive(worker.mem_limit) &&
				positive(worker.memswap_limit) &&
				Number(worker.mem_limit) === Number(worker.memswap_limit) &&
				Number(worker.mem_limit) === Number(resource.mem_limit) &&
				Number(worker.memswap_limit) === Number(resource.memswap_limit) &&
				Number.isFinite(Number(worker.cpus)) &&
				Number(worker.cpus) > 0 &&
				Number(worker.cpus) === Number(resource.cpus),
			'SLA resources must match the existing worker/publisher class'
		);
		database(
			api.environment.CRM_INTAKE_DATABASE_URL,
			worker.environment?.CRM_INTAKE_DATABASE_URL,
			index === 0 ? 2 : 1
		);
		const broker = url(worker.environment.CRM_INTAKE_SLA_RABBITMQ_URL);
		check(
			broker.protocol === 'amqp:' &&
				broker.hostname === '127.0.0.1' &&
				broker.port === '5672' &&
				broker.pathname === '/winwidget' &&
				broker.username === `winwidget-crm-intake-sla-${role}` &&
				broker.password &&
				!broker.search &&
				!broker.hash,
			'Dedicated SLA broker principal required'
		);
		brokerPasswords.push(broker.password);
		same(
			worker.environment,
			{
				NODE_ENV: 'production',
				MODE: 'production',
				APP_REVISION: api.environment.APP_REVISION,
				CRM_INTAKE_LISTEN_HOST: '127.0.0.1',
				CORS_ALLOWED_ORIGINS: 'https://crm.winwidget.ru',
				CRM_INTAKE_PROCESS_ROLE: `sla-${role}`,
				CRM_INTAKE_PORT: String(port),
				CRM_INTAKE_DATABASE_URL:
					worker.environment.CRM_INTAKE_DATABASE_URL,
				CRM_ACCESS_INTERNAL_BASE_URL:
					api.environment.CRM_ACCESS_INTERNAL_BASE_URL,
				CRM_ACCESS_CRM_INTAKE_TOKEN:
					api.environment.CRM_ACCESS_CRM_INTAKE_TOKEN,
				...shared,
				CRM_INTAKE_SLA_RABBITMQ_URL:
					worker.environment.CRM_INTAKE_SLA_RABBITMQ_URL,
				CRM_INTAKE_SLA_RABBITMQ_ASSERT_TOPOLOGY: 'false'
			},
			'SLA runtime environment is not least privileged'
		);
		pair(worker.environment);
	}
	check(
		new Set(brokerPasswords).size === 2,
		'SLA broker principals require different credentials'
	);
	return true;
}
export function validateCrmIntakeSlaNotificationOverlay(before, after) {
	unchanged(before, after, 'notification-delivery-worker');
	const old = before.services['notification-delivery-worker'],
		next = after.services['notification-delivery-worker'];
	check(
		old &&
			next &&
			immutable(next.image) &&
			old.environment?.NOTIFICATION_DELIVERY_KINDS === reminderKinds,
		'SLA requires the existing exact reminder ND consumers'
	);
	check(
		[...pairKeys, 'CRM_INTAKE_INTERNAL_BASE_URL'].every(
			key => !(key in old.environment)
		),
		'SLA reader extras already exist'
	);
	same(
		next,
		{
			...old,
			environment: {
				...old.environment,
				...pair(next.environment),
				CRM_INTAKE_INTERNAL_BASE_URL: 'http://127.0.0.1:5310',
				NOTIFICATION_DELIVERY_KINDS: INTAKE_SLA_ND_KINDS
			}
		},
		'ND SLA overlay changes more than approved reader environment'
	);
	return true;
}
export function validateCrmIntakeSlaDeployment({
	crmBefore,
	crmAfter,
	notificationBefore,
	notificationAfter
}) {
	validateCrmIntakeSlaOverlay(crmBefore, crmAfter);
	validateCrmIntakeSlaNotificationOverlay(
		notificationBefore,
		notificationAfter
	);
	for (const key of pairKeys)
		same(
			crmAfter.services['crm-intake-api'].environment[key],
			notificationAfter.services['notification-delivery-worker']
				.environment[key],
			'SLA pair credentials differ between owners'
		);
	const values = pairKeys.map(
		key => crmAfter.services['crm-intake-api'].environment[key]
	);
	for (const config of [crmBefore, notificationBefore])
		for (const service of Object.values(config.services))
			for (const [key, value] of Object.entries(service.environment ?? {}))
				if (key.endsWith('_TOKEN'))
					check(
						!values.includes(value),
						'SLA credentials alias an existing service'
					);
	return true;
}
// The callback MUST apply the existing base/reminder validators. Returning the
// stripped document lets the release reuse its existing sealed configuration model.
export function validateCrmIntakeSlaUpgrade(config, validateExisting) {
	check(
		typeof validateExisting === 'function',
		'Existing CRM validation required'
	);
	const before = structuredClone(config);
	for (const name of names) delete before.services[name];
	for (const key of apiKeys)
		delete before.services['crm-intake-api'].environment[key];
	validateCrmIntakeSlaOverlay(before, config);
	check(
		validateExisting(before) !== false,
		'Existing CRM validation failed'
	);
	return before;
}
export function validateCrmIntakeSlaNotificationUpgrade(
	config,
	validateExisting
) {
	check(
		typeof validateExisting === 'function',
		'Existing ND validation required'
	);
	const before = structuredClone(config),
		env = before.services['notification-delivery-worker'].environment;
	for (const key of [...pairKeys, 'CRM_INTAKE_INTERNAL_BASE_URL'])
		delete env[key];
	env.NOTIFICATION_DELIVERY_KINDS = reminderKinds;
	validateCrmIntakeSlaNotificationOverlay(before, config);
	check(
		validateExisting(before) !== false,
		'Existing ND validation failed'
	);
	return before;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		validateCrmIntakeSlaDeployment(JSON.parse(readFileSync(0, 'utf8')));
		console.log('CRM Intake SLA overlay shape: PASS');
	} catch {
		console.error(
			'CRM Intake SLA overlay validation failed; private details suppressed'
		);
		process.exitCode = 1;
	}
}
