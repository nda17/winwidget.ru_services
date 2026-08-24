BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';

CREATE TYPE "PlatformCoreOwnership" AS ENUM ('CORE', 'PLATFORM');

CREATE TABLE "platform_core_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "ownership" "PlatformCoreOwnership" NOT NULL DEFAULT 'CORE',
    "source_writes_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "legacy_routes_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "prepared_revision" TEXT,
    "source_revision" TEXT,
    "ownership_revision" TEXT,
    "source_fingerprint" TEXT,
    "source_snapshot_sha256" TEXT,
    "source_high_watermark" BIGINT,
    "billing_offer_contract_version" INTEGER,
    "billing_offer_sequence_scope" TEXT,
    "billing_offer_aggregate_version" BIGINT,
    "billing_offer_source_sequence" BIGINT,
    "billing_offer_fence_fingerprint" TEXT,
    "fenced_at" TIMESTAMP(3),
    "exported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_core_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_core_state_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "platform_core_state_generation_check" CHECK ("generation" >= 0),
    CONSTRAINT "platform_core_state_revision_check" CHECK (
        ("prepared_revision" IS NULL OR "prepared_revision" ~ '^[0-9a-f]{40}$')
        AND ("source_revision" IS NULL OR "source_revision" ~ '^[0-9a-f]{40}$')
        AND ("ownership_revision" IS NULL OR "ownership_revision" ~ '^[0-9a-f]{40}$')
    ),
    CONSTRAINT "platform_core_state_fingerprint_check" CHECK (
        ("source_fingerprint" IS NULL OR "source_fingerprint" ~ '^[0-9a-f]{64}$')
        AND ("source_snapshot_sha256" IS NULL OR "source_snapshot_sha256" ~ '^[0-9a-f]{64}$')
        AND ("billing_offer_fence_fingerprint" IS NULL OR "billing_offer_fence_fingerprint" ~ '^[0-9a-f]{64}$')
        AND ("source_high_watermark" IS NULL OR "source_high_watermark" > 0)
    ),
    CONSTRAINT "platform_core_state_export_anchor_check" CHECK (
        (
            "source_revision" IS NULL
            AND "source_fingerprint" IS NULL
            AND "source_snapshot_sha256" IS NULL
            AND "source_high_watermark" IS NULL
            AND "exported_at" IS NULL
        )
        OR (
            "source_revision" IS NOT NULL
            AND "source_fingerprint" IS NOT NULL
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_high_watermark" IS NOT NULL
            AND "exported_at" IS NOT NULL
        )
    ),
    CONSTRAINT "platform_core_state_offer_fence_check" CHECK (
        (
            "billing_offer_contract_version" IS NULL
            AND "billing_offer_sequence_scope" IS NULL
            AND "billing_offer_aggregate_version" IS NULL
            AND "billing_offer_source_sequence" IS NULL
            AND "billing_offer_fence_fingerprint" IS NULL
        )
        OR (
            "billing_offer_contract_version" IS NOT NULL
            AND "billing_offer_contract_version" = 2
            AND "billing_offer_sequence_scope" IS NOT NULL
            AND "billing_offer_sequence_scope" = 'billing.offer:offer'
            AND "billing_offer_aggregate_version" IS NOT NULL
            AND "billing_offer_aggregate_version" > 0
            AND "billing_offer_source_sequence" IS NOT NULL
            AND "billing_offer_source_sequence" > 0
            AND "billing_offer_fence_fingerprint" IS NOT NULL
        )
    ),
    CONSTRAINT "platform_core_state_boundary_check" CHECK (
        (
            "ownership" = 'CORE'::"PlatformCoreOwnership"
            AND "legacy_routes_enabled" = TRUE
            AND "ownership_revision" IS NULL
            AND "activated_at" IS NULL
            AND (
                (
                    "source_writes_enabled" = TRUE
                    AND "fenced_at" IS NULL
                    AND "billing_offer_contract_version" IS NULL
                    AND "source_revision" IS NULL
                )
                OR (
                    "source_writes_enabled" = FALSE
                    AND "prepared_revision" IS NOT NULL
                    AND "fenced_at" IS NOT NULL
                    AND "billing_offer_contract_version" IS NOT NULL
                    AND "billing_offer_contract_version" = 2
                    AND (
                        "exported_at" IS NULL
                        OR (
                            "source_revision" = "prepared_revision"
                            AND "exported_at" >= "fenced_at"
                        )
                    )
                )
            )
        )
        OR (
            "ownership" = 'PLATFORM'::"PlatformCoreOwnership"
            AND "source_writes_enabled" = FALSE
            AND "legacy_routes_enabled" = FALSE
            AND "generation" > 0
            AND "prepared_revision" IS NOT NULL
            AND "source_revision" = "prepared_revision"
            AND "ownership_revision" = "prepared_revision"
            AND "source_fingerprint" IS NOT NULL
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_high_watermark" IS NOT NULL
            AND "billing_offer_contract_version" IS NOT NULL
            AND "billing_offer_contract_version" = 2
            AND "fenced_at" IS NOT NULL
            AND "exported_at" IS NOT NULL
            AND "activated_at" IS NOT NULL
            AND "activated_at" >= "exported_at"
        )
    )
);

