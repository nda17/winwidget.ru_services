import type { DatabaseRestoreTargetConfig } from '@/database-restore-worker/database-restore-worker.config';

const TOC_OBJECT_KINDS = [
	'MATERIALIZED VIEW DATA',
	'PUBLICATION TABLES IN SCHEMA',
	'TEXT SEARCH CONFIGURATION',
	'TEXT SEARCH DICTIONARY',
	'TEXT SEARCH TEMPLATE',
	'TEXT SEARCH PARSER',
	'SEQUENCE OWNED BY',
	'FOREIGN DATA WRAPPER',
	'CHECK CONSTRAINT',
	'MATERIALIZED VIEW',
	'OPERATOR FAMILY',
	'PUBLICATION TABLE',
	'BLOB COMMENTS',
	'DEFAULT ACL',
	'FK CONSTRAINT',
	'FOREIGN SERVER',
	'FOREIGN TABLE',
	'INDEX ATTACH',
	'OPERATOR CLASS',
	'TABLE ATTACH',
	'TABLE DATA',
	'USER MAPPING',
	'ACCESS METHOD',
	'AGGREGATE',
	'COLLATION',
	'CONSTRAINT',
	'CONVERSION',
	'EVENT TRIGGER',
	'PROCEDURE',
	'PUBLICATION',
	'ROW SECURITY',
	'SEARCHPATH',
	'SEQUENCE SET',
	'STATISTICS',
	'SUBSCRIPTION',
	'TRANSFORM',
	'ATTRDEF',
	'BLOB',
	'CAST',
	'COMMENT',
	'DATABASE',
	'DEFAULT',
	'DOMAIN',
	'ENCODING',
	'EXTENSION',
	'FUNCTION',
	'INDEX',
	'LANGUAGE',
	'OPERATOR',
	'POLICY',
	'RULE',
	'SCHEMA',
	'SEQUENCE',
	'SERVER',
	'STDSTRINGS',
	'TABLE',
	'TRIGGER',
	'TYPE',
	'VIEW',
	'ACL'
].sort((left, right) => right.length - left.length);

const ALLOWED_GLOBAL_TOC_KINDS = new Set([
	'ENCODING',
	'STDSTRINGS',
	'SEARCHPATH'
]);

const UNSUPPORTED_SCHEMA_TOC_KINDS = new Set([
	'COLLATION',
	'CONVERSION',
	'FOREIGN TABLE',
	'OPERATOR',
	'OPERATOR CLASS',
	'OPERATOR FAMILY',
	'PUBLICATION',
	'PUBLICATION TABLE',
	'PUBLICATION TABLES IN SCHEMA',
	'STATISTICS',
	'TEXT SEARCH CONFIGURATION',
	'TEXT SEARCH DICTIONARY',
	'TEXT SEARCH PARSER',
	'TEXT SEARCH TEMPLATE'
]);

export interface DatabaseRestoreTocSummary {
	entryCount: number;
	tables: ReadonlySet<string>;
}

export interface DatabaseRestoreMigrationChecksum {
	migrationName: string;
	checksum: string;
}

