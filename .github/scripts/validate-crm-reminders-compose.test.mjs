import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	validateCrmReminderDeployment,
	validateCrmReminderSalesOverlay,
	validateCrmReminderNotificationOverlay,
	REMINDER_ND_KINDS
} from './validate-crm-reminders-compose.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const secret = digit => digit.repeat(64);
const db = pool =>
	`postgresql://winwidget_crm_sales_runtime:${secret('a')}@127.0.0.1:55445/winwidget_crm_sales?schema=crm_sales&sslmode=disable&connection_limit=${pool}&pool_timeout=10`;
const environment = {
	CRM_SALES_IMAGE: `sha256:${secret('b')}`,
	CRM_SALES_REVISION: 'a'.repeat(40),
	CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: secret('1'),
	NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: secret('2'),
	CRM_TASK_REMINDERS_ENABLED: 'true',
	CRM_SALES_REMINDERS_DATABASE_URL: db(4),
	CRM_ACCESS_INTERNAL_BASE_URL: 'http://127.0.0.1:5300',
	CRM_ACCESS_CRM_SALES_TOKEN: secret('3'),
	CRM_SALES_REMINDERS_RABBITMQ_URL: `amqp://winwidget-crm-sales-reminders:${secret('4')}@127.0.0.1:5672/winwidget`,
	CRM_WORKER_MEMORY_LIMIT: '384m',
	CRM_WORKER_CPUS: '0.5'
};
const crmSource = {
	name: 'reminder-crm-fixture',
	services: {
		'crm-sales-api': {
			image: environment.CRM_SALES_IMAGE,
			network_mode: 'host',
			environment: {
				NODE_ENV: 'production',
				MODE: 'production',
				APP_REVISION: environment.CRM_SALES_REVISION,
				CRM_SALES_DATABASE_URL: db(5),
				CRM_ACCESS_INTERNAL_BASE_URL:
					environment.CRM_ACCESS_INTERNAL_BASE_URL,
				CRM_ACCESS_CRM_SALES_TOKEN: environment.CRM_ACCESS_CRM_SALES_TOKEN,
				CRM_SALES_PROCESS_ROLE: 'api',
				CRM_SALES_PORT: '5330'
			}
		},
		'crm-access-api': {
			image: `sha256:${secret('c')}`,
			network_mode: 'host',
			environment: { APP_REVISION: 'c'.repeat(40) }
		}
	}
};
const notificationSource = {
	name: 'reminder-notification-fixture',
	services: {
		'notification-delivery-worker': {
			image: `sha256:${secret('d')}`,
			network_mode: 'host',
			environment: {
				APP_REVISION: 'd'.repeat(40),
				NOTIFICATION_DELIVERY_KINDS: REMINDER_ND_KINDS.split(',')
					.slice(0, 12)
					.join(','),
				NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: secret('5'),
				IDENTITY_NOTIFICATION_DELIVERY_TOKEN: secret('6')
			}
		},
		'operations-worker': {
			image: `sha256:${secret('e')}`,
			network_mode: 'host',
			environment: { APP_REVISION: 'e'.repeat(40) }
		}
	}
};
function render(source, overlay) {
	// Compose config is local parsing only: never contact a daemon or create containers.
	const result = spawnSync(
		'docker',
		[
			'compose',
			'--env-file',
			'/dev/null',
			'-f',
			'-',
			...(overlay ? ['-f', overlay] : []),
			'--profile',
			'*',
			'config',
			'--format',
			'json'
		],
		{
			cwd: root,
			input: JSON.stringify(source),
			encoding: 'utf8',
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				COMPOSE_DISABLE_ENV_FILE: 'true',
				...environment
			}
		}
	);
	assert.equal(
		result.status,
		0,
		'Synthetic reminder overlay must render; captured output suppressed'
	);
	return JSON.parse(result.stdout);
}
const fixture = {
	crmBefore: render(crmSource),
	crmAfter: render(crmSource, 'deploy/docker-compose.crm-reminders.yml'),
	notificationBefore: render(notificationSource),
	notificationAfter: render(
		notificationSource,
		'deploy/docker-compose.notification-reminders.yml'
	)
};