INSERT INTO "platform_core_state" ("id") VALUES ('singleton');

CREATE FUNCTION "platform_core_state_transition_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."ownership" = 'PLATFORM'::"PlatformCoreOwnership" THEN
        IF NEW."ownership" IS DISTINCT FROM OLD."ownership"
            OR NEW."source_writes_enabled" IS DISTINCT FROM OLD."source_writes_enabled"
            OR NEW."legacy_routes_enabled" IS DISTINCT FROM OLD."legacy_routes_enabled"
            OR NEW."generation" IS DISTINCT FROM OLD."generation"
            OR NEW."prepared_revision" IS DISTINCT FROM OLD."prepared_revision"
            OR NEW."source_revision" IS DISTINCT FROM OLD."source_revision"
            OR NEW."ownership_revision" IS DISTINCT FROM OLD."ownership_revision"
            OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_high_watermark" IS DISTINCT FROM OLD."source_high_watermark"
            OR NEW."billing_offer_contract_version" IS DISTINCT FROM OLD."billing_offer_contract_version"
            OR NEW."billing_offer_sequence_scope" IS DISTINCT FROM OLD."billing_offer_sequence_scope"
            OR NEW."billing_offer_aggregate_version" IS DISTINCT FROM OLD."billing_offer_aggregate_version"
            OR NEW."billing_offer_source_sequence" IS DISTINCT FROM OLD."billing_offer_source_sequence"
            OR NEW."billing_offer_fence_fingerprint" IS DISTINCT FROM OLD."billing_offer_fence_fingerprint"
            OR NEW."fenced_at" IS DISTINCT FROM OLD."fenced_at"
            OR NEW."exported_at" IS DISTINCT FROM OLD."exported_at"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
        THEN
            RAISE EXCEPTION 'Platform ownership is forward-only after activation'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    IF NEW."generation" < OLD."generation" THEN
        RAISE EXCEPTION 'Platform ownership generation cannot decrease'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."source_writes_enabled" = FALSE
        AND NEW."source_writes_enabled" = TRUE
        AND OLD."ownership" <> 'CORE'::"PlatformCoreOwnership"
    THEN
        RAISE EXCEPTION 'Platform source cannot be unfenced after ownership activation'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."ownership" = 'CORE'::"PlatformCoreOwnership"
        AND OLD."source_writes_enabled" = FALSE
        AND OLD."billing_offer_contract_version" IS NOT NULL
        AND (
            NEW."billing_offer_contract_version" IS DISTINCT FROM OLD."billing_offer_contract_version"
            OR NEW."billing_offer_sequence_scope" IS DISTINCT FROM OLD."billing_offer_sequence_scope"
            OR NEW."billing_offer_aggregate_version" IS DISTINCT FROM OLD."billing_offer_aggregate_version"
            OR NEW."billing_offer_source_sequence" IS DISTINCT FROM OLD."billing_offer_source_sequence"
            OR NEW."billing_offer_fence_fingerprint" IS DISTINCT FROM OLD."billing_offer_fence_fingerprint"
        )
        AND NOT (
            NEW."ownership" = 'CORE'::"PlatformCoreOwnership"
            AND NEW."source_writes_enabled" = TRUE
            AND NEW."billing_offer_contract_version" IS NULL
            AND NEW."billing_offer_sequence_scope" IS NULL
            AND NEW."billing_offer_aggregate_version" IS NULL
            AND NEW."billing_offer_source_sequence" IS NULL
            AND NEW."billing_offer_fence_fingerprint" IS NULL
        )
    THEN
        RAISE EXCEPTION 'Platform Billing offer fence is immutable until an exact pre-activation abort'
            USING ERRCODE = '55000';
    END IF;

    IF OLD."ownership" = 'CORE'::"PlatformCoreOwnership"
        AND OLD."exported_at" IS NOT NULL
        AND (
            NEW."source_revision" IS DISTINCT FROM OLD."source_revision"
            OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_high_watermark" IS DISTINCT FROM OLD."source_high_watermark"
            OR NEW."exported_at" IS DISTINCT FROM OLD."exported_at"
        )
        AND NOT (
            NEW."ownership" = 'CORE'::"PlatformCoreOwnership"
            AND NEW."source_writes_enabled" = TRUE
            AND NEW."source_revision" IS NULL
            AND NEW."source_fingerprint" IS NULL
            AND NEW."source_snapshot_sha256" IS NULL
            AND NEW."source_high_watermark" IS NULL
            AND NEW."exported_at" IS NULL
        )
    THEN
        RAISE EXCEPTION 'Platform durable export anchors are immutable until an exact pre-activation abort'
            USING ERRCODE = '55000';
    END IF;

    NEW."updated_at" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "platform_core_state_transition_guard"
