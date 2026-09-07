import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

// Opt-in overlay validation only, not rollout authority. Inputs are rendered Compose JSON.
export const REMINDER_ND_KINDS =
	'email,telegram,payment-email,payment-telegram,limit-email,limit-telegram,campaign-email,campaign-telegram,daily-summary-delivery-telegram,subscription-expiry-email,subscription-expiry-telegram,wincrm-invitation-email,wincrm-task-reminder-email,wincrm-task-reminder-telegram';
const pairKeys = [
	'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
	'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
];
const check = (value, message) => {
	if (!value) throw new Error(message);
};
const same = (actual, expected, message) =>
	check(isDeepStrictEqual(actual, expected), message);
const keys = value => Object.keys(value ?? {}).sort();
const exact = (value, names, message) =>
	same(keys(value), [...names].sort(), message);
const immutable = value =>
	typeof value === 'string' &&
	/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(value);
const positiveBytes = value =>
	(typeof value === 'number' ||
		(typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) &&
	Number.isSafeInteger(Number(value)) &&
	Number(value) > 0;
const url = value => {
	try {
		return new URL(value);
	} catch {
		throw new Error('Invalid reminder connection URL');
	}
};
function pair(environment) {
	const values = pairKeys.map(key => environment[key]);
	check(
		values.every(
			value =>
				typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value)
		) && new Set(values).size === 2,
		'Separate strong reminder pair credentials required'
	);
	for (const [name, value] of Object.entries(environment))
		if (name.endsWith('_TOKEN') && !pairKeys.includes(name))
			check(
				!values.includes(value),
				'Reminder credential aliases an existing caller'
			);
	return Object.fromEntries(pairKeys.map(key => [key, environment[key]]));
}
function unchanged(before, after, targets, added = []) {
	const { services: oldServices, ...oldRoot } = before;
	const { services: newServices, ...newRoot } = after;
	check(oldServices && newServices, 'Compose services required');
	same(newRoot, oldRoot, 'Reminder overlay changes project metadata');
	exact(
		newServices,
		[...Object.keys(oldServices), ...added],
		'Reminder overlay changes unrelated service inventory'
	);
	for (const [name, service] of Object.entries(oldServices))
		if (!targets.includes(name))
			same(
				newServices[name],
				service,
				'Reminder overlay changes an unrelated service'
			);
	for (const [name, service] of Object.entries(newServices))
		if (!targets.includes(name) && !added.includes(name))
			check(
				pairKeys.every(key => !(key in (service.environment ?? {}))),
				'Reminder pair credentials leaked to another process'
			);
}
export function validateCrmReminderNotificationOverlay(before, after) {
	const name = 'notification-delivery-worker';
	unchanged(before, after, [name]);
	const old = before.services[name],
		next = after.services[name];
	check(old && next, 'Notification Delivery runtime is required');
	check(
		immutable(next.image),
		'Notification Delivery requires immutable image'
	);
	const existingKinds = (
		old.environment?.NOTIFICATION_DELIVERY_KINDS ?? ''
	)
		.split(',')
		.map(kind => kind.trim());
	check(
		REMINDER_ND_KINDS.split(',')
			.slice(0, 12)
			.every(kind => existingKinds.includes(kind)) &&
			existingKinds.every(kind =>
				REMINDER_ND_KINDS.split(',').includes(kind)
			),
		'Existing notification consumers including invitations must be preserved'
	);
	const environment = {
		...old.environment,
		...pair(next.environment),
		CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330',
		NOTIFICATION_DELIVERY_KINDS: REMINDER_ND_KINDS
	};
	same(
		next,
		{ ...old, environment },
		'Notification reader overlay changes more than approved environment'
	);
	return true;
}
export function validateCrmReminderSalesOverlay(before, after) {
	const apiName = 'crm-sales-api',
		workerName = 'crm-sales-reminders';
	check(
		!before.services?.[workerName],
		'Use the dedicated resume contract for an existing reminder runtime'
	);
	unchanged(before, after, [apiName], [workerName]);
	const api = before.services[apiName],
		next = after.services[apiName],
		worker = after.services[workerName];
	check(
		api && next && worker,
		'CRM Sales API and reminder runtime required'
	);
	const shared = {
		...pair(next.environment),
		CRM_TASK_REMINDERS_ENABLED: 'true',
		NOTIFICATION_DELIVERY_INTERNAL_BASE_URL: 'http://127.0.0.1:4401'
	};
	same(
		next,
		{ ...api, environment: { ...api.environment, ...shared } },
		'Sales API changes more than approved reminder environment'
	);
	check(
		immutable(api.image) && worker.image === api.image,
		'Reminder runtime must use the same immutable Sales image'
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
		'Unexpected reminder process capability'
	);
	check(
		worker.entrypoint === undefined || worker.entrypoint === null,
		'Reminder entrypoint cannot bypass image defaults'
	);
	for (const [key, value] of Object.entries({
		profiles: ['crm-reminders'],
		command: ['node', 'dist/src/main-reminders.js'],
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
			'com.winwidget.owner': 'crm-sales',
			'com.winwidget.purpose': 'reminders',
			'com.winwidget.singleton': 'true'
		},
		logging: {
			driver: 'json-file',
			options: { 'max-size': '10m', 'max-file': '3' }
		}
	}))
		same(
			worker[key],
			value,
			'Reminder runtime isolation differs from approved shape'
		);
	check(
		positiveBytes(worker.mem_limit) &&
			positiveBytes(worker.memswap_limit) &&
			Number(worker.memswap_limit) === Number(worker.mem_limit) &&
			Number.isFinite(Number(worker.cpus)) &&
			Number(worker.cpus) > 0,
		'Measured reminder runtime resource limits required'
	);
	same(
		worker.healthcheck,
		{
			test: [
				'CMD',
				'node',
				'-e',
				"fetch('http://127.0.0.1:5331/health/ready',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
			],
			interval: '10s',
			timeout: '3s',
			retries: 6,
			start_period: '45s'
		},
		'Reminder health probe must target loopback 5331'
	);
	const apiDb = url(api.environment.CRM_SALES_DATABASE_URL),
		workerDb = url(worker.environment.CRM_SALES_DATABASE_URL);
	check(
		['postgresql:', 'postgres:'].includes(apiDb.protocol) &&
			apiDb.hostname === '127.0.0.1' &&
			apiDb.port === '55445' &&
			apiDb.username === 'winwidget_crm_sales_runtime' &&
			apiDb.pathname === '/winwidget_crm_sales' &&
			apiDb.password &&
			!apiDb.hash,
		'Wrong owned Sales runtime database'
	);
	exact(
		Object.fromEntries(workerDb.searchParams),
		['schema', 'sslmode', 'connection_limit', 'pool_timeout'],
		'Unexpected reminder database URL options'
	);
	check(
		[...workerDb.searchParams].length === 4 &&
			workerDb.searchParams.get('schema') === 'crm_sales' &&
			workerDb.searchParams.get('sslmode') === 'disable' &&
			workerDb.searchParams.get('pool_timeout') === '10',
		'Wrong reminder database options'
	);
	apiDb.searchParams.set('connection_limit', '4');
	same(
		workerDb.toString(),
		apiDb.toString(),
		'Reminder database must preserve API principal and credential with pool four'
	);
	const broker = url(worker.environment.RABBITMQ_URL);
	check(
		broker.protocol === 'amqp:' &&
			broker.hostname === '127.0.0.1' &&
			broker.port === '5672' &&
			broker.username === 'winwidget-crm-sales-reminders' &&
			broker.password &&
			broker.pathname === '/winwidget' &&
			!broker.search &&
			!broker.hash,
		'Dedicated reminder broker principal required'
	);
	check(
		/^[a-f0-9]{40}$/.test(api.environment.APP_REVISION),
		'Immutable Sales revision required'
	);
	same(
		worker.environment,
		{
			NODE_ENV: 'production',
			MODE: 'production',
			APP_REVISION: api.environment.APP_REVISION,
			CRM_SALES_PROCESS_ROLE: 'reminders',
			CRM_SALES_REMINDERS_PORT: '5331',
			...shared,
			CRM_SALES_DATABASE_URL: worker.environment.CRM_SALES_DATABASE_URL,
			CRM_ACCESS_INTERNAL_BASE_URL:
				api.environment.CRM_ACCESS_INTERNAL_BASE_URL,
			CRM_ACCESS_CRM_SALES_TOKEN:
				api.environment.CRM_ACCESS_CRM_SALES_TOKEN,
			RABBITMQ_URL: worker.environment.RABBITMQ_URL,
			RABBITMQ_CONNECTION_NAME: 'winwidget-crm-sales-reminders'
		},
		'Reminder runtime environment is not least privileged'
	);
	pair(worker.environment);
	return true;
}
export function validateCrmReminderDeployment({
	crmBefore,
	crmAfter,
	notificationBefore,
	notificationAfter
}) {
	validateCrmReminderSalesOverlay(crmBefore, crmAfter);
	validateCrmReminderNotificationOverlay(
		notificationBefore,
		notificationAfter
	);
	for (const key of pairKeys)
		same(
			crmAfter.services['crm-sales-api'].environment[key],
			notificationAfter.services['notification-delivery-worker']
				.environment[key],
			'Reminder pair credentials differ between owners'
		);
	return true;
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		validateCrmReminderDeployment(JSON.parse(readFileSync(0, 'utf8')));
		console.log('CRM reminder overlay shape: PASS');
	} catch {
		console.error(
			'CRM reminder overlay validation failed; private details suppressed'
		);
		process.exitCode = 1;
	}
}
