BEGIN;

DROP TRIGGER IF EXISTS "service_identity_semantic_fingerprint_guard"
    ON "platform"."service_identity";
DROP TRIGGER IF EXISTS "source_sequences_semantic_fingerprint_guard"
    ON "platform"."source_sequences";
DROP TRIGGER IF EXISTS "site_settings_semantic_fingerprint_guard"
    ON "platform"."site_settings";
DROP TRIGGER IF EXISTS "legal_pages_semantic_fingerprint_guard"
    ON "platform"."legal_pages";
DROP TRIGGER IF EXISTS "home_page_content_semantic_fingerprint_guard"
    ON "platform"."home_page_content";
DROP TRIGGER IF EXISTS "billing_offer_producer_semantic_fingerprint_guard"
    ON "platform"."billing_offer_producer_state";
DROP TRIGGER IF EXISTS "service_identity_lifecycle_guard"
    ON "platform"."service_identity";
DROP TRIGGER IF EXISTS "billing_offer_producer_lifecycle_guard"
    ON "platform"."billing_offer_producer_state";

DROP FUNCTION IF EXISTS "platform"."enforce_current_semantic_fingerprint"();
DROP FUNCTION IF EXISTS "platform"."refresh_current_semantic_fingerprint"(TEXT);
DROP FUNCTION IF EXISTS "platform"."current_semantic_fingerprint"();
DROP FUNCTION IF EXISTS "platform"."enforce_service_identity_lifecycle"();
DROP FUNCTION IF EXISTS "platform"."enforce_billing_offer_producer_lifecycle"();

ALTER TABLE "platform"."service_identity"
    DROP CONSTRAINT IF EXISTS "service_identity_generation_check",
    DROP CONSTRAINT IF EXISTS "service_identity_source_check";

ALTER TABLE "platform"."billing_offer_producer_state"
    DROP CONSTRAINT IF EXISTS "billing_offer_producer_versions_check",
    DROP CONSTRAINT IF EXISTS "billing_offer_producer_fingerprint_check",
    DROP CONSTRAINT IF EXISTS "billing_offer_producer_phase_check";

DO $platform_identity_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "platform"."service_identity"
        WHERE "id" = 'singleton'
            AND "service_name" = 'platform-service'
            AND "database_id" IS NOT NULL
            AND "current_semantic_fingerprint" ~ '^[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform database identity marker is invalid';
    END IF;
END
$platform_identity_check$;

INSERT INTO "platform"."billing_offer_producer_state" ("id")
VALUES ('offer')
ON CONFLICT ("id") DO NOTHING;

UPDATE "platform"."billing_offer_producer_state" AS producer
SET "producer_contract_version" = 2,
    "source_sequence_scope" = 'billing.offer:offer',
    "current_aggregate_version" = COALESCE(
        producer."current_aggregate_version",
        producer."imported_aggregate_version",
        page."aggregate_version"
    ),
    "current_source_sequence" = COALESCE(
        producer."current_source_sequence",
        producer."imported_source_sequence",
        page."source_sequence"
    ),
    "updated_at" = GREATEST(
        producer."updated_at",
        pg_catalog.clock_timestamp()::timestamp
    )
FROM "platform"."legal_pages" AS page
WHERE producer."id" = 'offer' AND page."slug" = 'oferta';

DO $platform_offer_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "platform"."billing_offer_producer_state"
        WHERE "id" = 'offer'
            AND "producer_contract_version" = 2
            AND "source_sequence_scope" = 'billing.offer:offer'
            AND "current_aggregate_version" IS NOT NULL
            AND "current_aggregate_version" >= 0
            AND "current_source_sequence" IS NOT NULL
            AND "current_source_sequence" >= 0
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform Billing offer cursor could not be initialized';
    END IF;
END
$platform_offer_check$;

