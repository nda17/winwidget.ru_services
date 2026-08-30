import { Injectable } from '@nestjs/common';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

type AclRow = readonly [objectName: string, privilege: string];
export type DatabaseRestoreAclRoleMode = 'OPEN' | 'FENCED' | 'EITHER';

const PLATFORM_TABLES = [
	'_prisma_migrations',
	'billing_offer_producer_state',
	'home_page_content',
	'legal_pages',
	'outbox_events',
	'service_identity',
	'site_settings',
	'source_sequences'
] as const;

const TABLE_RELKINDS_SQL = "'r', 'p', 'v', 'm', 'f'";

const PLATFORM_RUNTIME_TABLE_ACL: readonly AclRow[] = [
	['billing_offer_producer_state', 'SELECT'],
	['home_page_content', 'SELECT'],
	['home_page_content', 'UPDATE'],
	['legal_pages', 'INSERT'],
	['legal_pages', 'SELECT'],
	['legal_pages', 'UPDATE'],
	['outbox_events', 'DELETE'],
	['outbox_events', 'INSERT'],
	['outbox_events', 'SELECT'],
	['outbox_events', 'UPDATE'],
	['service_identity', 'SELECT'],
	['site_settings', 'SELECT'],
	['site_settings', 'UPDATE'],
	['source_sequences', 'INSERT'],
	['source_sequences', 'SELECT'],
	['source_sequences', 'UPDATE']
];

const PLATFORM_RUNTIME_COLUMN_ACL: readonly AclRow[] = [
	['billing_offer_producer_state.current_aggregate_version', 'UPDATE'],
	['billing_offer_producer_state.current_source_sequence', 'UPDATE'],
	['billing_offer_producer_state.updated_at', 'UPDATE'],
	['service_identity.current_semantic_fingerprint', 'UPDATE'],
	['service_identity.updated_at', 'UPDATE']
];

@Injectable()
export class DatabaseRestoreAclService {
	constructor(private readonly process: DatabaseRestoreProcessService) {}

	async verify(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		signal?: AbortSignal,
		roleMode: DatabaseRestoreAclRoleMode = 'OPEN'
	): Promise<void> {
		await this.process.executeSql(
			connection,
			this.verificationSql(target, roleMode),
			signal
		);
	}

	async reconcileAndVerify(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		signal?: AbortSignal,
		roleMode: DatabaseRestoreAclRoleMode = 'OPEN'
	): Promise<void> {
		await this.process.executeSql(
			connection,
			this.reconciliationSql(target, roleMode),
			signal
		);
	}

	private reconciliationSql(
		target: DatabaseRestoreTargetConfiguration,
		roleMode: DatabaseRestoreAclRoleMode
	): string {
		const schema = this.identifier(target.schema);
		const migration = this.identifier(target.migrationRole);
		const runtime = this.identifier(target.runtimeRole);
		const backup = this.identifier(target.backupRole);
		const runtimeTableGrants =
			target.acl.profile === 'platform'
				? this.platformRuntimeGrants(schema, runtime)
				: [
						`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime};`,
						`REVOKE ALL PRIVILEGES ON TABLE ${schema}."_prisma_migrations" FROM ${runtime};`
					].join('\n');
		const runtimeRoutineGrants = target.acl.runtimeRoutines
			.map(
				routine =>
					`GRANT EXECUTE ON FUNCTION ${schema}.${this.routine(routine)} TO ${runtime};`
			)
			.join('\n');
		const standardRuntimeDefaults =
			target.acl.profile === 'standard'
				? [
						`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};`,
						`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime};`
					].join('\n')
				: '';
		const standardRuntimeSequenceGrants =
			target.acl.profile === 'standard'
				? `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime};`
				: '';

		return [
			'BEGIN;',
			`SET LOCAL ROLE ${migration};`,
			`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup};`,
			`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}, ${backup};`,
			`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup};`,
			`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup};`,
			`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup};`,
			runtimeTableGrants,
			standardRuntimeSequenceGrants,
			`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${backup};`,
			`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${backup};`,
			runtimeRoutineGrants,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${runtime}, ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${runtime}, ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, ${runtime}, ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, ${runtime}, ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, ${runtime}, ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, ${runtime}, ${backup};`,
			standardRuntimeDefaults,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT SELECT ON SEQUENCES TO ${backup};`,
			this.verificationSql(target, roleMode),
			'COMMIT;'
		]
			.filter(Boolean)
			.join('\n');
	}