export function assertDatabaseRestoreTableOfContents(
	tableOfContents: string,
	target: DatabaseRestoreTargetConfig
): DatabaseRestoreTocSummary {
	const entries = tableOfContents
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line && !line.startsWith(';'));
	if (!entries.length) {
		throw new Error('PostgreSQL dump has no table of contents');
	}

	let containsTargetSchema = false;
	const tables = new Set<string>();
	for (const entry of entries) {
		const bodyMatch = entry.match(/^\d+;\s+\d+\s+\d+\s+(.+)$/);
		if (!bodyMatch) {
			throw new Error(
				'PostgreSQL dump contains an unrecognized TOC entry'
			);
		}
		const body = bodyMatch[1];
		const kind = TOC_OBJECT_KINDS.find(
			candidate => body === candidate || body.startsWith(`${candidate} `)
		);
		if (!kind) {
			throw new Error(
				'PostgreSQL dump contains an unsupported TOC object'
			);
		}
		const remainder = body.slice(kind.length).trim();

		if (ALLOWED_GLOBAL_TOC_KINDS.has(kind)) {
			if (!remainder.startsWith('- ')) {
				throw new Error('PostgreSQL dump contains unsafe global metadata');
			}
			continue;
		}
		if (kind === 'SCHEMA') {
			const schemaName = remainder.split(/\s+/, 3)[1];
			if (!remainder.startsWith('- ') || schemaName !== target.schema) {
				throw new Error('PostgreSQL dump targets a different schema');
			}
			containsTargetSchema = true;
			continue;
		}
		if (
			kind === 'COMMENT' &&
			remainder.startsWith(`- SCHEMA ${target.schema} `)
		) {
			continue;
		}
		if (UNSUPPORTED_SCHEMA_TOC_KINDS.has(kind)) {
			throw new Error(
				'PostgreSQL dump contains a schema object whose ownership cannot be restored safely'
			);
		}

		const [schemaName, objectName] = remainder.split(/\s+/, 3);
		if (schemaName !== target.schema) {
			throw new Error(
				'PostgreSQL dump contains objects outside target schema'
			);
		}
		if (kind === 'TABLE' && objectName) tables.add(objectName);
	}

	if (!containsTargetSchema) {
		throw new Error('PostgreSQL dump does not declare the target schema');
	}
	for (const anchor of target.anchorTables) {
		if (!tables.has(anchor)) {
			throw new Error(
				`PostgreSQL dump is missing target anchor ${anchor}`
			);
		}
	}

	return { entryCount: entries.length, tables };
}

export function buildDatabaseFenceSql(
	target: DatabaseRestoreTargetConfig
): string {
	const database = quoteIdentifier(target.database);
	const admin = quoteIdentifier(target.adminRole);
	const applicationRoles = target.allApplicationRoles
		.map(quoteIdentifier)
		.join(', ');

	return `
BEGIN;
ALTER DATABASE ${database} OWNER TO ${admin};
REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;
REVOKE CONNECT ON DATABASE ${database} FROM ${applicationRoles};
COMMIT;
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = ${quoteLiteral(target.database)}
  AND pid <> pg_backend_pid();
`;
}

export function buildDatabaseConnectionPreflightSql(
	target: DatabaseRestoreTargetConfig
): string {
	const databaseLiteral = quoteLiteral(target.database);
	const schemaLiteral = quoteLiteral(target.schema);
	const adminLiteral = quoteLiteral(target.adminRole);
	const applicationRolesSql = sqlTextArray(target.allApplicationRoles);

	return `
DO $database_restore_preflight$
DECLARE
    role_name TEXT;
BEGIN
    IF current_database() <> ${databaseLiteral}
       OR current_user <> ${adminLiteral} THEN
        RAISE EXCEPTION 'Unexpected restore database or administrator';
    END IF;
    IF current_setting('server_version_num')::INTEGER < 180000
       OR current_setting('server_version_num')::INTEGER >= 190000 THEN
        RAISE EXCEPTION 'Database restore requires PostgreSQL 18';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_database database_state
        JOIN pg_roles owner_role ON owner_role.oid = database_state.datdba
        WHERE database_state.datname = ${databaseLiteral}
          AND database_state.datallowconn
          AND owner_role.rolname = ${adminLiteral}
    ) THEN
        RAISE EXCEPTION 'Restore database identity or owner is invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_namespace
        WHERE nspname = ${schemaLiteral}
    ) THEN
        RAISE EXCEPTION 'Restore target schema is missing';
    END IF;
    FOREACH role_name IN ARRAY ${applicationRolesSql} LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = role_name
              AND rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolreplication
              AND NOT rolbypassrls
        ) OR NOT pg_has_role(current_user, role_name, 'MEMBER') THEN
            RAISE EXCEPTION 'Restore application role boundary is invalid';
        END IF;
    END LOOP;
END
$database_restore_preflight$;
SELECT pg_database_size(current_database())::TEXT;
`;
}

