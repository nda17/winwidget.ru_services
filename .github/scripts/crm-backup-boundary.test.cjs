const assert = require('node:assert/strict');
const test = require('node:test');
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
