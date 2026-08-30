BEGIN;

DO $notification_delivery_routine_contract$
DECLARE
    schema_oid OID := to_regnamespace('notification_delivery');
    owner_oid OID := to_regrole(CURRENT_USER);
    expected_routines OID[] := ARRAY[]::OID[];
BEGIN
    IF schema_oid IS NULL OR (
        SELECT namespace_state.nspowner
        FROM pg_namespace AS namespace_state
        WHERE namespace_state.oid = schema_oid
    ) IS DISTINCT FROM owner_oid THEN
        RAISE EXCEPTION 'Notification Delivery schema must be owned by the current migration role';
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
        RAISE EXCEPTION 'Notification Delivery routine allowlist or owner drifted';
    END IF;
END
$notification_delivery_routine_contract$;

ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA "notification_delivery"
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "notification_delivery" FROM PUBLIC;

DO $notification_delivery_known_roles$
BEGIN
    IF to_regrole('winwidget_notification_delivery_runtime') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_notification_delivery_runtime"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "notification_delivery" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_notification_delivery_runtime"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "notification_delivery" FROM "winwidget_notification_delivery_runtime"';
    END IF;
    IF to_regrole('winwidget_notification_delivery_backup') IS NOT NULL THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_notification_delivery_backup"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "notification_delivery" REVOKE EXECUTE ON FUNCTIONS FROM "winwidget_notification_delivery_backup"';
        EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "notification_delivery" FROM "winwidget_notification_delivery_backup"';
    END IF;
END
$notification_delivery_known_roles$;

DO $notification_delivery_routine_acl_verify$
DECLARE
    schema_oid OID := to_regnamespace('notification_delivery');
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
        RAISE EXCEPTION 'Notification Delivery global function default ACL is unsafe';
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
        RAISE EXCEPTION 'Notification Delivery function ACL is not owner-only';
    END IF;
END
$notification_delivery_routine_acl_verify$;

COMMIT;
