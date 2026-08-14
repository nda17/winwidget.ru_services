ALTER TABLE "admin_event_logs"
    DROP CONSTRAINT IF EXISTS "admin_event_logs_admin_id_fkey",
    DROP CONSTRAINT IF EXISTS "admin_event_logs_target_user_id_fkey";

ALTER TABLE "integration_delivery_failures"
    DROP CONSTRAINT IF EXISTS "integration_delivery_failures_resolved_by_id_fkey";

-- This state is the durable no-two-writers boundary between the legacy Core
-- source and Identity. The later cleanup migration removes the guarded tables
-- and this temporary fence together.
CREATE TABLE "identity_core_source_state" (
    "id" TEXT NOT NULL,
    "ownership" TEXT NOT NULL DEFAULT 'OPEN',
    "generation" BIGINT NOT NULL DEFAULT 0,
    "fenced_revision" TEXT,
    "fenced_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_core_source_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "identity_core_source_state_singleton_check"
        CHECK ("id" = 'singleton'),
    CONSTRAINT "identity_core_source_state_ownership_check"
        CHECK ("ownership" IN ('OPEN', 'FENCED')),
    CONSTRAINT "identity_core_source_state_fence_check"
        CHECK (
            ("ownership" = 'OPEN' AND "fenced_revision" IS NULL AND "fenced_at" IS NULL)
            OR
            ("ownership" = 'FENCED' AND LENGTH(BTRIM("fenced_revision")) > 0 AND "fenced_at" IS NOT NULL)
        )
);

