-- The production lifecycle pre-creates this schema with the migration role as
-- its owner. Avoid PostgreSQL's database-level CREATE privilege check when the
-- schema already exists, while retaining an owner-path for local databases
-- that have not been provisioned separately.
DO $$
BEGIN
    IF to_regnamespace('platform') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "platform"';
    END IF;
END
$$;

CREATE TYPE "platform"."ServiceDatabasePhase" AS ENUM ('SHADOW', 'ACTIVE');
CREATE TYPE "platform"."OfferProducerPhase" AS ENUM ('BLOCKED', 'IMPORTED', 'ACTIVE');
CREATE TYPE "platform"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED');

CREATE TABLE "platform"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'platform-service',
    "database_id" UUID NOT NULL,
    "phase" "platform"."ServiceDatabasePhase" NOT NULL DEFAULT 'SHADOW',
    "ownership_generation" BIGINT NOT NULL DEFAULT 0,
    "source_fingerprint" TEXT,
    "source_snapshot_sha256" TEXT,
    "source_snapshot_counts" JSONB,
    "source_high_watermark" BIGINT,
    "current_semantic_fingerprint" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_identity_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "service_identity_name_check" CHECK ("service_name" = 'platform-service'),
    CONSTRAINT "service_identity_generation_check" CHECK ("ownership_generation" >= 0),
    CONSTRAINT "service_identity_current_semantic_fingerprint_check" CHECK (
        "current_semantic_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "service_identity_source_check" CHECK (
        (
            "phase" = 'SHADOW'
            AND "ownership_generation" = 0
            AND "activated_at" IS NULL
            AND (
                (
                    "source_fingerprint" IS NULL
                    AND "source_snapshot_sha256" IS NULL
                    AND "source_snapshot_counts" IS NULL
                    AND "source_high_watermark" IS NULL
                    AND "imported_at" IS NULL
                )
                OR (
                    "source_fingerprint" ~ '^[0-9a-f]{64}$'
                    AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
                    AND "source_snapshot_counts" = '{"siteSettings": 1, "legalPages": 4, "homePageContent": 1}'::jsonb
                    AND "source_high_watermark" IS NOT NULL
                    AND "source_high_watermark" > 0
                    AND "imported_at" IS NOT NULL
                )
            )
        )
        OR (
            "phase" = 'ACTIVE'
            AND "ownership_generation" >= 1
            AND "source_fingerprint" IS NOT NULL
            AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_counts" = '{"siteSettings": 1, "legalPages": 4, "homePageContent": 1}'::jsonb
            AND "source_high_watermark" IS NOT NULL
            AND "source_high_watermark" > 0
            AND "imported_at" IS NOT NULL
            AND "activated_at" IS NOT NULL
            AND "activated_at" >= "imported_at"
        )
    )
);

CREATE TABLE "platform"."source_sequences" (
    "id" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "source_sequences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_sequences_next_value_check" CHECK ("next_value" >= 1)
);

CREATE TABLE "platform"."site_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "banner_enabled" BOOLEAN NOT NULL DEFAULT false,
    "banner_text" TEXT NOT NULL DEFAULT '',
    "snowflake_enabled" BOOLEAN NOT NULL DEFAULT false,
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "site_settings_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "site_settings_banner_text_check" CHECK (char_length("banner_text") <= 300),
    CONSTRAINT "site_settings_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0)
);

CREATE TABLE "platform"."legal_pages" (
    "slug" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legal_pages_pkey" PRIMARY KEY ("slug"),
    CONSTRAINT "legal_pages_slug_check" CHECK ("slug" IN ('personal-policy', 'consent-processing', 'cookie-notice', 'oferta')),
    CONSTRAINT "legal_pages_content_size_check" CHECK (octet_length("content") <= 1048576),
    CONSTRAINT "legal_pages_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0)
);

