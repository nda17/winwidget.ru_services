BEGIN;

DO $support_routine_contract$
DECLARE
    schema_oid OID := to_regnamespace('support');
    owner_oid OID := to_regrole(CURRENT_USER);
    expected_routines OID[] := ARRAY[
        to_regprocedure('support.enforce_service_identity_integrity()')::OID
    ];
BEGIN
    IF schema_oid IS NULL OR (
        SELECT namespace_state.nspowner
        FROM pg_namespace AS namespace_state
        WHERE namespace_state.oid = schema_oid
    ) IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Support schema must be owned by the current migration role';
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
        RAISE EXCEPTION 'Support routine allowlist or owner drifted';
    END IF;
END
$support_routine_contract$;

ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "support"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "support" FROM PUBLIC;

DO $support_known_roles$
BEGIN
    IF to_regrole('winwidget_support_runtime') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_support_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "support" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_support_runtime"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "support" FROM "winwidget_support_runtime"';
    END IF;
    IF to_regrole('winwidget_support_backup') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_support_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "support" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_support_backup"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "support" FROM "winwidget_support_backup"';
    END IF;
END
$support_known_roles$;

DO $support_routine_acl_verify$
DECLARE
    schema_oid OID := to_regnamespace('support');
    owner_oid OID := to_regrole(CURRENT_USER);
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
        RAISE EXCEPTION 'Support global function default ACL is unsafe';
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
        RAISE EXCEPTION 'Support function ACL is not owner-only';
    END IF;
END
$support_routine_acl_verify$;

COMMIT;
