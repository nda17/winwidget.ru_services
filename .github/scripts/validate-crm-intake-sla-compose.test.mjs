import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { REMINDER_ND_KINDS } from './validate-crm-reminders-compose.mjs';
import {
	INTAKE_SLA_ND_KINDS,
	validateCrmIntakeSlaDeployment,
	validateCrmIntakeSlaUpgrade,
	validateCrmIntakeSlaNotificationUpgrade
} from './validate-crm-intake-sla-compose.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const secret = digit => digit.repeat(64);
const db = pool =>
	`postgresql://winwidget_crm_intake_runtime:${secret('a')}@127.0.0.1:55443/winwidget_crm_intake?schema=crm_intake&sslmode=disable&connection_limit=${pool}&pool_timeout=10`;
const environment = {
	CRM_INTAKE_IMAGE: `sha256:${secret('b')}`,
	CRM_INTAKE_REVISION: 'a'.repeat(40),
	CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN: secret('1'),
	NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN: secret('2'),
	CRM_ACCESS_INTERNAL_BASE_URL: 'http://127.0.0.1:5300',
	CRM_ACCESS_CRM_INTAKE_TOKEN: secret('3'),
	CRM_INTAKE_SLA_WORKER_DATABASE_URL: db(2),
	CRM_INTAKE_SLA_PUBLISHER_DATABASE_URL: db(1),
	CRM_INTAKE_SLA_WORKER_RABBITMQ_URL: `amqp://winwidget-crm-intake-sla-worker:${secret('4')}@127.0.0.1:5672/winwidget`,
	CRM_INTAKE_SLA_PUBLISHER_RABBITMQ_URL: `amqp://winwidget-crm-intake-sla-publisher:${secret('5')}@127.0.0.1:5672/winwidget`,
	CRM_WORKER_MEMORY_LIMIT: '384m',
	CRM_WORKER_CPUS: '0.5',
	CRM_PUBLISHER_MEMORY_LIMIT: '256m',
	CRM_PUBLISHER_CPUS: '0.25'
};
const crmSource = {
	name: 'intake-sla-crm-fixture',
	services: {
		'crm-intake-api': {
			image: environment.CRM_INTAKE_IMAGE,
			network_mode: 'host',
			environment: {
				APP_REVISION: environment.CRM_INTAKE_REVISION,
				CRM_INTAKE_DATABASE_URL: db(5),
				CRM_ACCESS_INTERNAL_BASE_URL:
					environment.CRM_ACCESS_INTERNAL_BASE_URL,
				CRM_ACCESS_CRM_INTAKE_TOKEN:
					environment.CRM_ACCESS_CRM_INTAKE_TOKEN,
				CRM_INTAKE_PROCESS_ROLE: 'api',
				CRM_INTAKE_PORT: '5310'
			}
		},
		...Object.fromEntries(
			[
				'worker',
				'publisher',
				'widget-control-worker',
				'widget-control-publisher',
				'widget-transfer-worker',
				'widget-transfer-publisher'
			].map(role => [
				`crm-intake-${role}`,
				{
					image: environment.CRM_INTAKE_IMAGE,
					network_mode: 'host',
					mem_limit: role.endsWith('worker') ? '384m' : '256m',
					memswap_limit: role.endsWith('worker') ? '384m' : '256m',
					cpus: role.endsWith('worker') ? '0.5' : '0.25',
					environment: {
						APP_REVISION: environment.CRM_INTAKE_REVISION,
						CRM_INTAKE_PROCESS_ROLE: role
					}
				}
			])
		),
		'crm-sales-api': {
			image: `sha256:${secret('c')}`,
			network_mode: 'host',
			environment: { CRM_TASK_REMINDERS_ENABLED: 'true' }
		},
		'crm-sales-reminders': {
			image: `sha256:${secret('c')}`,
			network_mode: 'host',
			environment: { CRM_TASK_REMINDERS_ENABLED: 'true' }
		},
		'crm-customers-api': {
			image: `sha256:${secret('d')}`,
			network_mode: 'host',
			environment: {
				CRM_CUSTOMERS_DADATA_API_KEY: 'synthetic-fixture-only'
			}
		}
	}
};
const notificationSource = {
	name: 'intake-sla-notification-fixture',
	services: {
		'notification-delivery-worker': {
			image: `sha256:${secret('e')}`,
			network_mode: 'host',
			environment: {
				APP_REVISION: 'b'.repeat(40),
				NOTIFICATION_DELIVERY_KINDS: REMINDER_ND_KINDS,
				CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: secret('6'),
				NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: secret('7'),
				CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:5330'
			}
		},
		'operations-worker': {
			image: `sha256:${secret('f')}`,
			network_mode: 'host',
			environment: { APP_REVISION: 'c'.repeat(40) }
		}
	}
};
function render(source, overlay) {
	// Compose config parses locally; no Docker daemon, containers or volumes are used.
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
		'Synthetic SLA overlay must render; captured output suppressed'
	);
	return JSON.parse(result.stdout);
}
const fixture = {
	crmBefore: render(crmSource),
	crmAfter: render(crmSource, 'deploy/docker-compose.crm-intake-sla.yml'),
	notificationBefore: render(notificationSource),
	notificationAfter: render(
		notificationSource,
		'deploy/docker-compose.notification-intake-sla.yml'
	)
};