CREATE TABLE "platform"."home_page_content" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "content" JSONB NOT NULL DEFAULT '{}',
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "home_page_content_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "home_page_content_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "home_page_content_object_check" CHECK (jsonb_typeof("content") = 'object'),
    CONSTRAINT "home_page_content_size_check" CHECK (octet_length("content"::TEXT) <= 1048576),
    CONSTRAINT "home_page_content_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0)
);

CREATE TABLE "platform"."billing_offer_producer_state" (
    "id" TEXT NOT NULL DEFAULT 'offer',
    "phase" "platform"."OfferProducerPhase" NOT NULL DEFAULT 'BLOCKED',
    "producer_contract_version" INTEGER,
    "source_sequence_scope" TEXT,
    "imported_aggregate_version" BIGINT,
    "imported_source_sequence" BIGINT,
    "current_aggregate_version" BIGINT,
    "current_source_sequence" BIGINT,
    "source_fence_fingerprint" TEXT,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_offer_producer_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_offer_producer_singleton_check" CHECK ("id" = 'offer'),
    CONSTRAINT "billing_offer_producer_versions_check" CHECK (
        ("producer_contract_version" IS NULL OR "producer_contract_version" = 2)
        AND ("source_sequence_scope" IS NULL OR "source_sequence_scope" = 'billing.offer:offer')
        AND ("imported_aggregate_version" IS NULL OR "imported_aggregate_version" >= 1)
        AND ("imported_source_sequence" IS NULL OR "imported_source_sequence" >= 1)
        AND ("current_aggregate_version" IS NULL OR "current_aggregate_version" >= "imported_aggregate_version")
        AND ("current_source_sequence" IS NULL OR "current_source_sequence" >= "imported_source_sequence")
        AND (
            "current_aggregate_version" IS NULL
            OR "current_source_sequence" - "imported_source_sequence"
                = "current_aggregate_version" - "imported_aggregate_version"
        )
    ),
    CONSTRAINT "billing_offer_producer_fingerprint_check" CHECK (
        "source_fence_fingerprint" IS NULL OR "source_fence_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "billing_offer_producer_phase_check" CHECK (
        (
            "phase" = 'BLOCKED'
            AND "producer_contract_version" IS NULL
            AND "source_sequence_scope" IS NULL
            AND "imported_aggregate_version" IS NULL
            AND "imported_source_sequence" IS NULL
            AND "current_aggregate_version" IS NULL
            AND "current_source_sequence" IS NULL
            AND "source_fence_fingerprint" IS NULL
            AND "imported_at" IS NULL
            AND "activated_at" IS NULL
        )
        OR (
            "phase" = 'IMPORTED'
            AND "producer_contract_version" IS NOT NULL
            AND "producer_contract_version" = 2
            AND "source_sequence_scope" IS NOT NULL
            AND "source_sequence_scope" = 'billing.offer:offer'
            AND "imported_aggregate_version" IS NOT NULL
            AND "imported_source_sequence" IS NOT NULL
            AND "source_fence_fingerprint" IS NOT NULL
            AND "imported_at" IS NOT NULL
            AND "current_aggregate_version" IS NULL
            AND "current_source_sequence" IS NULL
            AND "activated_at" IS NULL
        )
        OR (
            "phase" = 'ACTIVE'
            AND "producer_contract_version" IS NOT NULL
            AND "producer_contract_version" = 2
            AND "source_sequence_scope" IS NOT NULL
            AND "source_sequence_scope" = 'billing.offer:offer'
            AND "imported_aggregate_version" IS NOT NULL
            AND "imported_source_sequence" IS NOT NULL
            AND "source_fence_fingerprint" IS NOT NULL
            AND "imported_at" IS NOT NULL
            AND "current_aggregate_version" IS NOT NULL
            AND "current_source_sequence" IS NOT NULL
            AND "activated_at" IS NOT NULL
            AND "activated_at" >= "imported_at"
        )
    )
);