export function buildDatabaseOwnershipAndAclRepairSql(
	target: DatabaseRestoreTargetConfig
): string {
	const database = quoteIdentifier(target.database);
	const schema = quoteIdentifier(target.schema);
	const schemaLiteral = quoteLiteral(target.schema);
	const migration = quoteIdentifier(target.migrationRole);
	const migrationLiteral = quoteLiteral(target.migrationRole);
	const restrictedRoles = target.allApplicationRoles
		.map(quoteIdentifier)
		.join(', ');
	const functionDefaultRestrictedRoles = [
		'PUBLIC',
		...target.runtimeRoles.map(quoteIdentifier),
		quoteIdentifier(target.backupRole)
	].join(', ');
	const runtimeAclSql = buildRuntimeAclRepairSql(target);

	return `
ALTER SCHEMA ${schema} OWNER TO ${migration};
DO $database_restore_owners$
DECLARE
    object_record RECORD;
BEGIN
    FOR object_record IN
        SELECT c.relkind, c.oid::regclass AS object_identity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schemaLiteral}
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        ORDER BY c.oid
    LOOP
        EXECUTE CASE object_record.relkind
            WHEN 'v' THEN format('ALTER VIEW %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            WHEN 'S' THEN format('ALTER SEQUENCE %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            WHEN 'f' THEN format('ALTER FOREIGN TABLE %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            ELSE format('ALTER TABLE %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
        END;
    END LOOP;

    FOR object_record IN
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ${schemaLiteral}
          AND t.typtype IN ('d', 'e')
        ORDER BY t.oid
    LOOP
        EXECUTE format(
            'ALTER TYPE %I.%I OWNER TO %I',
            ${schemaLiteral},
            object_record.typname,
            ${migrationLiteral}
        );
    END LOOP;

    FOR object_record IN
        SELECT p.oid::regprocedure AS object_identity, p.prokind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${schemaLiteral}
        ORDER BY p.oid
    LOOP
        EXECUTE CASE object_record.prokind
            WHEN 'p' THEN format('ALTER PROCEDURE %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            WHEN 'a' THEN format('ALTER AGGREGATE %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
            ELSE format('ALTER FUNCTION %s OWNER TO %I', object_record.object_identity, ${migrationLiteral})
        END;
    END LOOP;
END
$database_restore_owners$;

REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM ${restrictedRoles};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${migration};
REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration}
    REVOKE ALL ON FUNCTIONS FROM ${functionDefaultRestrictedRoles};
${runtimeAclSql}
`;
}

