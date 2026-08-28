BEGIN;

DO $publish_ai_consultant_home_card$
DECLARE
    current_content JSONB;
    tools_content JSONB;
    items_content JSONB;
    transformed_items JSONB;
    ai_consultant_items INTEGER;
    updated_rows INTEGER;
BEGIN
    SELECT "content"
    INTO current_content
    FROM "platform"."home_page_content"
    WHERE "id" = 'singleton'
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF pg_catalog.jsonb_typeof(current_content) <> 'object' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform home page content must be a JSON object';
    END IF;

    tools_content := current_content -> 'tools';
    IF tools_content IS NULL THEN
        RETURN;
    END IF;
    IF pg_catalog.jsonb_typeof(tools_content) <> 'object' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform tools content must be an object';
    END IF;

    items_content := tools_content -> 'items';
    IF items_content IS NULL THEN
        RETURN;
    END IF;
    IF pg_catalog.jsonb_typeof(items_content) <> 'array' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform tools items must be an array';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO ai_consultant_items
    FROM pg_catalog.jsonb_array_elements(items_content) AS item(value)
    WHERE item.value ->> 'previewType' = 'aiConsultant';

    IF ai_consultant_items = 0 THEN
        RETURN;
    END IF;

    IF ai_consultant_items > 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform tools must not contain duplicate AI consultant cards';
    END IF;

    SELECT pg_catalog.jsonb_agg(
        CASE
            WHEN item.value ->> 'previewType' = 'aiConsultant'
            THEN pg_catalog.jsonb_set(
                item.value,
                '{comingSoon}',
                'false'::JSONB,
                true
            )
            ELSE item.value
        END
        ORDER BY item.ordinality
    )
    INTO transformed_items
    FROM pg_catalog.jsonb_array_elements(items_content)
        WITH ORDINALITY AS item(value, ordinality);

    tools_content := pg_catalog.jsonb_set(
        tools_content,
        '{items}',
        transformed_items,
        false
    );
    current_content := pg_catalog.jsonb_set(
        current_content,
        '{tools}',
        tools_content,
        false
    );

    UPDATE "platform"."home_page_content"
    SET "content" = current_content
    WHERE "id" = 'singleton'
        AND "content" IS DISTINCT FROM current_content;

    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows > 1 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform AI consultant card migration changed more than the singleton row';
    END IF;

    IF updated_rows = 1 THEN
        PERFORM "platform"."refresh_current_semantic_fingerprint"(
            "platform"."current_semantic_fingerprint"()
        );
    END IF;
END
$publish_ai_consultant_home_card$;

COMMIT;
