BEGIN;

CREATE OR REPLACE FUNCTION "platform"."refresh_current_semantic_fingerprint"(
    expected_post_fingerprint TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $$
DECLARE fingerprint TEXT;
BEGIN
    fingerprint := "platform"."current_semantic_fingerprint"();
    IF expected_post_fingerprint IS NULL
        OR expected_post_fingerprint !~ '^[0-9a-f]{64}$'
        OR fingerprint IS NULL
        OR fingerprint IS DISTINCT FROM expected_post_fingerprint THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            CONSTRAINT = 'platform_current_semantic_fingerprint_guard',
            MESSAGE = 'Platform semantic fingerprint guard does not match the owned rows';
    END IF;
    UPDATE "platform"."service_identity"
    SET "current_semantic_fingerprint" = fingerprint,
        "updated_at" = GREATEST(
            "updated_at",
            pg_catalog.clock_timestamp()::timestamp
        )
    WHERE "id" = 'singleton';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            CONSTRAINT = 'platform_current_semantic_fingerprint_guard',
            MESSAGE = 'Platform service identity is missing';
    END IF;
    PERFORM pg_catalog.set_config(
        'winwidget.platform_expected_semantic_fingerprint',
        fingerprint,
        true
    );
    RETURN fingerprint;
END;
$$;

REVOKE ALL ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT) FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_platform_runtime') THEN
        GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT)
            TO winwidget_platform_runtime;
        GRANT UPDATE (current_semantic_fingerprint, updated_at)
            ON TABLE "platform"."service_identity" TO winwidget_platform_runtime;
    END IF;
END $$;

COMMIT;