export function buildDatabasePreReopenVerificationSql(
	target: DatabaseRestoreTargetConfig
): string {
	const schemaLiteral = quoteLiteral(target.schema);
	const databaseLiteral = quoteLiteral(target.database);
	const adminLiteral = quoteLiteral(target.adminRole);
	const migrationLiteral = quoteLiteral(target.migrationRole);
	const applicationRolesSql = sqlTextArray(target.allApplicationRoles);
	const anchorTablesSql = sqlTextArray(target.anchorTables);
	const runtimeAclVerificationSql = buildRuntimeAclVerificationSql(target);

	return `
DO $database_restore_verify$
DECLARE
    role_name TEXT;
    table_name TEXT;
    function_signature TEXT;
BEGIN
    IF current_user <> ${adminLiteral}
       OR current_database() <> ${databaseLiteral} THEN
        RAISE EXCEPTION 'Unexpected restore administrator or database';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_database d
        JOIN pg_roles owner_role ON owner_role.oid = d.datdba
        WHERE d.datname = current_database()
          AND owner_role.rolname = ${adminLiteral}
    ) THEN
        RAISE EXCEPTION 'Database is not fenced under the admin owner';
    END IF;

    FOREACH role_name IN ARRAY ${applicationRolesSql} LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_roles
            WHERE rolname = role_name
              AND rolcanlogin
              AND NOT rolsuper
              AND NOT rolcreatedb
              AND NOT rolcreaterole
              AND NOT rolreplication
              AND NOT rolbypassrls
        ) THEN
            RAISE EXCEPTION 'Required application role is missing or privileged';
        END IF;
        IF has_database_privilege(role_name, current_database(), 'CONNECT') THEN
            RAISE EXCEPTION 'Application role can connect while database is fenced';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_auth_members membership
            JOIN pg_roles member_role ON member_role.oid = membership.member
            WHERE member_role.rolname = role_name
        ) THEN
            RAISE EXCEPTION 'Application role has unsafe role memberships';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_database d
        CROSS JOIN LATERAL aclexplode(
            COALESCE(d.datacl, acldefault('d', d.datdba))
        ) privilege
        WHERE d.datname = current_database()
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'CONNECT'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can connect to fenced database';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_namespace n
        JOIN pg_roles owner_role ON owner_role.oid = n.nspowner
        WHERE n.nspname = ${schemaLiteral}
          AND owner_role.rolname = ${migrationLiteral}
    ) THEN
        RAISE EXCEPTION 'Target schema owner is invalid';
    END IF;

    FOREACH table_name IN ARRAY ${anchorTablesSql} LOOP
        IF to_regclass(format('%I.%I', ${schemaLiteral}, table_name)) IS NULL THEN
            RAISE EXCEPTION 'Required target table is missing';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles owner_role ON owner_role.oid = c.relowner
        WHERE n.nspname = ${schemaLiteral}
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND owner_role.rolname <> ${migrationLiteral}
    ) THEN
        RAISE EXCEPTION 'Target relation ownership is invalid';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_roles owner_role ON owner_role.oid = p.proowner
        WHERE n.nspname = ${schemaLiteral}
          AND owner_role.rolname <> ${migrationLiteral}
    ) OR EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_roles owner_role ON owner_role.oid = t.typowner
        WHERE n.nspname = ${schemaLiteral}
          AND t.typtype IN ('d', 'e')
          AND owner_role.rolname <> ${migrationLiteral}
    ) THEN
        RAISE EXCEPTION 'Target routine or type ownership is invalid';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_namespace n
        CROSS JOIN LATERAL aclexplode(
            COALESCE(n.nspacl, acldefault('n', n.nspowner))
        ) privilege
        WHERE n.nspname = ${schemaLiteral}
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains target schema privileges';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))
        ) privilege
        WHERE n.nspname = ${schemaLiteral}
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains target relation privileges';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
        ) privilege
        WHERE n.nspname = ${schemaLiteral}
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC retains target routine privileges';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM aclexplode(
            COALESCE(
                (
                    SELECT defaults.defaclacl
                    FROM pg_default_acl defaults
                    WHERE defaults.defaclrole = to_regrole(${migrationLiteral})::oid
                      AND defaults.defaclnamespace = 0
                      AND defaults.defaclobjtype = 'f'
                ),
                acldefault('f', to_regrole(${migrationLiteral})::oid)
            )
        ) privilege
        WHERE privilege.grantee <> to_regrole(${migrationLiteral})::oid
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
        WHERE defaults.defaclrole = to_regrole(${migrationLiteral})::oid
          AND defaults.defaclnamespace = 0
          AND defaults.defaclobjtype = 'f'
        GROUP BY defaults.oid
        HAVING count(*) = 1
           AND bool_and(
               privilege.grantor = to_regrole(${migrationLiteral})::oid
               AND privilege.grantee = to_regrole(${migrationLiteral})::oid
               AND privilege.privilege_type = 'EXECUTE'
               AND NOT privilege.is_grantable
           )
    ) OR EXISTS (
        SELECT 1
        FROM pg_default_acl defaults
        JOIN pg_namespace n ON n.oid = defaults.defaclnamespace
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
        WHERE defaults.defaclrole = to_regrole(${migrationLiteral})::oid
          AND n.nspname = ${schemaLiteral}
          AND defaults.defaclobjtype = 'f'
          AND privilege.grantee <> to_regrole(${migrationLiteral})::oid
    ) THEN
        RAISE EXCEPTION 'Future routine default ACL is invalid';
    END IF;

${runtimeAclVerificationSql}

    IF NOT has_schema_privilege(${quoteLiteral(target.backupRole)}, ${schemaLiteral}, 'USAGE')
       OR has_schema_privilege(${quoteLiteral(target.backupRole)}, ${schemaLiteral}, 'CREATE') THEN
        RAISE EXCEPTION 'Backup role schema ACL is invalid';
    END IF;
    FOR table_name IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = ${schemaLiteral}
        ORDER BY tablename
    LOOP
        IF NOT has_table_privilege(${quoteLiteral(target.backupRole)}, format('%I.%I', ${schemaLiteral}, table_name), 'SELECT')
           OR has_table_privilege(${quoteLiteral(target.backupRole)}, format('%I.%I', ${schemaLiteral}, table_name), 'INSERT')
           OR has_table_privilege(${quoteLiteral(target.backupRole)}, format('%I.%I', ${schemaLiteral}, table_name), 'UPDATE')
           OR has_table_privilege(${quoteLiteral(target.backupRole)}, format('%I.%I', ${schemaLiteral}, table_name), 'DELETE') THEN
            RAISE EXCEPTION 'Backup role table ACL is invalid';
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schemaLiteral}
          AND c.relkind = 'S'
          AND (
              NOT has_sequence_privilege(${quoteLiteral(target.backupRole)}, c.oid, 'SELECT')
              OR has_sequence_privilege(${quoteLiteral(target.backupRole)}, c.oid, 'USAGE')
              OR has_sequence_privilege(${quoteLiteral(target.backupRole)}, c.oid, 'UPDATE')
          )
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${schemaLiteral}
          AND has_function_privilege(${quoteLiteral(target.backupRole)}, p.oid, 'EXECUTE')
    ) THEN
        RAISE EXCEPTION 'Backup role sequence or routine ACL is invalid';
    END IF;
END
$database_restore_verify$;
`;
}