ALTER TABLE "platform"."service_identity"
    DROP COLUMN "phase",
    DROP COLUMN "ownership_generation",
    DROP COLUMN "source_fingerprint",
    DROP COLUMN "source_snapshot_sha256",
    DROP COLUMN "source_snapshot_counts",
    DROP COLUMN "source_high_watermark",
    DROP COLUMN "imported_at",
    DROP COLUMN "activated_at";

ALTER TABLE "platform"."billing_offer_producer_state"
    ALTER COLUMN "producer_contract_version" SET DEFAULT 2,
    ALTER COLUMN "producer_contract_version" SET NOT NULL,
    ALTER COLUMN "source_sequence_scope" SET DEFAULT 'billing.offer:offer',
    ALTER COLUMN "source_sequence_scope" SET NOT NULL,
    ALTER COLUMN "current_aggregate_version" SET DEFAULT 0,
    ALTER COLUMN "current_aggregate_version" SET NOT NULL,
    ALTER COLUMN "current_source_sequence" SET DEFAULT 0,
    ALTER COLUMN "current_source_sequence" SET NOT NULL,
    DROP COLUMN "phase",
    DROP COLUMN "imported_aggregate_version",
    DROP COLUMN "imported_source_sequence",
    DROP COLUMN "source_fence_fingerprint",
    DROP COLUMN "imported_at",
    DROP COLUMN "activated_at";

DROP TYPE "platform"."ServiceDatabasePhase";
DROP TYPE "platform"."OfferProducerPhase";

ALTER TABLE "platform"."billing_offer_producer_state"
    ADD CONSTRAINT "billing_offer_producer_contract_check" CHECK (
        "producer_contract_version" = 2
        AND "source_sequence_scope" = 'billing.offer:offer'
    ),
    ADD CONSTRAINT "billing_offer_producer_cursor_check" CHECK (
        "current_aggregate_version" >= 0
        AND "current_source_sequence" >= 0
    );

CREATE FUNCTION "platform"."current_semantic_fingerprint"()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $$
SELECT encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 2,
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
        'contractVersion', offer."producer_contract_version",
        'sequenceScope', offer."source_sequence_scope",
        'currentAggregateVersion', offer."current_aggregate_version"::TEXT,
        'currentSourceSequence', offer."current_source_sequence"::TEXT
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

CREATE FUNCTION "platform"."enforce_service_identity_integrity"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, platform
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
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        OR NEW."updated_at" < OLD."updated_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform database identity marker is immutable';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "platform"."enforce_service_identity_integrity"() FROM PUBLIC;

CREATE FUNCTION "platform"."enforce_billing_offer_producer_cursor"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, platform
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform Billing offer producer cursor cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."producer_contract_version" IS DISTINCT FROM OLD."producer_contract_version"
        OR NEW."source_sequence_scope" IS DISTINCT FROM OLD."source_sequence_scope"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        OR NEW."current_aggregate_version" <> OLD."current_aggregate_version" + 1
        OR NEW."current_source_sequence" <> OLD."current_source_sequence" + 1
        OR NEW."updated_at" < OLD."updated_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Platform Billing offer cursors must advance once in lockstep';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "platform"."enforce_billing_offer_producer_cursor"() FROM PUBLIC;

UPDATE "platform"."service_identity"
SET "current_semantic_fingerprint" = "platform"."current_semantic_fingerprint"(),
    "updated_at" = GREATEST(
        "updated_at",
        pg_catalog.clock_timestamp()::timestamp
    )
WHERE "id" = 'singleton';

CREATE TRIGGER "service_identity_integrity_guard"
BEFORE UPDATE OR DELETE ON "platform"."service_identity"
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_service_identity_integrity"();

CREATE TRIGGER "billing_offer_producer_cursor_guard"
BEFORE UPDATE OR DELETE ON "platform"."billing_offer_producer_state"
FOR EACH ROW
EXECUTE FUNCTION "platform"."enforce_billing_offer_producer_cursor"();

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

COMMIT;
