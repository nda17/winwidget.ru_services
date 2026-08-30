BEGIN;

DO $platform_routine_contract$
DECLARE
    schema_oid OID := to_regnamespace('platform');
    owner_oid OID := to_regrole(CURRENT_USER);
    expected_routines OID[] := ARRAY[
        to_regprocedure('platform.current_semantic_fingerprint()')::OID,
        to_regprocedure('platform.refresh_current_semantic_fingerprint(text)')::OID,
        to_regprocedure('platform.enforce_current_semantic_fingerprint()')::OID,
        to_regprocedure('platform.enforce_service_identity_integrity()')::OID,
        to_regprocedure('platform.enforce_billing_offer_producer_cursor()')::OID
    ];
BEGIN
    IF schema_oid IS NULL OR (
        SELECT namespace_state.nspowner
        FROM pg_namespace AS namespace_state
        WHERE namespace_state.oid = schema_oid
    ) IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Platform schema must be owned by the current migration role';
    END IF;

    IF EXISTS (
        SELECT 1 FROM unnest(expected_routines) AS expected(oid)
        WHERE expected.oid IS NULL
    ) OR (
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
        RAISE EXCEPTION 'Platform routine allowlist or owner drifted';
    END IF;
END
$platform_routine_contract$;

ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "platform"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "platform" FROM PUBLIC;
ALTER DEFAULT PRIVILEGES
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES
    REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "platform"
    REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "platform"
    REVOKE ALL ON SEQUENCES FROM PUBLIC;

DO $platform_known_roles$
BEGIN
    IF to_regrole('winwidget_platform_runtime') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_platform_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_platform_runtime"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "platform" FROM "winwidget_platform_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM "winwidget_platform_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM "winwidget_platform_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE ALL ON TABLES FROM "winwidget_platform_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE ALL ON SEQUENCES FROM "winwidget_platform_runtime"';
        EXECUTE 'GRANT EXECUTE ON FUNCTION "platform"."current_semantic_fingerprint"() TO "winwidget_platform_runtime"';
        EXECUTE 'GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT) TO "winwidget_platform_runtime"';
    END IF;
    IF to_regrole('winwidget_platform_backup') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_platform_backup"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "platform" FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE ALL ON TABLES FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" REVOKE ALL ON SEQUENCES FROM "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" GRANT SELECT ON TABLES TO "winwidget_platform_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "platform" GRANT SELECT ON SEQUENCES TO "winwidget_platform_backup"';
    END IF;
END
$platform_known_roles$;

DO $platform_routine_acl_verify$
DECLARE
    schema_oid OID := to_regnamespace('platform');
    owner_oid OID := to_regrole(CURRENT_USER);
    runtime_oid OID := to_regrole('winwidget_platform_runtime');
    backup_oid OID := to_regrole('winwidget_platform_backup');
    runtime_routines OID[] := ARRAY[
        to_regprocedure('platform.current_semantic_fingerprint()')::OID,
        to_regprocedure('platform.refresh_current_semantic_fingerprint(text)')::OID
    ];
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
        RAISE EXCEPTION 'Platform global function default ACL is unsafe';
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
            AND NOT (
                runtime_oid IS NOT NULL
                AND privilege.grantor = owner_oid
                AND privilege.grantee = runtime_oid
                AND routine.oid = ANY(runtime_routines)
                AND privilege.privilege_type = 'EXECUTE'
                AND NOT privilege.is_grantable
            )
    ) THEN
        RAISE EXCEPTION 'Platform function ACL contains a non-allowlisted grant';
    END IF;

    IF runtime_oid IS NOT NULL AND EXISTS (
        SELECT 1
        FROM unnest(runtime_routines) AS expected(oid)
        WHERE NOT EXISTS (
            SELECT 1
            FROM pg_proc AS routine
            CROSS JOIN LATERAL aclexplode(
                COALESCE(routine.proacl, acldefault('f', routine.proowner))
            ) AS privilege
            WHERE routine.oid = expected.oid
                AND privilege.grantor = owner_oid
                AND privilege.grantee = runtime_oid
                AND privilege.privilege_type = 'EXECUTE'
                AND NOT privilege.is_grantable
        )
    ) THEN
        RAISE EXCEPTION 'Platform runtime function allowlist is incomplete';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        WHERE defaults.defaclnamespace = schema_oid
            AND defaults.defaclrole <> owner_oid
    ) THEN
        RAISE EXCEPTION 'Platform schema default ACL owner drifted';
    END IF;

    IF EXISTS (
        WITH actual AS (
            SELECT 'r'::TEXT AS object_type, privilege.grantee,
                privilege.privilege_type, privilege.is_grantable,
                privilege.grantor
            FROM aclexplode(COALESCE(
                (
                    SELECT defaults.defaclacl
                    FROM pg_default_acl AS defaults
                    WHERE defaults.defaclrole = owner_oid
                        AND defaults.defaclnamespace = 0
                        AND defaults.defaclobjtype = 'r'
                ),
                acldefault('r', owner_oid)
            )) AS privilege
            UNION ALL
            SELECT 'S', privilege.grantee, privilege.privilege_type,
                privilege.is_grantable, privilege.grantor
            FROM aclexplode(COALESCE(
                (
                    SELECT defaults.defaclacl
                    FROM pg_default_acl AS defaults
                    WHERE defaults.defaclrole = owner_oid
                        AND defaults.defaclnamespace = 0
                        AND defaults.defaclobjtype = 'S'
                ),
                acldefault('s', owner_oid)
            )) AS privilege
        ),
        expected AS (
            SELECT 'r'::TEXT, privilege.grantee, privilege.privilege_type,
                privilege.is_grantable, privilege.grantor
            FROM aclexplode(acldefault('r', owner_oid)) AS privilege
            UNION ALL
            SELECT 'S', privilege.grantee, privilege.privilege_type,
                privilege.is_grantable, privilege.grantor
            FROM aclexplode(acldefault('s', owner_oid)) AS privilege
        )
        SELECT 1 FROM (
            (SELECT * FROM actual EXCEPT SELECT * FROM expected)
            UNION ALL
            (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        ) AS drift
    ) THEN
        RAISE EXCEPTION 'Platform global relation default ACL is unsafe';
    END IF;

    IF EXISTS (
        WITH actual AS (
            SELECT defaults.defaclobjtype::TEXT AS object_type,
                privilege.grantee, privilege.privilege_type,
                privilege.is_grantable, privilege.grantor
            FROM pg_default_acl AS defaults
            CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
            WHERE defaults.defaclrole = owner_oid
                AND defaults.defaclnamespace = schema_oid
                AND defaults.defaclobjtype IN ('r', 'S')
                AND privilege.grantee <> owner_oid
        ),
        expected AS (
            SELECT expected.object_type, backup_oid, 'SELECT'::TEXT,
                FALSE, owner_oid
            FROM (VALUES ('r'::TEXT), ('S'::TEXT))
                AS expected(object_type)
            WHERE backup_oid IS NOT NULL
        )
        SELECT 1 FROM (
            (SELECT * FROM actual EXCEPT SELECT * FROM expected)
            UNION ALL
            (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        ) AS drift
    ) THEN
        RAISE EXCEPTION 'Platform schema relation default ACL is unsafe';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class AS relation
        WHERE relation.relnamespace = schema_oid
            AND relation.relkind = 'S'
    ) THEN
        RAISE EXCEPTION 'Platform sequence allowlist is not empty';
    END IF;
END
$platform_routine_acl_verify$;

COMMIT;
