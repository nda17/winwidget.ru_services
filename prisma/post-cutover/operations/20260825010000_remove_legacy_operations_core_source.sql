BEGIN;

DO $$
DECLARE
    expected_revision TEXT := current_setting('winwidget.operations_expected_revision', true);
    expected_sha256 TEXT := current_setting('winwidget.operations_expected_snapshot_sha256', true);
    expected_notes BIGINT := NULLIF(current_setting('winwidget.operations_expected_note_count', true), '')::BIGINT;
    expected_events BIGINT := NULLIF(current_setting('winwidget.operations_expected_event_count', true), '')::BIGINT;
BEGIN
    IF current_setting('winwidget.operations_source_cleanup', true) <> 'approved'
        OR current_setting('winwidget.operations_core_stopped', true) <> 'true'
    THEN
        RAISE EXCEPTION 'Operations Core cleanup requires exact approval and a stopped Core runtime';
    END IF;

    IF expected_revision !~ '^[0-9a-f]{40}$'
        OR expected_sha256 !~ '^[0-9a-f]{64}$'
        OR expected_notes IS NULL
        OR expected_events IS NULL
        OR expected_notes < 0
        OR expected_events < 0
    THEN
        RAISE EXCEPTION 'Operations Core cleanup expectations are invalid';
    END IF;
END
$$;

LOCK TABLE "public"."notes", "public"."admin_event_logs"
    IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
    state_record RECORD;
    expected_revision TEXT := current_setting('winwidget.operations_expected_revision', true);
    expected_sha256 TEXT := current_setting('winwidget.operations_expected_snapshot_sha256', true);
    expected_notes BIGINT := NULLIF(current_setting('winwidget.operations_expected_note_count', true), '')::BIGINT;
    expected_events BIGINT := NULLIF(current_setting('winwidget.operations_expected_event_count', true), '')::BIGINT;
BEGIN

    SELECT * INTO STRICT state_record
    FROM "public"."operations_core_state"
    WHERE "id" = 'singleton'
    FOR UPDATE;

    IF state_record."ownership" <> 'OPERATIONS'::"public"."OperationsCoreOwnership"
        OR state_record."source_writes_enabled"
        OR state_record."legacy_routes_enabled"
        OR state_record."ownership_revision" <> expected_revision
        OR state_record."source_snapshot_sha256" <> expected_sha256
        OR state_record."source_note_count" <> expected_notes
        OR state_record."source_event_count" <> expected_events
    THEN
        RAISE EXCEPTION 'Operations Core cleanup does not match active ownership';
    END IF;

    IF (SELECT count(*) FROM "public"."notes") <> expected_notes
        OR (SELECT count(*) FROM "public"."admin_event_logs") <> expected_events
    THEN
        RAISE EXCEPTION 'Operations Core source row counts changed after export';
    END IF;
END
$$;

DROP TABLE "public"."notes";
DROP TABLE "public"."admin_event_logs";
DROP FUNCTION "public"."operations_core_source_write_guard"();
DROP TABLE "public"."operations_core_state";
DROP FUNCTION "public"."operations_core_state_transition_guard"();
DROP TYPE "public"."OperationsCoreOwnership";

DO $$
BEGIN
    IF to_regclass('public.notes') IS NOT NULL
        OR to_regclass('public.admin_event_logs') IS NOT NULL
        OR to_regclass('public.operations_core_state') IS NOT NULL
        OR to_regprocedure('public.operations_core_source_write_guard()') IS NOT NULL
        OR to_regprocedure('public.operations_core_state_transition_guard()') IS NOT NULL
        OR to_regtype('public."OperationsCoreOwnership"') IS NOT NULL
    THEN
        RAISE EXCEPTION 'Legacy Operations Core source remains after cleanup';
    END IF;
END
$$;

COMMIT;