INSERT INTO "identity_core_source_state" (
    "id",
    "ownership",
    "generation",
    "updated_at"
) VALUES (
    'singleton',
    'OPEN',
    0,
    CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION "identity_core_source_is_open"()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE((
        SELECT state."ownership" = 'OPEN'
        FROM public."identity_core_source_state" AS state
        WHERE state."id" = 'singleton'
    ), FALSE)
$$;

-- Every legacy writer holds a shared lock on the singleton row until its
-- transaction commits. The fence UPDATE therefore waits for all writes that
-- observed OPEN, while writers arriving after the UPDATE see FENCED and fail.
CREATE OR REPLACE FUNCTION "lock_identity_core_source_open"()
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_ownership TEXT;
BEGIN
    SELECT state."ownership"
    INTO current_ownership
    FROM public."identity_core_source_state" AS state
    WHERE state."id" = 'singleton'
    FOR SHARE;

    RETURN COALESCE(current_ownership = 'OPEN', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION "reject_fenced_identity_core_source_write"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NOT public."lock_identity_core_source_open"() THEN
        RAISE EXCEPTION 'Legacy Core identity source is fenced'
            USING ERRCODE = '55000';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION "reject_fenced_identity_auth_settings_write"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF public."lock_identity_core_source_open"() THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'Legacy Core Identity auth settings are fenced'
            USING ERRCODE = '55000';
    END IF;
    IF NEW."recaptcha_enabled" IS DISTINCT FROM OLD."recaptcha_enabled"
       OR NEW."google_auth_enabled" IS DISTINCT FROM OLD."google_auth_enabled"
       OR NEW."yandex_auth_enabled" IS DISTINCT FROM OLD."yandex_auth_enabled"
       OR NEW."github_auth_enabled" IS DISTINCT FROM OLD."github_auth_enabled"
       OR NEW."vk_auth_enabled" IS DISTINCT FROM OLD."vk_auth_enabled"
       OR NEW."telegram_auth_enabled" IS DISTINCT FROM OLD."telegram_auth_enabled" THEN
        RAISE EXCEPTION 'Legacy Core Identity auth settings are fenced'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "fence_identity_core_source"(revision TEXT)
RETURNS TABLE (
    ownership TEXT,
    generation BIGINT,
    fenced_revision TEXT,
    fenced_at TIMESTAMP(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    normalized_revision TEXT := BTRIM(revision);
BEGIN
    IF normalized_revision IS NULL OR normalized_revision = '' OR LENGTH(normalized_revision) > 255 THEN
        RAISE EXCEPTION 'Identity fence revision is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    UPDATE public."identity_core_source_state" AS state
    SET
        "ownership" = 'FENCED',
        "generation" = state."generation" + 1,
        "fenced_revision" = normalized_revision,
        "fenced_at" = CURRENT_TIMESTAMP,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE state."id" = 'singleton'
      AND state."ownership" = 'OPEN'
    RETURNING
        state."ownership",
        state."generation",
        state."fenced_revision",
        state."fenced_at";

    IF FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        state."ownership",
        state."generation",
        state."fenced_revision",
        state."fenced_at"
    FROM public."identity_core_source_state" AS state
    WHERE state."id" = 'singleton'
      AND state."ownership" = 'FENCED'
      AND state."fenced_revision" = normalized_revision;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Identity Core source fence CAS failed'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "unfence_identity_core_source"(revision TEXT)
RETURNS TABLE (
    ownership TEXT,
    generation BIGINT,
    fenced_revision TEXT,
    fenced_at TIMESTAMP(3)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    normalized_revision TEXT := BTRIM(revision);
BEGIN
    IF normalized_revision IS NULL OR normalized_revision = '' OR LENGTH(normalized_revision) > 255 THEN
        RAISE EXCEPTION 'Identity fence revision is invalid'
            USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    UPDATE public."identity_core_source_state" AS state
    SET
        "ownership" = 'OPEN',
        "generation" = state."generation" + 1,
        "fenced_revision" = NULL,
        "fenced_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
    WHERE state."id" = 'singleton'
      AND state."ownership" = 'FENCED'
      AND state."fenced_revision" = normalized_revision
    RETURNING
        state."ownership",
        state."generation",
        state."fenced_revision",
        state."fenced_at";

    IF FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        state."ownership",
        state."generation",
        state."fenced_revision",
        state."fenced_at"
    FROM public."identity_core_source_state" AS state
    WHERE state."id" = 'singleton'
      AND state."ownership" = 'OPEN'
      AND state."fenced_revision" IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Identity Core source unfence CAS failed'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'User',
        'auth_identities',
        'telegram_notification_channels',
        'user_sessions',
        'verification_challenges'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public."reject_fenced_identity_core_source_write"()',
            'identity_core_source_write_fence',
            table_name
        );
    END LOOP;
END
$$;

CREATE TRIGGER "identity_core_auth_settings_write_fence"
BEFORE INSERT OR UPDATE OF
    "recaptcha_enabled",
    "google_auth_enabled",
    "yandex_auth_enabled",
    "github_auth_enabled",
    "vk_auth_enabled",
    "telegram_auth_enabled"
ON "site_settings"
FOR EACH ROW
EXECUTE FUNCTION "reject_fenced_identity_auth_settings_write"();

REVOKE ALL ON FUNCTION "identity_core_source_is_open"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "lock_identity_core_source_open"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "reject_fenced_identity_core_source_write"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "reject_fenced_identity_auth_settings_write"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "fence_identity_core_source"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION "unfence_identity_core_source"(TEXT) FROM PUBLIC;

DO $$
BEGIN
    REVOKE INSERT, UPDATE, DELETE ON TABLE "identity_core_source_state"
        FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime') THEN
        REVOKE INSERT, UPDATE, DELETE ON TABLE "identity_core_source_state"
            FROM "winwidget_api_runtime";
        GRANT SELECT ON TABLE "identity_core_source_state" TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION "identity_core_source_is_open"() TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION "fence_identity_core_source"(TEXT) TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION "unfence_identity_core_source"(TEXT) TO "winwidget_api_runtime";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_maintenance') THEN
        REVOKE INSERT, UPDATE, DELETE ON TABLE "identity_core_source_state"
            FROM "winwidget_maintenance";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_backup') THEN
        REVOKE INSERT, UPDATE, DELETE ON TABLE "identity_core_source_state"
            FROM "winwidget_backup";
    END IF;
END
$$;