export function buildDatabaseReopenSql(
	target: DatabaseRestoreTargetConfig
): string {
	const database = quoteIdentifier(target.database);
	const databaseLiteral = quoteLiteral(target.database);
	const admin = quoteIdentifier(target.adminRole);
	const adminLiteral = quoteLiteral(target.adminRole);
	const applicationRoles = target.allApplicationRoles
		.map(quoteIdentifier)
		.join(', ');
	const restrictedRolesSql = sqlTextArray(target.allApplicationRoles);

	return `
BEGIN;
ALTER DATABASE ${database} OWNER TO ${admin};
GRANT CONNECT ON DATABASE ${database} TO ${applicationRoles};
COMMIT;
DO $database_restore_reopen_verify$
DECLARE
    role_name TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_database d
        JOIN pg_roles owner_role ON owner_role.oid = d.datdba
        WHERE d.datname = ${databaseLiteral}
          AND owner_role.rolname = ${adminLiteral}
    ) THEN
        RAISE EXCEPTION 'Restored database owner is invalid';
    END IF;
    FOREACH role_name IN ARRAY ${sqlTextArray(target.allApplicationRoles)} LOOP
        IF NOT has_database_privilege(role_name, ${databaseLiteral}, 'CONNECT') THEN
            RAISE EXCEPTION 'Required role cannot connect after restore';
        END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ${restrictedRolesSql} LOOP
        IF has_database_privilege(role_name, ${databaseLiteral}, 'CREATE')
           OR has_database_privilege(role_name, ${databaseLiteral}, 'TEMPORARY') THEN
            RAISE EXCEPTION 'Restricted role has unsafe database privileges';
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1
        FROM pg_database d
        CROSS JOIN LATERAL aclexplode(
            COALESCE(d.datacl, acldefault('d', d.datdba))
        ) privilege
        WHERE d.datname = ${databaseLiteral}
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'CONNECT'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can connect after restore';
    END IF;
END
$database_restore_reopen_verify$;
`;
}

export function parseDatabaseMigrationRows(
	stdout: string
): DatabaseRestoreMigrationChecksum[] {
	return stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => {
			const [migrationName, checksum, state, ...extra] = line.split('\t');
			if (
				extra.length ||
				!migrationName ||
				!checksum ||
				!state ||
				!/^[0-9]{14}_[a-z0-9_]+$/.test(migrationName) ||
				!/^[0-9a-f]{64}$/.test(checksum) ||
				state !== 'applied'
			) {
				throw new Error('Restored Prisma migration ledger is invalid');
			}
			return { migrationName, checksum };
		});
}

export function assertExactDatabaseMigrations(
	actual: readonly DatabaseRestoreMigrationChecksum[],
	expected: readonly DatabaseRestoreMigrationChecksum[]
): void {
	if (
		actual.length !== expected.length ||
		actual.some(
			(row, index) =>
				row.migrationName !== expected[index].migrationName ||
				row.checksum !== expected[index].checksum
		)
	) {
		throw new Error(
			'Restored Prisma migrations do not match this release'
		);
	}
}

export function buildMigrationLedgerQuery(
	target: DatabaseRestoreTargetConfig
): string {
	return `
SELECT migration_name || E'\\t' || checksum || E'\\t' ||
       CASE
           WHEN finished_at IS NOT NULL AND rolled_back_at IS NULL
               THEN 'applied'
           ELSE 'invalid'
       END
FROM ${quoteIdentifier(target.schema)}."_prisma_migrations"
ORDER BY migration_name;
`;
}