test('real SLA overlays add only the two isolated Intake roles and two ND kinds', () => {
	assert.equal(validateCrmIntakeSlaDeployment(fixture), true);
	assert.equal(
		INTAKE_SLA_ND_KINDS,
		`${REMINDER_ND_KINDS},wincrm-intake-sla-email,wincrm-intake-sla-telegram`
	);
});

test('rejects changes to existing roles, public flags, projects or reminder readers', () => {
	for (const change of [
		f => {
			f.crmAfter.name = 'different-project';
		},
		f => {
			delete f.crmAfter.services['crm-intake-widget-transfer-worker'];
		},
		f => {
			f.crmAfter.services.extra = {};
		},
		f => {
			f.crmAfter.services[
				'crm-customers-api'
			].environment.CRM_CUSTOMERS_DADATA_API_KEY = 'changed';
		},
		f => {
			f.crmAfter.services[
				'crm-intake-api'
			].environment.CRM_INTAKE_SLA_ENABLED = 'false';
		},
		f => {
			f.crmAfter.services[
				'crm-intake-api'
			].environment.CRM_INTAKE_WIDGETS_ENABLED = 'true';
		},
		f => {
			delete f.crmBefore.services['crm-sales-reminders'];
			delete f.crmAfter.services['crm-sales-reminders'];
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.NOTIFICATION_DELIVERY_KINDS =
				INTAKE_SLA_ND_KINDS.replace('wincrm-task-reminder-email,', '');
		},
		f => {
			f.notificationAfter.services['notification-delivery-worker'].image =
				'mutable:latest';
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.CRM_INTAKE_INTERNAL_BASE_URL = 'https://example.test';
		},
		f => {
			f.notificationAfter.services[
				'notification-delivery-worker'
			].environment.CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN = secret('9');
		},
		f => {
			f.crmAfter.services[
				'crm-intake-worker'
			].environment.CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN = secret('1');
		},
		f => {
			for (const s of [
				f.crmAfter.services['crm-intake-api'],
				f.crmAfter.services['crm-intake-sla-worker'],
				f.crmAfter.services['crm-intake-sla-publisher'],
				f.notificationAfter.services['notification-delivery-worker']
			])
				s.environment.CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN = secret('6');
		}
	]) {
		const candidate = structuredClone(fixture);
		change(candidate);
		assert.throws(() => validateCrmIntakeSlaDeployment(candidate));
	}
});

