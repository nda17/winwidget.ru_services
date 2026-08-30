BEGIN;

DO $operations_routine_contract$
DECLARE
    schema_oid OID := to_regnamespace('operations');
    owner_oid OID := to_regrole(CURRENT_USER);
    expected_routines OID[] := ARRAY[]::OID[];
BEGIN
    IF schema_oid IS NULL OR (
        SELECT namespace_state.nspowner
        FROM pg_namespace AS namespace_state
        WHERE namespace_state.oid = schema_oid
    ) IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Operations schema must be owned by the current migration role';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_proc AS routine
        WHERE routine.pronamespace = schema_oid
    ) <> cardinality(expected_routines)
        OR EXISTS (
            SELECT 1
            FROM pg_proc AS routine
            WHERE routine.pronamespace = schema_oid
                AND NOT (routine.oid = ANY(expected_routines))
        )
        OR EXISTS (
            SELECT 1
            FROM pg_proc AS routine
            WHERE routine.pronamespace = schema_oid
                AND routine.proowner IS DISTINCT FROM owner_oid
        ) THEN
        RAISE EXCEPTION 'Operations routine allowlist or owner drifted';
    END IF;
END
$operations_routine_contract$;

ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "operations"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "operations" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "operations"
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "operations" FROM PUBLIC;

DO $operations_known_roles$
BEGIN
    IF to_regrole('winwidget_operations_runtime') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_operations_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_operations_runtime"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "operations" FROM "winwidget_operations_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM "winwidget_operations_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" REVOKE ALL ON SEQUENCES FROM "winwidget_operations_runtime"';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "operations" FROM "winwidget_operations_runtime"';
        EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "operations" TO "winwidget_operations_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "winwidget_operations_runtime"';
    END IF;
    IF to_regrole('winwidget_operations_backup') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_operations_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_operations_backup"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "operations" FROM "winwidget_operations_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM "winwidget_operations_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" REVOKE ALL ON SEQUENCES FROM "winwidget_operations_backup"';
        EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "operations" FROM "winwidget_operations_backup"';
        EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA "operations" TO "winwidget_operations_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "operations" GRANT SELECT ON SEQUENCES TO "winwidget_operations_backup"';
    END IF;
END
$operations_known_roles$;

DO $operations_routine_acl_verify$
DECLARE
    schema_oid OID := to_regnamespace('operations');
    owner_oid OID := to_regrole(CURRENT_USER);
    runtime_oid OID := to_regrole('winwidget_operations_runtime');
    backup_oid OID := to_regrole('winwidget_operations_backup');
BEGIN
    IF (
        SELECT count(*) = 1
            AND bool_and(
                privilege.grantor = owner_oid
                AND privilege.grantee = owner_oid
                AND privilege.privilege_type = 'EXECUTE'
                AND NOT privilege.is_grantable
            )
        FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        WHERE defaults.defaclrole = owner_oid
            AND defaults.defaclnamespace = 0
            AND defaults.defaclobjtype = 'f'
    ) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Operations global function default ACL is unsafe';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        WHERE defaults.defaclrole = owner_oid
            AND defaults.defaclnamespace = schema_oid
            AND defaults.defaclobjtype = 'f'
            AND privilege.grantee <> owner_oid
    ) OR EXISTS (
        SELECT 1
        FROM pg_proc AS routine
        CROSS JOIN LATERAL aclexplode(
            COALESCE(routine.proacl, acldefault('f', routine.proowner))
        ) AS privilege
        WHERE routine.pronamespace = schema_oid
            AND privilege.grantee <> routine.proowner
    ) THEN
        RAISE EXCEPTION 'Operations function ACL is not owner-only';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        WHERE defaults.defaclrole = owner_oid
            AND defaults.defaclnamespace = 0
            AND defaults.defaclobjtype = 'S'
            AND privilege.grantee <> owner_oid
    ) OR EXISTS (
        WITH actual AS (
            SELECT sequence_state.oid AS object_oid, privilege.grantee,
                privilege.privilege_type, privilege.is_grantable,
                privilege.grantor
            FROM pg_class AS sequence_state
            CROSS JOIN LATERAL aclexplode(
                COALESCE(
                    sequence_state.relacl,
                    acldefault('s', sequence_state.relowner)
                )
            ) AS privilege
            WHERE sequence_state.relnamespace = schema_oid
                AND sequence_state.relkind = 'S'
                AND privilege.grantee <> owner_oid
        ),
        expected AS (
            SELECT sequence_state.oid, runtime_oid, expected_privilege.name,
                FALSE, owner_oid
            FROM pg_class AS sequence_state
            CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
                AS expected_privilege(name)
            WHERE sequence_state.relnamespace = schema_oid
                AND sequence_state.relkind = 'S'
                AND runtime_oid IS NOT NULL
            UNION ALL
            SELECT sequence_state.oid, backup_oid, 'SELECT', FALSE, owner_oid
            FROM pg_class AS sequence_state
            WHERE sequence_state.relnamespace = schema_oid
                AND sequence_state.relkind = 'S'
                AND backup_oid IS NOT NULL
        )
        SELECT 1 FROM (
            (SELECT * FROM actual EXCEPT SELECT * FROM expected)
            UNION ALL
            (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        ) AS drift
    ) OR EXISTS (
        WITH actual AS (
            SELECT privilege.grantee, privilege.privilege_type,
                privilege.is_grantable, privilege.grantor
            FROM pg_default_acl AS defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
            WHERE defaults.defaclrole = owner_oid
                AND defaults.defaclnamespace = schema_oid
                AND defaults.defaclobjtype = 'S'
                AND privilege.grantee <> owner_oid
        ),
        expected AS (
            SELECT runtime_oid, expected_privilege.name, FALSE, owner_oid
            FROM (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
                AS expected_privilege(name)
            WHERE runtime_oid IS NOT NULL
            UNION ALL
            SELECT backup_oid, 'SELECT', FALSE, owner_oid
            WHERE backup_oid IS NOT NULL
        )
        SELECT 1 FROM (
            (SELECT * FROM actual EXCEPT SELECT * FROM expected)
            UNION ALL
            (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        ) AS drift
    ) THEN
        RAISE EXCEPTION 'Operations backup sequence ACL is unsafe';
    END IF;
END
$operations_routine_acl_verify$;

COMMIT;