function buildRuntimeAclRepairSql(
	target: DatabaseRestoreTargetConfig
): string {
	const schema = quoteIdentifier(target.schema);
	const migration = quoteIdentifier(target.migrationRole);
	const primaryRuntime = quoteIdentifier(target.runtimeRoles[0]);
	const runtimeRoles = target.runtimeRoles.map(quoteIdentifier).join(', ');
	const backup = quoteIdentifier(target.backupRole);
	const defaultPrivilegeRoles = `${runtimeRoles}, ${backup}`;

	return `
REVOKE ALL ON SCHEMA ${schema} FROM ${runtimeRoles}, ${backup};
REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${runtimeRoles}, ${backup};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtimeRoles}, ${backup};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${runtimeRoles}, ${backup};
GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRoles}, ${backup};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${primaryRuntime};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${primaryRuntime};
REVOKE ALL ON TABLE ${schema}."_prisma_migrations" FROM ${primaryRuntime};
GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${backup};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${backup};

ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON TABLES FROM ${defaultPrivilegeRoles};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON SEQUENCES FROM ${defaultPrivilegeRoles};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    REVOKE ALL ON FUNCTIONS FROM ${defaultPrivilegeRoles};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${primaryRuntime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${primaryRuntime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    GRANT SELECT ON TABLES TO ${backup};
ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema}
    GRANT SELECT ON SEQUENCES TO ${backup};
`;
}

function buildRuntimeAclVerificationSql(
	target: DatabaseRestoreTargetConfig
): string {
	const schemaLiteral = quoteLiteral(target.schema);
	const primaryRuntimeLiteral = quoteLiteral(target.runtimeRoles[0]);
	const baseRuntimeChecks = `
    IF NOT has_schema_privilege(${primaryRuntimeLiteral}, ${schemaLiteral}, 'USAGE')
       OR has_schema_privilege(${primaryRuntimeLiteral}, ${schemaLiteral}, 'CREATE') THEN
        RAISE EXCEPTION 'Primary runtime schema ACL is invalid';
    END IF;
    FOR table_name IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = ${schemaLiteral}
        ORDER BY tablename
    LOOP
        IF has_table_privilege(${primaryRuntimeLiteral}, format('%I.%I', ${schemaLiteral}, table_name), 'SELECT')
               IS DISTINCT FROM (table_name <> '_prisma_migrations')
           OR has_table_privilege(${primaryRuntimeLiteral}, format('%I.%I', ${schemaLiteral}, table_name), 'INSERT')
               IS DISTINCT FROM (table_name <> '_prisma_migrations')
           OR has_table_privilege(${primaryRuntimeLiteral}, format('%I.%I', ${schemaLiteral}, table_name), 'UPDATE')
               IS DISTINCT FROM (table_name <> '_prisma_migrations')
           OR has_table_privilege(${primaryRuntimeLiteral}, format('%I.%I', ${schemaLiteral}, table_name), 'DELETE')
               IS DISTINCT FROM (table_name <> '_prisma_migrations') THEN
            RAISE EXCEPTION 'Primary runtime table ACL is invalid';
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schemaLiteral}
          AND c.relkind = 'S'
          AND NOT (
              has_sequence_privilege(${primaryRuntimeLiteral}, c.oid, 'USAGE')
              AND has_sequence_privilege(${primaryRuntimeLiteral}, c.oid, 'SELECT')
              AND has_sequence_privilege(${primaryRuntimeLiteral}, c.oid, 'UPDATE')
          )
    ) THEN
        RAISE EXCEPTION 'Primary runtime sequence ACL is invalid';
    END IF;
`;

	return `${baseRuntimeChecks}
    IF EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${schemaLiteral}
          AND has_function_privilege(${primaryRuntimeLiteral}, p.oid, 'EXECUTE')
    ) THEN
        RAISE EXCEPTION 'Service runtime has unexpected routine execution privilege';
    END IF;
`;
}

function sqlTextArray(values: readonly string[]): string {
	return `ARRAY[${values.map(quoteLiteral).join(', ')}]::TEXT[]`;
}

function quoteIdentifier(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(
			'Unsafe PostgreSQL identifier in restore configuration'
		);
	}
	return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