	private verificationSql(
		target: DatabaseRestoreTargetConfiguration,
		roleMode: DatabaseRestoreAclRoleMode
	): string {
		const database = this.literal(target.database);
		const schema = this.literal(target.schema);
		const admin = this.literal(target.adminRole);
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		const loginBoundary =
			roleMode === 'OPEN'
				? 'NOT role_state.rolcanlogin'
				: roleMode === 'FENCED'
					? 'role_state.rolcanlogin'
					: 'FALSE';
		const loginConsistencyBoundary =
			roleMode === 'EITHER'
				? `(SELECT count(*) FROM pg_roles AS writer_state
					WHERE writer_state.oid IN (migration_oid, runtime_oid, backup_oid)
						AND writer_state.rolcanlogin) NOT IN (0, 3)`
				: 'FALSE';
		const routineValues = this.stringValues(
			target.acl.routines.map(routine => `${target.schema}.${routine}`),
			'signature'
		);
		const platformTableSet = this.aclValues(
			PLATFORM_TABLES.map(objectName => [objectName, 'r'] as const)
		);

		return `DO $database_restore_acl$
DECLARE
	admin_oid OID := to_regrole(${admin})::OID;
	migration_oid OID := to_regrole(${migration})::OID;
	runtime_oid OID := to_regrole(${runtime})::OID;
	backup_oid OID := to_regrole(${backup})::OID;
	schema_oid OID;
BEGIN
	SELECT namespace_state.oid INTO schema_oid
	FROM pg_namespace AS namespace_state
	WHERE namespace_state.nspname = ${schema};
		IF admin_oid IS NULL OR migration_oid IS NULL OR runtime_oid IS NULL
		OR backup_oid IS NULL OR schema_oid IS NULL THEN
		RAISE EXCEPTION 'Database restore ACL roles or schema are missing';
	END IF;
	IF current_database() <> ${database}
		OR (SELECT database_state.datdba FROM pg_database AS database_state
			WHERE database_state.datname = current_database()) <> admin_oid
		OR (SELECT namespace_state.nspowner FROM pg_namespace AS namespace_state
			WHERE namespace_state.oid = schema_oid) <> migration_oid THEN
			RAISE EXCEPTION 'Database restore ACL ownership boundary drifted';
		END IF;
		IF EXISTS (
			SELECT 1 FROM pg_roles AS role_state
			WHERE role_state.oid = admin_oid
				AND (NOT role_state.rolcanlogin OR NOT role_state.rolsuper)
		) THEN
			RAISE EXCEPTION 'Database restore bootstrap admin boundary drifted';
		END IF;
		IF EXISTS (
			SELECT 1 FROM pg_roles AS role_state
			WHERE role_state.oid <> admin_oid
				AND role_state.rolcanlogin AND role_state.rolsuper
		) THEN
			RAISE EXCEPTION 'Database restore has an unexpected login superuser';
		END IF;
		IF EXISTS (
		SELECT 1 FROM pg_roles AS role_state
		WHERE role_state.oid IN (migration_oid, runtime_oid, backup_oid)
			AND (${loginBoundary} OR ${loginConsistencyBoundary} OR role_state.rolsuper
				OR role_state.rolcreatedb OR role_state.rolcreaterole
				OR role_state.rolinherit OR role_state.rolreplication
				OR role_state.rolbypassrls)
		) OR EXISTS (
			SELECT 1 FROM pg_auth_members AS membership
			WHERE membership.member IN (admin_oid, migration_oid, runtime_oid, backup_oid)
				OR membership.roleid IN (admin_oid, migration_oid, runtime_oid, backup_oid)
	) THEN
		RAISE EXCEPTION 'Database restore ACL role boundary drifted';
	END IF;
	IF to_regclass(format('%I._prisma_migrations', ${schema})) IS NULL THEN
		RAISE EXCEPTION 'Database restore migration ledger is missing';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_class AS relation
		WHERE relation.relnamespace = schema_oid
			AND relation.relkind IN (${TABLE_RELKINDS_SQL}, 'S')
			AND relation.relowner <> migration_oid
	) OR EXISTS (
		SELECT 1 FROM pg_proc AS routine
		WHERE routine.pronamespace = schema_oid
			AND routine.proowner <> migration_oid
	) THEN
		RAISE EXCEPTION 'Database restore object ownership drifted';
	END IF;
	${
		target.acl.profile === 'platform'
			? `IF EXISTS (
			WITH expected(object_name, relkind) AS (${platformTableSet}),
			actual AS (
				SELECT relation.relname::TEXT AS object_name,
					relation.relkind::TEXT AS relkind
			FROM pg_class AS relation
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})
		)
		SELECT 1 FROM (
			(SELECT * FROM actual EXCEPT SELECT * FROM expected)
			UNION ALL
			(SELECT * FROM expected EXCEPT SELECT * FROM actual)
		) AS drift
	) THEN
			RAISE EXCEPTION 'Database restore Platform table allowlist drifted';
		END IF;
		IF EXISTS (
			SELECT 1 FROM pg_class AS relation
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind = 'S'
		) THEN
			RAISE EXCEPTION 'Database restore Platform sequence allowlist drifted';
		END IF;`
			: ''
	}
	IF EXISTS (
		WITH expected AS (${routineValues}),
		expected_oids AS (
			SELECT to_regprocedure(expected.signature)::OID AS oid FROM expected
		),
		actual AS (
			SELECT routine.oid FROM pg_proc AS routine
			WHERE routine.pronamespace = schema_oid
		)
		SELECT 1 FROM (
			SELECT 1 FROM expected_oids WHERE oid IS NULL
			UNION ALL
			SELECT 1 FROM actual WHERE oid NOT IN (
				SELECT oid FROM expected_oids WHERE oid IS NOT NULL
			)
			UNION ALL
			SELECT 1 FROM expected_oids WHERE oid IS NOT NULL
				AND oid NOT IN (SELECT oid FROM actual)
		) AS drift
	) THEN
		RAISE EXCEPTION 'Database restore routine allowlist drifted';
	END IF;
	${this.databaseAclCheck(target)}
	${this.schemaAclCheck(target)}
	${this.tableAclCheck(target)}
	${this.columnAclCheck(target)}
	${this.sequenceAclCheck(target)}
	${this.routineAclCheck(target)}
	${this.defaultAclCheck(target)}
END
	$database_restore_acl$;`;
	}

	private databaseAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const admin = this.literal(target.adminRole);
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		return this.driftCheck(
			'database privileges',
			`SELECT database_state.datname::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_database AS database_state
			CROSS JOIN LATERAL aclexplode(
				COALESCE(database_state.datacl, acldefault('d', database_state.datdba))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE database_state.datname = current_database()
				AND privilege.grantee <> database_state.datdba`,
			`SELECT * FROM (VALUES
				(${this.literal(target.database)}::TEXT, ${migration}::TEXT, 'CONNECT'::TEXT, FALSE, ${admin}::TEXT),
				(${this.literal(target.database)}::TEXT, ${runtime}::TEXT, 'CONNECT'::TEXT, FALSE, ${admin}::TEXT),
				(${this.literal(target.database)}::TEXT, ${backup}::TEXT, 'CONNECT'::TEXT, FALSE, ${admin}::TEXT)
			) AS expected(object_name, grantee, privilege_type, is_grantable, grantor)`
		);
	}

	private schemaAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		return this.driftCheck(
			'schema privileges',
			`SELECT ${this.literal(target.schema)}::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_namespace AS namespace_state
			CROSS JOIN LATERAL aclexplode(
				COALESCE(namespace_state.nspacl, acldefault('n', namespace_state.nspowner))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE namespace_state.oid = schema_oid
				AND privilege.grantee <> namespace_state.nspowner`,
			`SELECT * FROM (VALUES
				(${this.literal(target.schema)}::TEXT, ${runtime}::TEXT, 'USAGE'::TEXT, FALSE, ${migration}::TEXT),
				(${this.literal(target.schema)}::TEXT, ${backup}::TEXT, 'USAGE'::TEXT, FALSE, ${migration}::TEXT)
			) AS expected(object_name, grantee, privilege_type, is_grantable, grantor)`
		);
	}

	private tableAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		const expected =
			target.acl.profile === 'platform'
				? `SELECT expected.object_name::TEXT, ${runtime}::TEXT AS grantee,
				expected.privilege_type::TEXT, FALSE AS is_grantable,
				${migration}::TEXT AS grantor
			FROM (${this.aclValues(PLATFORM_RUNTIME_TABLE_ACL)})
				AS expected(object_name, privilege_type)
			UNION ALL
			SELECT relation.relname::TEXT, ${backup}::TEXT, 'SELECT'::TEXT,
				FALSE, ${migration}::TEXT
			FROM pg_class AS relation
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})`
				: `SELECT relation.relname::TEXT, ${runtime}::TEXT,
				expected_privilege.privilege_type::TEXT, FALSE, ${migration}::TEXT
			FROM pg_class AS relation
			CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'))
				AS expected_privilege(privilege_type)
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})
				AND relation.relname <> '_prisma_migrations'
			UNION ALL
			SELECT relation.relname::TEXT, ${backup}::TEXT, 'SELECT'::TEXT,
				FALSE, ${migration}::TEXT
			FROM pg_class AS relation
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})`;
		return this.driftCheck(
			'table privileges',
			`SELECT relation.relname::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_class AS relation
			CROSS JOIN LATERAL aclexplode(
				COALESCE(relation.relacl, acldefault('r', relation.relowner))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})
				AND privilege.grantee <> relation.relowner`,
			expected
		);
	}

	private columnAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const expected =
			target.acl.profile === 'platform'
				? `SELECT expected.object_name::TEXT, ${runtime}::TEXT AS grantee,
				expected.privilege_type::TEXT, FALSE AS is_grantable,
				${migration}::TEXT AS grantor
			FROM (${this.aclValues(PLATFORM_RUNTIME_COLUMN_ACL)})
				AS expected(object_name, privilege_type)`
				: `SELECT NULL::TEXT AS object_name, NULL::TEXT AS grantee,
				NULL::TEXT AS privilege_type, FALSE AS is_grantable,
				NULL::TEXT AS grantor WHERE FALSE`;
		return this.driftCheck(
			'column privileges',
			`SELECT (relation.relname || '.' || attribute.attname)::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_attribute AS attribute
			JOIN pg_class AS relation ON relation.oid = attribute.attrelid
			CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind IN (${TABLE_RELKINDS_SQL})
				AND attribute.attnum > 0 AND NOT attribute.attisdropped
				AND privilege.grantee <> relation.relowner`,
			expected
		);
	}

	private sequenceAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		const expected =
			target.acl.profile === 'platform'
				? `SELECT relation.relname::TEXT, ${backup}::TEXT, 'SELECT'::TEXT,
					FALSE, ${migration}::TEXT
				FROM pg_class AS relation
				WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'`
				: `SELECT relation.relname::TEXT, ${runtime}::TEXT,
					expected_privilege.privilege_type::TEXT, FALSE, ${migration}::TEXT
				FROM pg_class AS relation
				CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
					AS expected_privilege(privilege_type)
				WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'
				UNION ALL
				SELECT relation.relname::TEXT, ${backup}::TEXT, 'SELECT'::TEXT,
					FALSE, ${migration}::TEXT
				FROM pg_class AS relation
				WHERE relation.relnamespace = schema_oid AND relation.relkind = 'S'`;
		return this.driftCheck(
			'sequence privileges',
			`SELECT relation.relname::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_class AS relation
			CROSS JOIN LATERAL aclexplode(
				COALESCE(relation.relacl, acldefault('s', relation.relowner))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE relation.relnamespace = schema_oid
				AND relation.relkind = 'S'
				AND privilege.grantee <> relation.relowner`,
			expected
		);
	}

	private routineAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const expected = target.acl.runtimeRoutines.length
			? `SELECT to_regprocedure(expected.signature)::OID::TEXT,
				${runtime}::TEXT AS grantee, 'EXECUTE'::TEXT AS privilege_type,
				FALSE AS is_grantable, ${migration}::TEXT AS grantor
			FROM (${this.stringValues(
				target.acl.runtimeRoutines.map(
					routine => `${target.schema}.${routine}`
				),
				'signature'
			)}) AS expected`
			: `SELECT NULL::TEXT AS object_name, NULL::TEXT AS grantee,
				NULL::TEXT AS privilege_type, FALSE AS is_grantable,
				NULL::TEXT AS grantor WHERE FALSE`;
		return this.driftCheck(
			'routine privileges',
			`SELECT routine.oid::TEXT AS object_name,
				COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
				privilege.privilege_type::TEXT AS privilege_type,
				privilege.is_grantable,
				grantor.rolname::TEXT AS grantor
			FROM pg_proc AS routine
			CROSS JOIN LATERAL aclexplode(
				COALESCE(routine.proacl, acldefault('f', routine.proowner))
			) AS privilege
			LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
			JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
			WHERE routine.pronamespace = schema_oid
				AND privilege.grantee <> routine.proowner`,
			expected
		);
	}

	private defaultAclCheck(
		target: DatabaseRestoreTargetConfiguration
	): string {
		const migration = this.literal(target.migrationRole);
		const runtime = this.literal(target.runtimeRole);
		const backup = this.literal(target.backupRole);
		const tableRuntimePrivileges =
			target.acl.profile === 'platform'
				? []
				: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
		const tableExpected = [
			...tableRuntimePrivileges.map(
				privilege =>
					`(${runtime}::TEXT, ${this.literal(privilege)}::TEXT, FALSE, ${migration}::TEXT)`
			),
			`(${backup}::TEXT, 'SELECT'::TEXT, FALSE, ${migration}::TEXT)`
		].join(',\n');
		const sequenceRuntimePrivileges =
			target.acl.profile === 'platform'
				? []
				: ['USAGE', 'SELECT', 'UPDATE'];
		const sequenceExpected = sequenceRuntimePrivileges
			.map(
				privilege =>
					`(${runtime}::TEXT, ${this.literal(privilege)}::TEXT, FALSE, ${migration}::TEXT)`
			)
			.concat(
				`(${backup}::TEXT, 'SELECT'::TEXT, FALSE, ${migration}::TEXT)`
			)
			.join(',\n');
		return `IF EXISTS (
		SELECT 1 FROM pg_default_acl AS defaults
		WHERE defaults.defaclnamespace = schema_oid
			AND defaults.defaclrole <> migration_oid
	) THEN
		RAISE EXCEPTION 'Database restore default ACL owner drifted';
	END IF;
	IF (SELECT count(*)
		FROM pg_default_acl AS defaults
		CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
		WHERE defaults.defaclrole = migration_oid
			AND defaults.defaclnamespace = 0
			AND defaults.defaclobjtype = 'f') <> 1
		OR EXISTS (
			SELECT 1 FROM pg_default_acl AS defaults
			CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
			WHERE defaults.defaclrole = migration_oid
				AND defaults.defaclnamespace = 0
				AND defaults.defaclobjtype = 'f'
				AND (privilege.grantor <> migration_oid
					OR privilege.grantee <> migration_oid
					OR privilege.privilege_type <> 'EXECUTE'
					OR privilege.is_grantable)
		) THEN
		RAISE EXCEPTION 'Database restore global function default ACL drifted';
	END IF;
	IF EXISTS (
		SELECT 1 FROM pg_default_acl AS defaults
		CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
		WHERE defaults.defaclrole = migration_oid
			AND defaults.defaclnamespace = schema_oid
			AND defaults.defaclobjtype = 'f'
			AND privilege.grantee <> migration_oid
	) THEN
			RAISE EXCEPTION 'Database restore schema function default ACL drifted';
		END IF;
		${this.globalDefaultAclCheck('r', 'r', 'table')}
		${this.globalDefaultAclCheck('S', 's', 'sequence')}
	${this.driftCheck(
		'table default privileges',
		`SELECT COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
			privilege.privilege_type::TEXT AS privilege_type,
			privilege.is_grantable,
			grantor.rolname::TEXT AS grantor
		FROM pg_default_acl AS defaults
		CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
		LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
		JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
		WHERE defaults.defaclrole = migration_oid
			AND defaults.defaclnamespace = schema_oid
			AND defaults.defaclobjtype = 'r'
			AND privilege.grantee <> migration_oid`,
		`SELECT * FROM (VALUES ${tableExpected})
			AS expected(grantee, privilege_type, is_grantable, grantor)`
	)}
	${this.driftCheck(
		'sequence default privileges',
		`SELECT COALESCE(grantee.rolname, 'PUBLIC')::TEXT AS grantee,
			privilege.privilege_type::TEXT AS privilege_type,
			privilege.is_grantable,
			grantor.rolname::TEXT AS grantor
		FROM pg_default_acl AS defaults
		CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
		LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
		JOIN pg_roles AS grantor ON grantor.oid = privilege.grantor
		WHERE defaults.defaclrole = migration_oid
			AND defaults.defaclnamespace = schema_oid
			AND defaults.defaclobjtype = 'S'
			AND privilege.grantee <> migration_oid`,
		`SELECT * FROM (VALUES ${sequenceExpected})
			AS expected(grantee, privilege_type, is_grantable, grantor)`
	)} `;
	}

	private globalDefaultAclCheck(
		objectType: 'r' | 'S',
		aclDefaultType: 'r' | 's',
		label: 'table' | 'sequence'
	): string {
		return this.driftCheck(
			`global ${label} default privileges`,
			`SELECT privilege.grantee, privilege.privilege_type::TEXT,
				privilege.is_grantable, privilege.grantor
			FROM aclexplode(COALESCE(
				(SELECT defaults.defaclacl
				FROM pg_default_acl AS defaults
				WHERE defaults.defaclrole = migration_oid
					AND defaults.defaclnamespace = 0
					AND defaults.defaclobjtype = ${this.literal(objectType)}),
				acldefault(${this.literal(aclDefaultType)}, migration_oid)
			)) AS privilege`,
			`SELECT privilege.grantee, privilege.privilege_type::TEXT,
				privilege.is_grantable, privilege.grantor
			FROM aclexplode(
				acldefault(${this.literal(aclDefaultType)}, migration_oid)
			) AS privilege`
		);
	}

	private platformRuntimeGrants(schema: string, runtime: string): string {
		return [
			`GRANT SELECT ON TABLE ${schema}."service_identity", ${schema}."source_sequences", ${schema}."site_settings", ${schema}."legal_pages", ${schema}."home_page_content", ${schema}."billing_offer_producer_state", ${schema}."outbox_events" TO ${runtime};`,
			`GRANT INSERT ON TABLE ${schema}."source_sequences", ${schema}."legal_pages", ${schema}."outbox_events" TO ${runtime};`,
			`GRANT UPDATE ON TABLE ${schema}."source_sequences", ${schema}."site_settings", ${schema}."legal_pages", ${schema}."home_page_content", ${schema}."outbox_events" TO ${runtime};`,
			`GRANT DELETE ON TABLE ${schema}."outbox_events" TO ${runtime};`,
			`GRANT UPDATE ("current_semantic_fingerprint", "updated_at") ON TABLE ${schema}."service_identity" TO ${runtime};`,
			`GRANT UPDATE ("current_aggregate_version", "current_source_sequence", "updated_at") ON TABLE ${schema}."billing_offer_producer_state" TO ${runtime};`
		].join('\n');
	}

	private driftCheck(
		label: string,
		actual: string,
		expected: string
	): string {
		return `IF EXISTS (
		WITH actual AS (${actual}),
		expected AS (${expected})
		SELECT 1 FROM (
			(SELECT * FROM actual EXCEPT SELECT * FROM expected)
			UNION ALL
			(SELECT * FROM expected EXCEPT SELECT * FROM actual)
		) AS drift
	) THEN
		RAISE EXCEPTION ${this.literal(`Database restore ${label} drifted`)};
	END IF;`;
	}

	private aclValues(rows: readonly AclRow[]): string {
		return `VALUES ${rows
			.map(
				([objectName, privilege]) =>
					`(${this.literal(objectName)}::TEXT, ${this.literal(privilege)}::TEXT)`
			)
			.join(',\n')}`;
	}

	private stringValues(values: readonly string[], column: string): string {
		if (!values.length) {
			return `SELECT NULL::TEXT AS ${column} WHERE FALSE`;
		}
		return `SELECT value::TEXT AS ${column} FROM (VALUES ${values
			.map(value => `(${this.literal(value)})`)
			.join(', ')}) AS expected(value)`;
	}

	private routine(value: string): string {
		const match = /^([a-z_][a-z0-9_]*)\((|text)\)$/.exec(value);
		if (!match) throw new Error('Unsafe PostgreSQL routine signature');
		return `${this.identifier(match[1])}(${match[2].toUpperCase()})`;
	}

	private identifier(value: string): string {
		if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
			throw new Error('Unsafe PostgreSQL identifier');
		}
		return `"${value}"`;
	}

	private literal(value: string): string {
		if (/\u0000/.test(value)) throw new Error('Unsafe PostgreSQL literal');
		return `'${value.replaceAll("'", "''")}'`;
	}
}
