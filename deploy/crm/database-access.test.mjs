import assert from 'node:assert/strict';
import {
	mkdtempSync,
	cpSync,
	rmSync,
	symlinkSync,
	unlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	readDatabaseAccess,
	validateDatabaseAccess,
	databaseBootstrapSql,
	databaseRuntimeGrantsSql
} from './database-access.mjs';
import { runtimeGrants } from '../../apps/crm-access/test/integration/local-crm-image-topology.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const services = [
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales'
];
const passwords = {
	runtime: 'a'.repeat(64),
	migration: 'b'.repeat(64),
	backup: 'c'.repeat(64)
};
for (const service of services) {
	test(
		service + ': exact source manifest and migration digests are accepted',
		() => {
			const { contract, migrations, accessSha256 } = readDatabaseAccess(
				join(root, 'apps', service, 'prisma'),
				service
			);
			assert.match(accessSha256, /^[a-f0-9]{64}$/);
			assert.ok(migrations.length > 0);
			const grants = databaseRuntimeGrantsSql(contract, migrations);
			assert.match(
				grants,
				/finished_at IS NULL OR rolled_back_at IS NOT NULL/
			);
			assert.match(grants, /CRM database identity mismatch/);
			assert.doesNotMatch(grants, /GRANT .*_prisma_migrations.*runtime/);
			assert.doesNotMatch(grants, /GRANT ALL|GRANT EXECUTE/);
			const bootstrap = databaseBootstrapSql(contract, passwords);
			assert.ok(
				bootstrap.indexOf("SET log_statement = 'none'") <
					bootstrap.indexOf('PASSWORD')
			);
			assert.doesNotMatch(bootstrap, /ALTER ROLE|ALTER USER/);
			assert.equal((bootstrap.match(/CREATE ROLE/g) || []).length, 3);
			assert.match(
				bootstrap,
				/REVOKE ALL ON DATABASE.*postgres, template1/
			);
			// The previously exercised business/image harness must not silently
			// grant more or fewer table rights than the release contract.
			const actual = {};
			for (const match of runtimeGrants(service).matchAll(
				/GRANT ([A-Z, ]+) ON (?!SEQUENCE|SCHEMA)([^;]+) TO image_runtime;/g
			)) {
				for (const target of match[2].split(', '))
					actual[target.split('.')[1]] = match[1].split(', ').sort();
			}
			assert.deepEqual(
				actual,
				Object.fromEntries(
					Object.entries(contract.tables)
						.filter(([, rights]) => rights.length)
						.map(([name, rights]) => [name, [...rights].sort()])
				)
			);
		}
	);
}
test('malformed contracts and secret inputs are rejected before SQL construction', () => {
	const { contract, migrations } = readDatabaseAccess(
		join(root, 'apps/crm-access/prisma'),
		'crm-access'
	);
	for (const edit of [
		c => {
			c.service = 'billing';
		},
		c => {
			c.version = 2;
		},
		c => {
			c.tables['bad;name'] = ['SELECT'];
		},
		c => {
			c.tables.crm_teams = ['ALL'];
		},
		c => {
			c.tables.crm_teams = ['SELECT', 'SELECT'];
		},
		c => {
			c.tables._prisma_migrations = ['SELECT'];
		},
		c => {
			c.tables.service_identity = ['UPDATE'];
		},
		c => {
			c.sequences.extra = [];
		},
		c => {
			c.routines.push('bad()');
		},
		c => {
			c.extra = true;
		}
	]) {
		const candidate = structuredClone(contract);
		edit(candidate);
		assert.throws(() => validateDatabaseAccess(candidate, 'crm-access'));
	}
	for (const candidate of [
		{ ...passwords, runtime: passwords.backup },
		{ ...passwords, runtime: 'short' },
		{ ...passwords, extra: 'd'.repeat(64) }
	])
		assert.throws(() => databaseBootstrapSql(contract, candidate));
	assert.throws(() =>
		databaseRuntimeGrantsSql(contract, [...migrations, migrations[0]])
	);
	assert.throws(() =>
		databaseRuntimeGrantsSql(contract, [
			{ name: migrations[0].name, checksum: 'bad' }
		])
	);
});
test('source reader rejects symlinked owner manifests and migration files', () => {
	const directory = mkdtempSync(join(tmpdir(), 'crm-db-access-unit-'));
	try {
		const source = join(root, 'apps/crm-access/prisma');
		const target = join(directory, 'prisma');
		cpSync(source, target, { recursive: true });
		const { migrations } = readDatabaseAccess(target, 'crm-access');
		for (const suffix of [
			'database-access.json',
			'migrations/' + migrations[0].name + '/migration.sql'
		]) {
			const file = join(target, suffix);
			unlinkSync(file);
			symlinkSync(join(source, suffix), file);
			assert.throws(() => readDatabaseAccess(target, 'crm-access'));
			unlinkSync(file);
			cpSync(join(source, suffix), file);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
