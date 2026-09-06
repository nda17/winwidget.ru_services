import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const services = [
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales'
];
const ident = value => {
	assert.ok(
		typeof value === 'string' &&
			/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)
	);
	return '"' + value + '"';
};
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const sha256 = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) =>
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const sorted = values => [...values].sort();

export function validateDatabaseAccess(value, service) {
	assert.ok(services.includes(service));
	exactKeys(value, [
		'version',
		'service',
		'tables',
		'sequences',
		'types',
		'routines'
	]);
	assert.equal(value.version, 1);
	assert.equal(value.service, service);
	for (const [kind, allowed] of [
		['tables', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']],
		['sequences', ['SELECT', 'USAGE']]
	]) {
		assert.ok(
			value[kind] &&
				typeof value[kind] === 'object' &&
				!Array.isArray(value[kind])
		);
		assert.ok(Object.keys(value[kind]).length <= 100);
		for (const [name, grants] of Object.entries(value[kind])) {
			ident(name);
			assert.ok(
				Array.isArray(grants) &&
					grants.every(grant => allowed.includes(grant))
			);
			assert.equal(new Set(grants).size, grants.length);
			if (kind === 'sequences') assert.ok(grants.length > 0);
		}
	}
	assert.ok(
		Object.keys(value.tables).length > 2 &&
			Object.keys(value.tables).length <= 100
	);
	assert.deepEqual(value.tables.service_identity, ['SELECT']);
	assert.deepEqual(value.tables._prisma_migrations, []);
	for (const kind of ['types', 'routines']) {
		assert.ok(Array.isArray(value[kind]) && value[kind].length <= 100);
		value[kind].forEach(ident);
		assert.equal(new Set(value[kind]).size, value[kind].length);
	}
	return structuredClone(value);
}

export function readDatabaseAccess(prismaDirectory, service) {
	const check = (path, directory = false) => {
		const stat = lstatSync(path);
		assert.ok(
			!stat.isSymbolicLink() &&
				(directory ? stat.isDirectory() : stat.isFile())
		);
	};
	check(prismaDirectory, true);
	const path = join(prismaDirectory, 'database-access.json');
	check(path);
	const bytes = readFileSync(path, 'utf8');
	assert.ok(Buffer.byteLength(bytes) <= 32768);
	const contract = validateDatabaseAccess(JSON.parse(bytes), service);
	const migrationsDirectory = join(prismaDirectory, 'migrations');
	check(migrationsDirectory, true);
	const entries = readdirSync(migrationsDirectory);
	if (entries.includes('migration_lock.toml'))
		check(join(migrationsDirectory, 'migration_lock.toml'));
	const migrations = entries
		.filter(name => name !== 'migration_lock.toml')
		.sort()
		.map(name => {
			assert.match(name, /^[0-9]{14}_[a-z0-9_]+$/);
			const directory = join(migrationsDirectory, name);
			check(directory, true);
			assert.deepEqual(readdirSync(directory), ['migration.sql']);
			const file = join(directory, 'migration.sql');
			check(file);
			return { name, checksum: sha256(readFileSync(file)) };
		});
	assert.ok(migrations.length > 0 && migrations.length <= 100);
	return { contract, migrations, accessSha256: sha256(bytes) };
}

const names = contract => {
	const schema = contract.service.replaceAll('-', '_');
	const database = 'winwidget_' + schema;
	return {
		schema,
		database,
		admin: database + '_admin',
		migration: database + '_migration',
		runtime: database + '_runtime',
		backup: database + '_backup'
	};
};
const guard = ({
	schema,
	database,
	admin,
	migration,
	runtime,
	backup
}) => `
DO $guard$ BEGIN
 IF current_database() <> ${literal(database)} OR current_user <> ${literal(admin)}
 OR current_setting('server_version_num')::integer NOT BETWEEN 180000 AND 189999
 OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
 OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> ${literal(admin)}
 THEN RAISE EXCEPTION 'CRM database ownership/version mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM pg_database WHERE datname NOT IN ('postgres','template0','template1',${literal(database)}))
 OR EXISTS (SELECT 1 FROM pg_roles WHERE NOT (oid < 16384 AND rolname ~ '^pg_') AND rolname NOT IN (${[admin, migration, runtime, backup].map(literal).join(',')}))
 THEN RAISE EXCEPTION 'CRM bootstrap requires an isolated owner cluster'; END IF;
 IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema', ${literal(schema)}) AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%')
 THEN RAISE EXCEPTION 'Unexpected schema in isolated CRM database'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
 OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
 THEN RAISE EXCEPTION 'Unexpected public objects in isolated CRM database'; END IF;
END $guard$;`;
const roleGuard = ({ migration, runtime, backup }) => `
DO $roles$ BEGIN
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN (${[migration, runtime, backup].map(literal).join(',')})
 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) <> 3
 OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (${[migration, runtime, backup].map(literal).join(',')}))
 OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN (${[migration, runtime, backup].map(literal).join(',')})))
 THEN RAISE EXCEPTION 'CRM database roles are missing or overprivileged'; END IF;
END $roles$;`;

// SECRET-BEARING RESULT. Feed only to psql stdin (-X, ON_ERROR_STOP), never
// argv, a tool log, an artifact or a single combined query API. psql executes
// the logging SET statements before submitting any password-bearing command.
// The release controller owns the outer shared lock and actual password probes.
export function databaseBootstrapSql(contract, passwords) {
	contract = validateDatabaseAccess(contract, contract.service);
	exactKeys(passwords, ['runtime', 'migration', 'backup']);
	assert.ok(
		Object.values(passwords).every(
			value =>
				typeof value === 'string' && /^[a-f0-9]{48,128}$/.test(value)
		)
	);
	assert.equal(new Set(Object.values(passwords)).size, 3);
	const n = names(contract);
	const statements = [
		"SET log_statement = 'none';",
		"SET log_min_error_statement = 'panic';",
		"SET log_min_messages = 'warning';",
		'BEGIN;',
		"SET LOCAL lock_timeout = '5s';",
		"SET LOCAL statement_timeout = '30s';",
		guard(n)
	];
	for (const role of ['runtime', 'migration', 'backup'])
		statements.push(`DO $create_role$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(n[role])}) THEN
 CREATE ROLE ${ident(n[role])} LOGIN PASSWORD ${literal(passwords[role])} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF; END $create_role$;`);
	statements.push(
		roleGuard(n),
		`REVOKE ALL ON DATABASE ${ident(n.database)}, postgres, template1 FROM PUBLIC, ${[n.migration, n.runtime, n.backup].map(ident).join(',')};`,
		`GRANT CONNECT ON DATABASE ${ident(n.database)} TO ${[n.migration, n.runtime, n.backup].map(ident).join(',')};`,
		`REVOKE ALL ON SCHEMA public FROM PUBLIC, ${[n.migration, n.runtime, n.backup].map(ident).join(',')};`,
		`CREATE SCHEMA IF NOT EXISTS ${ident(n.schema)} AUTHORIZATION ${ident(n.migration)};`,
		`DO $schema$ BEGIN IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = ${literal(n.schema)}) <> ${literal(n.migration)} THEN RAISE EXCEPTION 'CRM schema owner mismatch'; END IF; END $schema$;`,
		...['', ' IN SCHEMA ' + ident(n.schema)].flatMap(scope =>
			['TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES'].map(
				kind =>
					`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(n.migration)}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, ${ident(n.runtime)}, ${ident(n.backup)};`
			)
		),
		'COMMIT;'
	);
	return statements.join('\n') + '\n';
}

export function databaseRuntimeGrantsSql(contract, migrations) {
	contract = validateDatabaseAccess(contract, contract.service);
	assert.ok(
		Array.isArray(migrations) &&
			migrations.length > 0 &&
			migrations.length <= 100
	);
	for (const migration of migrations) {
		exactKeys(migration, ['name', 'checksum']);
		assert.match(migration.name, /^[0-9]{14}_[a-z0-9_]+$/);
		assert.match(migration.checksum, /^[a-f0-9]{64}$/);
	}
	assert.equal(
		new Set(migrations.map(item => item.name)).size,
		migrations.length
	);
	const n = names(contract);
	const schema = ident(n.schema);
	const tables = sorted(Object.keys(contract.tables));
	const json = value => literal(JSON.stringify(value)) + '::jsonb';
	const statements = [
		'BEGIN;',
		"SET LOCAL lock_timeout = '5s';",
		"SET LOCAL statement_timeout = '30s';",
		guard(n),
		roleGuard(n),
		`
DO $inventory$ BEGIN
 IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = ${literal(n.schema)}) <> ${literal(n.migration)}
 OR (SELECT coalesce(jsonb_agg(relname ORDER BY relname), '[]'::jsonb) FROM pg_class WHERE relnamespace = ${literal(n.schema)}::regnamespace AND relkind = 'r') <> ${json(tables)}
 OR (SELECT coalesce(jsonb_agg(relname ORDER BY relname), '[]'::jsonb) FROM pg_class WHERE relnamespace = ${literal(n.schema)}::regnamespace AND relkind = 'S') <> ${json(sorted(Object.keys(contract.sequences)))}
 OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = ${literal(n.schema)}::regnamespace AND (relkind NOT IN ('r','S','i') OR pg_get_userbyid(relowner) <> ${literal(n.migration)}))
 OR EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON a.attrelid=c.oid WHERE c.relnamespace = ${literal(n.schema)}::regnamespace AND a.attacl IS NOT NULL AND cardinality(a.attacl) > 0)
 OR (SELECT coalesce(jsonb_agg(typname ORDER BY typname), '[]'::jsonb) FROM pg_type WHERE typnamespace = ${literal(n.schema)}::regnamespace AND typtype = 'e') <> ${json(sorted(contract.types))}
 OR (SELECT coalesce(jsonb_agg(proname ORDER BY proname), '[]'::jsonb) FROM pg_proc WHERE pronamespace = ${literal(n.schema)}::regnamespace) <> ${json(sorted(contract.routines))}
 OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = ${literal(n.schema)}::regnamespace AND (pronargs <> 0 OR prorettype <> 'trigger'::regtype OR prosecdef OR pg_get_userbyid(proowner) <> ${literal(n.migration)}))
 THEN RAISE EXCEPTION 'CRM object inventory differs from its owner contract'; END IF;
 IF (SELECT count(*) FROM ${schema}.service_identity) <> 1 OR NOT EXISTS (SELECT 1 FROM ${schema}.service_identity WHERE id='singleton' AND service_name=${literal(contract.service + '-service')} AND database_id IS NOT NULL)
 THEN RAISE EXCEPTION 'CRM database identity mismatch'; END IF;
 IF (SELECT count(*) FROM ${schema}._prisma_migrations) <> ${migrations.length}
 OR EXISTS (SELECT 1 FROM ${schema}._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
 OR (SELECT jsonb_agg(jsonb_build_object('name',migration_name,'checksum',checksum) ORDER BY migration_name) FROM ${schema}._prisma_migrations) <> ${json([...migrations].sort((a, b) => a.name.localeCompare(b.name)))}
 THEN RAISE EXCEPTION 'CRM migration ledger differs from its exact source'; END IF;
END $inventory$;`,
		`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, ${ident(n.runtime)}, ${ident(n.backup)};`,
		`GRANT USAGE ON SCHEMA ${schema} TO ${ident(n.runtime)}, ${ident(n.backup)};`,
		`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${ident(n.runtime)}, ${ident(n.backup)};`,
		`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${ident(n.runtime)}, ${ident(n.backup)};`,
		`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC, ${ident(n.runtime)}, ${ident(n.backup)};`
	];
	for (const table of tables) {
		const target = schema + '.' + ident(table);
		if (contract.tables[table].length)
			statements.push(
				`GRANT ${contract.tables[table].join(', ')} ON ${target} TO ${ident(n.runtime)};`
			);
		statements.push(`GRANT SELECT ON ${target} TO ${ident(n.backup)};`);
	}
	for (const [sequence, rights] of Object.entries(contract.sequences)) {
		statements.push(
			`GRANT ${rights.join(', ')} ON SEQUENCE ${schema}.${ident(sequence)} TO ${ident(n.runtime)};`
		);
		statements.push(
			`GRANT SELECT ON SEQUENCE ${schema}.${ident(sequence)} TO ${ident(n.backup)};`
		);
	}
	for (const type of contract.types)
		statements.push(
			`REVOKE ALL ON TYPE ${schema}.${ident(type)} FROM PUBLIC;`,
			`GRANT USAGE ON TYPE ${schema}.${ident(type)} TO ${ident(n.runtime)}, ${ident(n.backup)};`
		);
	statements.push('COMMIT;');
	return statements.join('\n') + '\n';
}
