BEGIN;

REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime') THEN
        REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state"
            FROM "winwidget_api_runtime";
        GRANT SELECT ON TABLE public."platform_core_state"
            TO "winwidget_api_runtime";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_maintenance') THEN
        REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state"
            FROM "winwidget_maintenance";
        GRANT SELECT ON TABLE public."platform_core_state"
            TO "winwidget_maintenance";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_backup') THEN
        REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state"
            FROM "winwidget_backup";
        GRANT SELECT ON TABLE public."platform_core_state"
            TO "winwidget_backup";
    END IF;
END;
$$;

COMMIT;