CREATE TABLE "platform"."outbox_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "message_id" TEXT,
    "deduplication_key" TEXT,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" BIGINT,
    "source_sequence" BIGINT,
    "correlation_id" UUID,
    "exchange" TEXT NOT NULL DEFAULT 'winwidget.events',
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "delivery_attempt" INTEGER NOT NULL DEFAULT 0,
    "status" "platform"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_attempts_check" CHECK ("attempt" >= 0 AND "delivery_attempt" >= 0)
);

CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "platform"."outbox_events"("event_id");
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "platform"."outbox_events"("deduplication_key");
CREATE INDEX "outbox_events_status_available_at_idx" ON "platform"."outbox_events"("status", "available_at");
CREATE INDEX "outbox_events_retention_idx" ON "platform"."outbox_events"("status", "published_at", "id");

CREATE FUNCTION "platform"."current_semantic_fingerprint"()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $$
SELECT encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 1,
    'platformHighWater', (sequence_state."next_value" - 1)::TEXT,
    'siteSettings', jsonb_build_object(
        'id', site."id", 'bannerEnabled', site."banner_enabled",
        'bannerText', site."banner_text", 'snowflakeEnabled', site."snowflake_enabled",
        'aggregateVersion', site."aggregate_version"::TEXT,
        'sourceSequence', site."source_sequence"::TEXT,
        'updatedAt', to_char(site."updated_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'legalPages', (
        SELECT jsonb_agg(jsonb_build_object(
            'slug', page."slug", 'content', page."content",
            'aggregateVersion', page."aggregate_version"::TEXT,
            'sourceSequence', page."source_sequence"::TEXT,
            'updatedAt', to_char(page."updated_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) ORDER BY page."slug") FROM "platform"."legal_pages" page
    ),
    'homePageContent', jsonb_build_object(
        'id', home."id", 'content', home."content",
        'aggregateVersion', home."aggregate_version"::TEXT,
        'sourceSequence', home."source_sequence"::TEXT,
        'updatedAt', to_char(home."updated_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    'billingOfferProducer', jsonb_build_object(
        'phase', offer."phase"::TEXT,
        'contractVersion', offer."producer_contract_version",
        'sequenceScope', offer."source_sequence_scope",
        'importedAggregateVersion', offer."imported_aggregate_version"::TEXT,
        'importedSourceSequence', offer."imported_source_sequence"::TEXT,
        'currentAggregateVersion', offer."current_aggregate_version"::TEXT,
        'currentSourceSequence', offer."current_source_sequence"::TEXT,
        'sourceFenceFingerprint', offer."source_fence_fingerprint"
    )
)::TEXT, 'UTF8')), 'hex')
FROM "platform"."site_settings" site
CROSS JOIN "platform"."home_page_content" home
CROSS JOIN "platform"."source_sequences" sequence_state
CROSS JOIN "platform"."billing_offer_producer_state" offer
WHERE site."id" = 'singleton' AND home."id" = 'singleton'
    AND sequence_state."id" = 'platform' AND offer."id" = 'offer'
    AND (SELECT count(*) FROM "platform"."legal_pages") = 4
    AND (SELECT count(*) FROM "platform"."source_sequences") = 1;
$$;

REVOKE ALL ON FUNCTION "platform"."current_semantic_fingerprint"() FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_platform_runtime') THEN
        GRANT EXECUTE ON FUNCTION "platform"."current_semantic_fingerprint"()
            TO winwidget_platform_runtime;
    END IF;
END $$;

CREATE FUNCTION "platform"."refresh_current_semantic_fingerprint"(
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
        "updated_at" = CURRENT_TIMESTAMP
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

CREATE FUNCTION "platform"."enforce_current_semantic_fingerprint"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $$
DECLARE
    expected_fingerprint TEXT;
    stored_fingerprint TEXT;
    actual_fingerprint TEXT;
BEGIN
    expected_fingerprint := NULLIF(
        pg_catalog.current_setting(
            'winwidget.platform_expected_semantic_fingerprint',
            true
        ),
        ''
    );
    SELECT "current_semantic_fingerprint" INTO stored_fingerprint
    FROM "platform"."service_identity" WHERE "id" = 'singleton';
    actual_fingerprint := "platform"."current_semantic_fingerprint"();
    IF expected_fingerprint IS NULL
        OR expected_fingerprint !~ '^[0-9a-f]{64}$'
        OR stored_fingerprint IS DISTINCT FROM expected_fingerprint
        OR actual_fingerprint IS DISTINCT FROM expected_fingerprint THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            CONSTRAINT = 'platform_current_semantic_fingerprint_guard',
            MESSAGE = 'Platform semantic write is missing its matching transaction guard';
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION "platform"."enforce_current_semantic_fingerprint"() FROM PUBLIC;

CREATE FUNCTION "platform"."enforce_service_identity_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform service identity cannot be deleted';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."service_name" IS DISTINCT FROM OLD."service_name"
        OR NEW."database_id" IS DISTINCT FROM OLD."database_id"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform service identity anchors are immutable';
    END IF;

    IF OLD."phase" = 'ACTIVE' THEN
        IF NEW."phase" IS DISTINCT FROM OLD."phase"
            OR NEW."ownership_generation" IS DISTINCT FROM OLD."ownership_generation"
            OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_snapshot_counts" IS DISTINCT FROM OLD."source_snapshot_counts"
            OR NEW."source_high_watermark" IS DISTINCT FROM OLD."source_high_watermark"
            OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
            OR NEW."updated_at" < OLD."updated_at" THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform ACTIVE ownership is forward-only and immutable';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."phase" <> 'SHADOW' OR OLD."ownership_generation" <> 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform service identity has an invalid source phase';
    END IF;

    IF NEW."phase" = 'SHADOW' THEN
        IF NEW."ownership_generation" <> 0 OR NEW."activated_at" IS NOT NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform SHADOW ownership cannot advance partially';
        END IF;
        IF NEW."updated_at" < OLD."updated_at" THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform SHADOW ownership timestamp cannot move backwards';
        END IF;
        IF OLD."source_fingerprint" IS NOT NULL
            AND NEW."source_fingerprint" IS NOT NULL
            AND (
                NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint"
                OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
                OR NEW."source_snapshot_counts" IS DISTINCT FROM OLD."source_snapshot_counts"
                OR NEW."source_high_watermark" IS DISTINCT FROM OLD."source_high_watermark"
                OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
            ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Imported Platform service identity anchors require an explicit abort';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."phase" <> 'ACTIVE'
        OR NEW."ownership_generation" <> OLD."ownership_generation" + 1
        OR OLD."source_fingerprint" IS NULL
        OR OLD."source_snapshot_sha256" IS NULL
        OR OLD."source_snapshot_counts" IS NULL
        OR OLD."source_high_watermark" IS NULL
        OR OLD."imported_at" IS NULL
        OR NEW."source_fingerprint" IS DISTINCT FROM OLD."source_fingerprint"
        OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
        OR NEW."source_snapshot_counts" IS DISTINCT FROM OLD."source_snapshot_counts"
        OR NEW."source_high_watermark" IS DISTINCT FROM OLD."source_high_watermark"
        OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
        OR NEW."activated_at" IS NULL
        OR NEW."activated_at" < OLD."imported_at"
        OR NEW."updated_at" < OLD."updated_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform ownership activation lost its forward-only boundary';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "service_identity_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "platform"."service_identity"
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_service_identity_lifecycle"();

CREATE FUNCTION "platform"."enforce_billing_offer_producer_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform Billing offer producer state cannot be deleted';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform Billing offer producer identity is immutable';
    END IF;

    IF OLD."phase" = 'BLOCKED' THEN
        IF NEW."phase" = 'BLOCKED' THEN
            IF NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'Platform BLOCKED Billing offer producer cannot change';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."phase" <> 'IMPORTED' THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform Billing offer producer import phase is invalid';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."phase" = 'IMPORTED' THEN
        IF NEW."phase" = 'BLOCKED' THEN
            RETURN NEW;
        END IF;
        IF NEW."phase" = 'IMPORTED' THEN
            IF NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'Imported Platform Billing offer anchors are immutable';
            END IF;
            RETURN NEW;
        END IF;
        IF NEW."phase" <> 'ACTIVE'
			OR NEW."producer_contract_version" IS DISTINCT FROM OLD."producer_contract_version"
			OR NEW."source_sequence_scope" IS DISTINCT FROM OLD."source_sequence_scope"
            OR NEW."imported_aggregate_version" IS DISTINCT FROM OLD."imported_aggregate_version"
            OR NEW."imported_source_sequence" IS DISTINCT FROM OLD."imported_source_sequence"
            OR NEW."source_fence_fingerprint" IS DISTINCT FROM OLD."source_fence_fingerprint"
            OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
            OR NEW."current_aggregate_version" IS DISTINCT FROM OLD."imported_aggregate_version"
			OR NEW."current_source_sequence" IS DISTINCT FROM OLD."imported_source_sequence"
            OR NEW."activated_at" IS NULL
            OR NEW."activated_at" < OLD."imported_at"
            OR NEW."updated_at" < OLD."updated_at" THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform Billing offer activation lost its frozen high-water';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."phase" = 'ACTIVE' THEN
        IF NEW."phase" <> 'ACTIVE'
			OR NEW."producer_contract_version" IS DISTINCT FROM OLD."producer_contract_version"
			OR NEW."source_sequence_scope" IS DISTINCT FROM OLD."source_sequence_scope"
            OR NEW."imported_aggregate_version" IS DISTINCT FROM OLD."imported_aggregate_version"
            OR NEW."imported_source_sequence" IS DISTINCT FROM OLD."imported_source_sequence"
            OR NEW."source_fence_fingerprint" IS DISTINCT FROM OLD."source_fence_fingerprint"
            OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
            OR NEW."current_aggregate_version" <> OLD."current_aggregate_version" + 1
            OR NEW."current_source_sequence" <> OLD."current_source_sequence" + 1
            OR NEW."updated_at" < OLD."updated_at" THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'Platform Billing offer cursors must advance once in lockstep';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Platform Billing offer producer has an invalid source phase';
END;
$$;

CREATE TRIGGER "billing_offer_producer_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "platform"."billing_offer_producer_state"
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_billing_offer_producer_lifecycle"();

INSERT INTO "platform"."source_sequences" ("id", "next_value")
VALUES ('platform', 1);
INSERT INTO "platform"."site_settings" ("id") VALUES ('singleton');
INSERT INTO "platform"."home_page_content" ("id", "content") VALUES ('singleton', '{}');
INSERT INTO "platform"."billing_offer_producer_state" ("id") VALUES ('offer');
INSERT INTO "platform"."legal_pages" ("slug") VALUES
    ('personal-policy'),
    ('consent-processing'),
    ('cookie-notice'),
    ('oferta');
INSERT INTO "platform"."service_identity" (
    "id", "database_id", "current_semantic_fingerprint"
) VALUES (
    'singleton', gen_random_uuid(), "platform"."current_semantic_fingerprint"()
);

CREATE CONSTRAINT TRIGGER "service_identity_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."service_identity"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();

CREATE CONSTRAINT TRIGGER "source_sequences_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."source_sequences"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();

CREATE CONSTRAINT TRIGGER "site_settings_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."site_settings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();

CREATE CONSTRAINT TRIGGER "legal_pages_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."legal_pages"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();

CREATE CONSTRAINT TRIGGER "home_page_content_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."home_page_content"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();

CREATE CONSTRAINT TRIGGER "billing_offer_producer_semantic_fingerprint_guard"
AFTER INSERT OR UPDATE OR DELETE ON "platform"."billing_offer_producer_state"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();