BEFORE UPDATE ON "platform_core_state"
FOR EACH ROW EXECUTE FUNCTION "platform_core_state_transition_guard"();

CREATE FUNCTION "platform_core_source_writes_enabled"()
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    enabled_value BOOLEAN;
BEGIN
    SELECT "ownership" = 'CORE'::public."PlatformCoreOwnership"
        AND "source_writes_enabled"
    INTO enabled_value
    FROM public."platform_core_state"
    WHERE "id" = 'singleton'
    FOR SHARE;

    RETURN COALESCE(enabled_value, FALSE);
END;
$$;

CREATE FUNCTION "platform_assert_core_write_enabled"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT public."platform_core_source_writes_enabled"() THEN
        RAISE EXCEPTION 'Core Platform source is frozen; content write rejected'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "platform_site_settings_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "site_settings"
FOR EACH ROW EXECUTE FUNCTION "platform_assert_core_write_enabled"();

CREATE TRIGGER "platform_legal_pages_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "legal_pages"
FOR EACH ROW EXECUTE FUNCTION "platform_assert_core_write_enabled"();

CREATE TRIGGER "platform_home_page_content_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "home_page_content"
FOR EACH ROW EXECUTE FUNCTION "platform_assert_core_write_enabled"();

REVOKE ALL ON TABLE "platform_core_state" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "platform_core_state_transition_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "platform_core_source_writes_enabled"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "platform_assert_core_write_enabled"() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime') THEN
        GRANT SELECT ON TABLE "platform_core_state"
            TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION "platform_core_source_writes_enabled"()
            TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION "platform_assert_core_write_enabled"()
            TO "winwidget_api_runtime";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_backup') THEN
        GRANT SELECT ON TABLE "platform_core_state" TO "winwidget_backup";
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_maintenance') THEN
        GRANT SELECT ON TABLE "platform_core_state" TO "winwidget_maintenance";
    END IF;
END;
$$;

COMMIT;
