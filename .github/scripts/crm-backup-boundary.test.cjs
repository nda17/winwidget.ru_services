const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
	CRM_BACKUP_TARGETS,
	validateCrmBackupBoundary
} = require('./crm-backup-boundary.cjs');

const fixture = () => ({
	'operations-worker': {
		environment: Object.fromEntries(
			CRM_BACKUP_TARGETS.map(([key, schema, port]) => [
				key,
				`postgresql://winwidget_${schema}_backup:fixture-only@127.0.0.1:${port}/winwidget_${schema}?schema=${schema}&sslmode=disable`
			])
		)
	},
	'operations-api': { environment: {} },
	'operations-outbox-publisher': { environment: {} },
	'operations-restore-worker': { environment: {} },
	'crm-sales-api': { environment: {} }
});
const validate = services =>
	validateCrmBackupBoundary(
		services,
		key => services['operations-worker']?.environment[key]
	);

test('accepts four backup-only endpoints without CRM runtime or restore containers', () => {
	assert.doesNotThrow(() => validate(fixture()));
	assert.equal(CRM_BACKUP_TARGETS.length, 4);
});

test('unrelated CRM companions render without new backup credentials while Operations admission remains strict', async () => {
	const root = resolve(__dirname, '../..');
	const { validateCrmCompanionCompose } =
		await import('./validate-crm-compose.mjs');
	const source = Object.fromEntries(
		readFileSync(resolve(root, '.env.example'), 'utf8')
			.split('\n')
			.filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
			.map(line => {
				const split = line.indexOf('=');
				return [line.slice(0, split), line.slice(split + 1)];
			})
	);
	for (const state of ['absent', 'empty', 'configured']) {
		const environment = { ...source };
		for (const [key] of CRM_BACKUP_TARGETS) {
			if (state === 'absent') delete environment[key];
			if (state === 'empty') environment[key] = '';
		}
		const rendered = spawnSync(
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
					...environment
				}
			}
		);
		assert.equal(
			rendered.status,
			0,
			'Synthetic scoped Compose must render without starting Docker containers'
		);
		const config = JSON.parse(rendered.stdout);
		assert.equal(
			validateCrmCompanionCompose(config, environment).wiringVerified,
			true
		);
		const admission = () =>
			validateCrmBackupBoundary(config.services, key => environment[key]);
		for (const [key] of CRM_BACKUP_TARGETS) {
			const leaked = structuredClone(config);
			leaked.services['billing-api'].environment[key] = '';
			assert.throws(() =>
				validateCrmCompanionCompose(leaked, environment)
			);
		}
		if (state === 'configured') assert.doesNotThrow(admission);
		else {
			assert.throws(
				admission,
				/CRM backup-only process boundary is invalid/
			);
			for (const [key] of CRM_BACKUP_TARGETS)
				assert.equal(
					config.services['operations-worker'].environment[key],
					''
				);
		}
	}
});
for (const [key] of CRM_BACKUP_TARGETS) {
	test(`${key} is required and must match canonical interpolation`, () => {
		const services = fixture();
		assert.throws(() =>
			validateCrmBackupBoundary(services, () => 'drifted')
		);
		delete services['operations-worker'].environment[key];
		assert.throws(() => validate(services));
	});
	for (const consumer of [
		'operations-api',
		'operations-outbox-publisher',
		'operations-restore-worker',
		'crm-sales-api'
	]) {
		test(`${key} cannot leak to ${consumer}`, () => {
			const services = fixture();
			services[consumer].environment[key] =
				services['operations-worker'].environment[key];
			assert.throws(() => validate(services));
		});
	}
	for (const [name, mutate] of [
		[
			'runtime principal',
			url => {
				url.username = url.username.replace(/backup$/, 'runtime');
			}
		],
		[
			'migration principal',
			url => {
				url.username = url.username.replace(/backup$/, 'migration');
			}
		],
		[
			'foreign database',
			url => {
				url.pathname = '/winwidget_identity';
			}
		],
		[
			'foreign port',
			url => {
				url.port = '55438';
			}
		],
		[
			'foreign host',
			url => {
				url.hostname = 'public.example';
			}
		],
		[
			'foreign schema',
			url => {
				url.searchParams.set('schema', 'identity');
			}
		],
		[
			'empty password',
			url => {
				url.password = '';
			}
		],
		[
			'password override',
			url => {
				url.searchParams.set('password', 'override');
			}
		],
		[
			'principal override',
			url => {
				url.searchParams.set('user', 'postgres');
			}
		],
		[
			'database override',
			url => {
				url.searchParams.set('dbname', 'postgres');
			}
		],
		[
			'libpq options',
			url => {
				url.searchParams.set('options', '-c role=postgres');
			}
		],
		[
			'duplicate schema',
			url => {
				url.searchParams.append('schema', url.searchParams.get('schema'));
			}
		],
		[
			'fragment',
			url => {
				url.hash = 'invalid';
			}
		],
		[
			'foreign protocol',
			url => {
				url.protocol = 'mysql:';
			}
		]
	]) {
		test(`${key} rejects ${name} without exposing credentials`, () => {
			const services = fixture();
			const url = new URL(services['operations-worker'].environment[key]);
			mutate(url);
			services['operations-worker'].environment[key] = url.toString();
			assert.throws(
				() => validate(services),
				error => {
					assert.equal(
						error.message,
						'CRM backup-only process boundary is invalid'
					);
					return true;
				}
			);
		});
	}
}
