BEGIN;

DO $reporting_routine_contract$
DECLARE
    schema_oid OID := to_regnamespace('reporting');
    owner_oid OID := to_regrole(CURRENT_USER);
    expected_routines OID[] := ARRAY[
        to_regprocedure('reporting.reject_report_run_snapshot_mutation()')::OID
    ];
BEGIN
    IF schema_oid IS NULL OR (
        SELECT namespace_state.nspowner
        FROM pg_namespace AS namespace_state
        WHERE namespace_state.oid = schema_oid
    ) IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Reporting schema must be owned by the current migration role';
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
        RAISE EXCEPTION 'Reporting routine allowlist or owner drifted';
    END IF;
END
$reporting_routine_contract$;

ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "reporting"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "reporting" FROM PUBLIC;

DO $reporting_known_roles$
BEGIN
    IF to_regrole('winwidget_reporting_runtime') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_reporting_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "reporting" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_reporting_runtime"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "reporting" FROM "winwidget_reporting_runtime"';
    END IF;
    IF to_regrole('winwidget_reporting_backup') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_reporting_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "reporting" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_reporting_backup"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "reporting" FROM "winwidget_reporting_backup"';
    END IF;
END
$reporting_known_roles$;

DO $reporting_routine_acl_verify$
DECLARE
    schema_oid OID := to_regnamespace('reporting');
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
        RAISE EXCEPTION 'Reporting global function default ACL is unsafe';
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
        RAISE EXCEPTION 'Reporting function ACL is not owner-only';
    END IF;
END
$reporting_routine_acl_verify$;

COMMIT;