test('actual opt-in overlays render and preserve unrelated services without a Docker daemon', () => {
	assert.equal(validateCrmReminderDeployment(fixture), true);
	assert.equal(
		validateCrmReminderNotificationOverlay(
			fixture.notificationBefore,
			fixture.notificationAfter
		),
		true
	);
	assert.equal(
		validateCrmReminderSalesOverlay(fixture.crmBefore, fixture.crmAfter),
		true
	);
	const numeric = structuredClone(fixture);
	const worker = numeric.crmAfter.services['crm-sales-reminders'];
	worker.mem_limit = Number(worker.mem_limit);
	worker.memswap_limit = Number(worker.memswap_limit);
	assert.equal(validateCrmReminderDeployment(numeric), true);
});
test('rejects unrelated process/config/credential or consumer drift', () => {
	for (const change of [
		f => {
			f.crmAfter.services['crm-access-api'].image =
				f.crmAfter.services['crm-sales-api'].image;
		},
		f => {
			f.crmAfter.services.extra = {};
		},
		f => {
			delete f.notificationAfter.services['operations-worker'];
		},
		f => {
			f.notificationAfter.services[
				'operations-worker'
			].environment.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN = secret('1');
		},
		f => {
			f.crmAfter.services[
				'crm-sales-api'
			].environment.CORS_ALLOWED_ORIGINS = 'https://example.test';
		},
		f => {
			f.notificationAfter.services['notification-delivery-worker'].image =
				`sha256:${secret('c')}`;
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.NOTIFICATION_DELIVERY_KINDS =
				REMINDER_ND_KINDS.replace('wincrm-invitation-email,', '');
		},
		f => {
			f.notificationBefore.services[
				'notification-delivery-worker'
			].environment.NOTIFICATION_DELIVERY_KINDS = 'email';
		},
		f => {
			f.crmAfter.services[
				'crm-sales-api'
			].environment.CRM_TASK_REMINDERS_ENABLED = 'false';
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.CRM_SALES_NOTIFICATION_DELIVERY_TOKEN = secret('7');
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.NOTIFICATION_DELIVERY_CRM_SALES_TOKEN = secret('5');
		}
	]) {
		const candidate = structuredClone(fixture);
		change(candidate);
		assert.throws(() => validateCrmReminderDeployment(candidate));
	}
});
test('rejects worker privilege, image, resources and owned database/broker changes', () => {
	for (const change of [
		w => {
			w.user = '0:0';
		},
		w => {
			w.read_only = false;
		},
		w => {
			w.cap_add = ['NET_ADMIN'];
		},
		w => {
			w.volumes = ['/private:/private'];
		},
		w => {
			w.image = 'mutable:latest';
		},
		w => {
			w.environment.CRM_SALES_PROCESS_ROLE = 'api';
		},
		w => {
			w.environment.CRM_SALES_REMINDERS_PORT = '5330';
		},
		w => {
			w.environment.CRM_SALES_CRM_INTAKE_TOKEN = secret('9');
		},
		w => {
			w.environment.CRM_SALES_DATABASE_URL = db(5);
		},
		w => {
			w.environment.CRM_SALES_DATABASE_URL = db(4).replace(
				'_runtime:',
				'_migration:'
			);
		},
		w => {
			w.environment.CRM_SALES_DATABASE_URL = db(4).replace(
				'55445',
				'55444'
			);
		},
		w => {
			w.environment.CRM_SALES_DATABASE_URL = db(4).replace(
				secret('a'),
				secret('f')
			);
		},
		w => {
			w.environment.CRM_SALES_DATABASE_URL = `${db(4)}&connection_limit=4`;
		},
		w => {
			w.environment.RABBITMQ_URL = w.environment.RABBITMQ_URL.replace(
				'winwidget-crm-sales-reminders:',
				'winwidget-crm-access-worker:'
			);
		},
		w => {
			w.environment.RABBITMQ_CONNECTION_NAME = 'other';
		},
		w => {
			w.environment.APP_REVISION = 'b'.repeat(40);
		},
		w => {
			w.memswap_limit += 1;
		},
		w => {
			w.cpus = 0;
		},
		w => {
			w.mem_limit = '384m';
		},
		w => {
			w.mem_limit = -1;
		},
		w => {
			w.mem_limit = true;
		},
		w => {
			w.cpus = 'Infinity';
		},
		w => {
			w.entrypoint = ['sh', '-c'];
		},
		w => {
			w.healthcheck.disable = true;
		},
		w => {
			w.command = ['node', 'dist/src/main.js'];
		}
	]) {
		const candidate = structuredClone(fixture);
		change(candidate.crmAfter.services['crm-sales-reminders']);
		assert.throws(() => validateCrmReminderDeployment(candidate));
	}
});
