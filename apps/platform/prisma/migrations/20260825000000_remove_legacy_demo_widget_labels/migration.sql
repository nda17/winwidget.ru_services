BEGIN;

DO $remove_legacy_demo_widget_labels$
DECLARE
    updated_rows INTEGER;
BEGIN
    UPDATE "platform"."home_page_content"
    SET "content" = "content" #- ARRAY['demoWidgets', 'labels']::TEXT[]
    WHERE "id" = 'singleton'
        AND pg_catalog.jsonb_typeof("content") = 'object'
        AND pg_catalog.jsonb_typeof("content" -> 'demoWidgets') = 'object'
        AND ("content" -> 'demoWidgets') ? 'labels';

    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows > 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform legacy demo widget cleanup changed more than the singleton row';
    END IF;

    IF updated_rows = 1 THEN
        PERFORM "platform"."refresh_current_semantic_fingerprint"(
            "platform"."current_semantic_fingerprint"()
        );
    END IF;
END
$remove_legacy_demo_widget_labels$;

COMMIT;