test('rejects unsafe role capabilities, widened credentials and wrong database pools', () => {
	for (const name of [
		'crm-intake-sla-worker',
		'crm-intake-sla-publisher'
	]) {
		for (const change of [
			w => {
				w.user = '0:0';
			},
			w => {
				w.read_only = false;
			},
			w => {
				w.volumes = ['/private:/private'];
			},
			w => {
				w.cap_add = ['NET_ADMIN'];
			},
			w => {
				w.network_mode = 'bridge';
			},
			w => {
				w.entrypoint = ['sh'];
			},
			w => {
				w.image = `sha256:${secret('f')}`;
			},
			w => {
				w.command = ['node', 'other.js'];
			},
			w => {
				w.restart = 'no';
			},
			w => {
				w.mem_limit = 1;
				w.memswap_limit = 1;
			},
			w => {
				w.cpus = 'Infinity';
			},
			w => {
				w.healthcheck.disable = true;
			},
			w => {
				w.environment.CRM_INTAKE_PROCESS_ROLE = 'all';
			},
			w => {
				w.environment.CRM_INTAKE_PORT = '5310';
			},
			w => {
				w.environment.APP_REVISION = 'f'.repeat(40);
			},
			w => {
				w.environment.CRM_INTAKE_DATABASE_URL = db(5);
			},
			w => {
				w.environment.CRM_INTAKE_DATABASE_URL =
					w.environment.CRM_INTAKE_DATABASE_URL.replace(
						'_runtime:',
						'_migration:'
					);
			},
			w => {
				w.environment.CRM_INTAKE_DATABASE_URL += '&connection_limit=1';
			},
			w => {
				w.environment.CRM_INTAKE_DATABASE_URL =
					w.environment.CRM_INTAKE_DATABASE_URL.replace(
						secret('a'),
						secret('f')
					);
			},
			w => {
				w.environment.CRM_INTAKE_SLA_RABBITMQ_URL =
					w.environment.CRM_INTAKE_SLA_RABBITMQ_URL.replace(
						/winwidget-crm-intake-sla-(worker|publisher):/,
						'winwidget-crm-intake-worker:'
					);
			},
			w => {
				w.environment.CRM_INTAKE_SLA_RABBITMQ_ASSERT_TOPOLOGY = 'true';
			},
			w => {
				w.environment.CRM_SALES_CRM_INTAKE_TOKEN = secret('9');
			},
			w => {
				w.environment.CRM_ACCESS_CRM_INTAKE_TOKEN = secret('1');
			}
		]) {
			const candidate = structuredClone(fixture);
			change(candidate.crmAfter.services[name]);
			assert.throws(() => validateCrmIntakeSlaDeployment(candidate));
		}
	}
	const candidate = structuredClone(fixture);
	candidate.crmAfter.services[
		'crm-intake-sla-publisher'
	].environment.CRM_INTAKE_SLA_RABBITMQ_URL =
		environment.CRM_INTAKE_SLA_PUBLISHER_RABBITMQ_URL.replace(
			secret('5'),
			secret('4')
		);
	assert.throws(() => validateCrmIntakeSlaDeployment(candidate));
});

test('upgrade adapters validate and strip only SLA fields before mandatory existing validators', () => {
	let checked = 0;
	assert.deepEqual(
		validateCrmIntakeSlaUpgrade(fixture.crmAfter, base => {
			assert.deepEqual(base, fixture.crmBefore);
			checked++;
			return true;
		}),
		fixture.crmBefore
	);
	assert.deepEqual(
		validateCrmIntakeSlaNotificationUpgrade(
			fixture.notificationAfter,
			base => {
				assert.deepEqual(base, fixture.notificationBefore);
				checked++;
				return true;
			}
		),
		fixture.notificationBefore
	);
	assert.equal(checked, 2);
	assert.throws(() => validateCrmIntakeSlaUpgrade(fixture.crmAfter));
	assert.throws(() =>
		validateCrmIntakeSlaUpgrade(fixture.crmAfter, () => false)
	);
	assert.throws(() =>
		validateCrmIntakeSlaNotificationUpgrade(
			fixture.notificationAfter,
			() => {
				throw new Error('existing validation failed');
			}
		)
	);
});

test('owner example declares overlay inputs without enabling SLA by default', () => {
	const source = readFileSync(
		resolve(root, 'deploy/crm/.env.example'),
		'utf8'
	);
	const entries = source
		.split(/\r?\n/)
		.filter(line => /^[A-Z0-9_]+=/.test(line))
		.map(line => {
			const index = line.indexOf('=');
			return [line.slice(0, index), line.slice(index + 1)];
		});
	const example = Object.fromEntries(entries);
	assert.equal(entries.length, Object.keys(example).length);
	for (const key of Object.keys(environment))
		assert.ok(key in example, `Owner example missing ${key}`);
	assert.equal(example.CRM_INTAKE_SLA_ENABLED, 'false');
	assert.equal(example.CRM_INTAKE_SLA_RABBITMQ_CONTRACT, 'disabled');
});
