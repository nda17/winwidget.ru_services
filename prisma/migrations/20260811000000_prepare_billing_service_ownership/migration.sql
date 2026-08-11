CREATE TYPE "BillingCoreOwnership" AS ENUM ('CORE', 'BILLING');
CREATE TYPE "BillingSettingsCompositionStatus" AS ENUM (
    'PENDING',
    'BILLING_APPLIED',
    'COMPLETED'
);

CREATE TABLE "billing_core_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "ownership" "BillingCoreOwnership" NOT NULL DEFAULT 'CORE',
    "source_producers_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "legacy_routes_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "scheduler_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "legacy_consumer_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "projection_consumer_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "prepared_revision" TEXT,
    "ownership_revision" TEXT,
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_core_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_core_state_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "billing_core_state_generation_check" CHECK ("generation" >= 0),
    CONSTRAINT "billing_core_state_prepared_revision_check" CHECK (
        "prepared_revision" IS NULL
        OR "prepared_revision" ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT "billing_core_state_ownership_revision_check" CHECK (
        "ownership_revision" IS NULL
        OR "ownership_revision" ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT "billing_core_state_active_fence_check" CHECK (
        "ownership" <> 'BILLING'::"BillingCoreOwnership"
        OR (
            "source_producers_enabled" = FALSE
            AND "legacy_routes_enabled" = FALSE
            AND "scheduler_enabled" = FALSE
            AND "legacy_consumer_enabled" = FALSE
            AND "projection_consumer_enabled" = TRUE
            AND "generation" > 0
            AND "prepared_revision" IS NOT NULL
            AND "ownership_revision" IS NOT NULL
            AND "ownership_revision" = "prepared_revision"
            AND "activated_at" IS NOT NULL
        )
    )
);

INSERT INTO "billing_core_state" ("id") VALUES ('singleton');

CREATE TABLE "billing_source_aggregate_versions" (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "source_sequence" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_source_aggregate_versions_pkey"
        PRIMARY KEY ("aggregate_type", "aggregate_id"),
    CONSTRAINT "billing_source_aggregate_versions_version_check"
        CHECK ("version" > 0),
    CONSTRAINT "billing_source_aggregate_versions_source_sequence_check"
        CHECK ("source_sequence" > 0)
);

CREATE INDEX "billing_source_aggregate_versions_source_sequence_idx"
    ON "billing_source_aggregate_versions"("source_sequence");

CREATE SEQUENCE "billing_source_sequence"
    AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

-- Establish a durable baseline for aggregates that already exist when the
-- Billing source producers are installed.  The frozen exporter requires a
-- version/source-sequence pair for every full-state projection; later trigger
-- events increment these rows and therefore continue from version 2 instead
-- of resetting continuity during the service import.
INSERT INTO "billing_source_aggregate_versions" (
    "aggregate_type",
    "aggregate_id",
    "version",
    "source_sequence",
    "updated_at"
)
SELECT
    source."aggregate_type",
    source."aggregate_id",
    1,
    nextval('"billing_source_sequence"'),
    CURRENT_TIMESTAMP
FROM (
    SELECT
        'billing.identity'::TEXT AS "aggregate_type",
        "id"::TEXT AS "aggregate_id"
    FROM "User"

    UNION ALL

    SELECT
        'billing.notification-routing'::TEXT AS "aggregate_type",
        "id"::TEXT AS "aggregate_id"
    FROM "telegram_bot_settings"

    UNION ALL

    SELECT
        'billing.settings'::TEXT AS "aggregate_type",
        'singleton'::TEXT AS "aggregate_id"

    UNION ALL

    SELECT
        'billing.offer'::TEXT AS "aggregate_type",
        'offer'::TEXT AS "aggregate_id"
) AS source
ORDER BY source."aggregate_type", source."aggregate_id";

CREATE TABLE "billing_read_projection_versions" (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "source_sequence" BIGINT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_read_projection_versions_pkey"
        PRIMARY KEY ("aggregate_type", "aggregate_id"),
    CONSTRAINT "billing_read_projection_versions_version_check"
        CHECK ("version" > 0),
    CONSTRAINT "billing_read_projection_versions_source_sequence_check"
        CHECK ("source_sequence" IS NULL OR "source_sequence" > 0)
);

CREATE INDEX "billing_read_projection_versions_source_sequence_idx"
    ON "billing_read_projection_versions"("source_sequence");

CREATE TABLE "billing_subscription_read_projections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "billing_period" "BillingPeriod",
    "status" "SubscriptionStatus" NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "leads_this_period" INTEGER NOT NULL DEFAULT 0,
    "period_resets_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "source_version" BIGINT NOT NULL,
    "source_sequence" BIGINT,
    "projected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_subscription_read_projections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_subscription_read_source_version_check" CHECK ("source_version" > 0),
    CONSTRAINT "billing_subscription_read_source_sequence_check"
        CHECK ("source_sequence" IS NULL OR "source_sequence" > 0)
);

CREATE UNIQUE INDEX "billing_subscription_read_projections_user_id_key"
    ON "billing_subscription_read_projections"("user_id");
CREATE INDEX "billing_subscription_read_status_expires_idx"
    ON "billing_subscription_read_projections"("status", "expires_at");
CREATE INDEX "billing_subscription_read_user_status_idx"
    ON "billing_subscription_read_projections"("user_id", "status", "expires_at");

CREATE TABLE "billing_payment_read_projections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "yookassa_id" TEXT,
    "status" "PaymentStatus" NOT NULL,
    "amount" TEXT NOT NULL,
    "plan" "Plan",
    "billing_period" "BillingPeriod",
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "source_version" BIGINT NOT NULL,
    "source_sequence" BIGINT,
    "projected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_payment_read_projections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_payment_read_source_version_check" CHECK ("source_version" > 0),
    CONSTRAINT "billing_payment_read_source_sequence_check"
        CHECK ("source_sequence" IS NULL OR "source_sequence" > 0)
);

CREATE INDEX "billing_payment_read_user_created_idx"
    ON "billing_payment_read_projections"("user_id", "created_at");
CREATE INDEX "billing_payment_read_user_status_idx"
    ON "billing_payment_read_projections"("user_id", "status");
CREATE INDEX "billing_payment_read_status_created_idx"
    ON "billing_payment_read_projections"("status", "created_at");

CREATE TABLE "billing_affiliate_read_projections" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "first_payment_id" TEXT,
    "status" "AffiliateReferralStatus" NOT NULL,
    "cashback_amount" INTEGER,
    "available_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "source_version" BIGINT NOT NULL,
    "source_sequence" BIGINT,
    "projected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_affiliate_read_projections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_affiliate_read_source_version_check" CHECK ("source_version" > 0),
    CONSTRAINT "billing_affiliate_read_source_sequence_check"
        CHECK ("source_sequence" IS NULL OR "source_sequence" > 0)
);

CREATE UNIQUE INDEX "billing_affiliate_read_projections_referred_user_id_key"
    ON "billing_affiliate_read_projections"("referred_user_id");
CREATE INDEX "billing_affiliate_read_referrer_status_idx"
    ON "billing_affiliate_read_projections"("referrer_id", "status");
CREATE INDEX "billing_affiliate_read_status_available_idx"
    ON "billing_affiliate_read_projections"("status", "available_at");
CREATE INDEX "billing_affiliate_read_first_payment_idx"
    ON "billing_affiliate_read_projections"("first_payment_id");

CREATE TABLE "billing_settings_read_projection" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "payment_enabled" BOOLEAN NOT NULL,
    "auto_renewal_signup_enabled" BOOLEAN NOT NULL,
    "auto_renewal_charges_enabled" BOOLEAN NOT NULL,
    "auto_renewal_charges_enabled_at" TIMESTAMP(3) NOT NULL,
    "affiliate_program_enabled" BOOLEAN NOT NULL,
    "affiliate_cashback_percent" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "source_version" BIGINT NOT NULL,
    "source_sequence" BIGINT,
    "projected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_settings_read_projection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_settings_read_projection_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "billing_settings_read_source_version_check" CHECK ("source_version" > 0),
    CONSTRAINT "billing_settings_read_source_sequence_check"
        CHECK ("source_sequence" IS NULL OR "source_sequence" > 0)
);

CREATE TABLE "billing_settings_compositions" (
    "id" UUID NOT NULL,
    "status" "BillingSettingsCompositionStatus" NOT NULL DEFAULT 'PENDING',
    "core_patch" JSONB NOT NULL,
    "billing_patch" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "applied_billing_settings" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "billing_settings_compositions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_settings_compositions_attempts_check" CHECK ("attempts" >= 0),
    CONSTRAINT "billing_settings_compositions_core_patch_check"
        CHECK (jsonb_typeof("core_patch") = 'object'),
    CONSTRAINT "billing_settings_compositions_billing_patch_check"
        CHECK (jsonb_typeof("billing_patch") = 'object'),
    CONSTRAINT "billing_settings_compositions_state_check" CHECK (
        ("status" = 'PENDING'::"BillingSettingsCompositionStatus"
            AND "applied_billing_settings" IS NULL
            AND "completed_at" IS NULL)
        OR ("status" = 'BILLING_APPLIED'::"BillingSettingsCompositionStatus"
            AND "applied_billing_settings" IS NOT NULL
            AND "completed_at" IS NULL)
        OR ("status" = 'COMPLETED'::"BillingSettingsCompositionStatus"
            AND "applied_billing_settings" IS NOT NULL
            AND "completed_at" IS NOT NULL)
    )
);

CREATE INDEX "billing_settings_compositions_status_updated_idx"
    ON "billing_settings_compositions"("status", "updated_at");

CREATE FUNCTION "billing_core_state_transition_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."ownership" = 'BILLING'::"BillingCoreOwnership" THEN
        IF NEW."ownership" <> OLD."ownership"
            OR NEW."source_producers_enabled" <> OLD."source_producers_enabled"
            OR NEW."legacy_routes_enabled" <> OLD."legacy_routes_enabled"
            OR NEW."scheduler_enabled" <> OLD."scheduler_enabled"
            OR NEW."legacy_consumer_enabled" <> OLD."legacy_consumer_enabled"
            OR NEW."projection_consumer_enabled" <> OLD."projection_consumer_enabled"
            OR NEW."generation" <> OLD."generation"
            OR NEW."prepared_revision" IS DISTINCT FROM OLD."prepared_revision"
            OR NEW."ownership_revision" IS DISTINCT FROM OLD."ownership_revision"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
        THEN
            RAISE EXCEPTION 'Billing ownership is forward-only after activation';
        END IF;
    END IF;

    IF NEW."generation" < OLD."generation" THEN
        RAISE EXCEPTION 'Billing ownership generation cannot decrease';
    END IF;

    IF NEW."ownership" = 'BILLING'::"BillingCoreOwnership"
        AND (
            NEW."source_producers_enabled"
            OR NEW."legacy_routes_enabled"
            OR NEW."scheduler_enabled"
            OR NEW."legacy_consumer_enabled"
            OR NOT NEW."projection_consumer_enabled"
            OR NEW."generation" <= 0
            OR NEW."prepared_revision" IS NULL
            OR NEW."ownership_revision" IS NULL
            OR NEW."ownership_revision" <> NEW."prepared_revision"
            OR NEW."activated_at" IS NULL
        )
    THEN
        RAISE EXCEPTION 'Billing ownership activation requires every Core writer fence';
    END IF;

    NEW."updated_at" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_core_state_transition_guard"
BEFORE UPDATE ON "billing_core_state"
FOR EACH ROW EXECUTE FUNCTION "billing_core_state_transition_guard"();

CREATE FUNCTION "billing_core_source_producers_enabled"()
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    enabled_value BOOLEAN;
BEGIN
    -- Every legacy Billing writer participates in the ownership boundary.
    -- The row lock makes freeze wait for in-flight writers and makes stale
    -- repeatable-read/serializable writers fail instead of committing across
    -- the frozen snapshot boundary.
    SELECT "ownership" = 'CORE'::"BillingCoreOwnership"
        AND "source_producers_enabled"
    INTO enabled_value
    FROM "billing_core_state"
    WHERE "id" = 'singleton'
    FOR SHARE;

    RETURN COALESCE(enabled_value, FALSE);
END;
$$;

CREATE FUNCTION "billing_core_ownership_active"()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT "ownership" = 'BILLING'::"BillingCoreOwnership"
            FROM "billing_core_state"
            WHERE "id" = 'singleton'
        ),
        FALSE
    );
$$;

CREATE FUNCTION "billing_assert_legacy_table_write_enabled"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT "billing_core_source_producers_enabled"() THEN
        RAISE EXCEPTION 'Core Billing source is frozen; legacy table write rejected'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION "billing_assert_legacy_settings_write_enabled"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF "billing_core_source_producers_enabled"() THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'Core Billing settings source is frozen; legacy field write rejected'
            USING ERRCODE = '55000';
    END IF;

    IF NEW."payment_enabled" IS DISTINCT FROM OLD."payment_enabled"
        OR NEW."auto_renewal_signup_enabled" IS DISTINCT FROM OLD."auto_renewal_signup_enabled"
        OR NEW."auto_renewal_charges_enabled" IS DISTINCT FROM OLD."auto_renewal_charges_enabled"
        OR NEW."auto_renewal_charges_enabled_at" IS DISTINCT FROM OLD."auto_renewal_charges_enabled_at"
        OR NEW."affiliate_program_enabled" IS DISTINCT FROM OLD."affiliate_program_enabled"
        OR NEW."affiliate_cashback_percent" IS DISTINCT FROM OLD."affiliate_cashback_percent"
    THEN
        RAISE EXCEPTION 'Core Billing settings source is frozen; legacy field write rejected'
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION "billing_iso_timestamp"(value TIMESTAMP WITHOUT TIME ZONE)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
    SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

CREATE FUNCTION "billing_record_source_event"(
    event_type_value TEXT,
    routing_key_value TEXT,
    aggregate_type_value TEXT,
    aggregate_id_value TEXT,
    state_value JSONB,
    tombstone_value BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    event_id_value UUID := gen_random_uuid();
    aggregate_version_value BIGINT;
    source_sequence_value BIGINT;
    occurred_at_value TIMESTAMP(3) := CURRENT_TIMESTAMP;
BEGIN
    IF BTRIM(event_type_value) = ''
        OR BTRIM(routing_key_value) = ''
        OR BTRIM(aggregate_type_value) = ''
        OR BTRIM(aggregate_id_value) = ''
    THEN
        RAISE EXCEPTION 'Billing source event identifiers must not be blank';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('billing:source:' || aggregate_type_value || ':' || aggregate_id_value, 0)
    );

    source_sequence_value := nextval('"billing_source_sequence"');

    INSERT INTO "billing_source_aggregate_versions" (
        "aggregate_type",
        "aggregate_id",
        "version",
        "source_sequence",
        "updated_at"
    )
    VALUES (
        aggregate_type_value,
        aggregate_id_value,
        1,
        source_sequence_value,
        occurred_at_value
    )
    ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE
    SET "version" = "billing_source_aggregate_versions"."version" + 1,
        "source_sequence" = EXCLUDED."source_sequence",
        "updated_at" = EXCLUDED."updated_at"
    RETURNING "version" INTO aggregate_version_value;

    INSERT INTO "outbox_events" (
        "id",
        "message_id",
        "deduplication_key",
        "event_type",
        "routing_key",
        "payload",
        "headers",
        "status",
        "attempts",
        "available_at",
        "created_at",
        "updated_at"
    )
    VALUES (
        event_id_value,
        event_id_value,
        event_type_value || ':' || aggregate_type_value || ':' || aggregate_id_value || ':' || aggregate_version_value::TEXT,
        event_type_value,
        routing_key_value,
        jsonb_build_object(
            'eventId', event_id_value::TEXT,
            'eventType', event_type_value,
            'schemaVersion', 1,
            'aggregateId', aggregate_id_value,
            'aggregateVersion', aggregate_version_value::TEXT,
            'sourceSequence', source_sequence_value::TEXT,
            'occurredAt', "billing_iso_timestamp"(occurred_at_value),
            'tombstone', tombstone_value,
            'state', state_value
        ),
        '{}'::JSONB,
        'PENDING'::"OutboxEventStatus",
        0,
        occurred_at_value,
        occurred_at_value,
        occurred_at_value
    );
END;
$$;

CREATE FUNCTION "billing_emit_identity_projection"(
    user_id_value TEXT,
    tombstone_value BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('billing:identity:' || user_id_value, 0)
    );

    IF tombstone_value THEN
        PERFORM "billing_record_source_event"(
            'billing.identity.changed.v1',
            'billing.identity.changed.v1',
            'billing.identity',
            user_id_value,
            NULL,
            TRUE
        );
        RETURN;
    END IF;

    SELECT jsonb_build_object(
        'id', "user"."id",
        'name', "user"."name",
        'email', (
            SELECT NULLIF(BTRIM("identity"."value"), '')
            FROM "auth_identities" AS "identity"
            WHERE "identity"."user_id" = "user"."id"
                AND "identity"."type" = 'EMAIL'::"AuthIdentityType"
            LIMIT 1
        ),
        'phone', (
            SELECT NULLIF(BTRIM("identity"."value"), '')
            FROM "auth_identities" AS "identity"
            WHERE "identity"."user_id" = "user"."id"
                AND "identity"."type" = 'PHONE'::"AuthIdentityType"
            LIMIT 1
        ),
        'status', "user"."status"::TEXT,
        'deletedAt', CASE
            WHEN "user"."deleted_at" IS NULL THEN NULL
            ELSE "billing_iso_timestamp"("user"."deleted_at")
        END,
        'roles', (
            SELECT COALESCE(jsonb_agg("role_value" ORDER BY "role_value"), '[]'::JSONB)
            FROM (
                SELECT DISTINCT "role"::TEXT AS "role_value"
                FROM unnest("user"."rights") AS "role"
            ) AS "unique_roles"
        ),
        'telegramChatId', CASE
            WHEN "channel"."is_active" THEN NULLIF(BTRIM("channel"."chat_id"), '')
            ELSE NULL
        END,
        'telegramChannelActive', COALESCE("channel"."is_active", FALSE),
        'createdAt', "billing_iso_timestamp"("user"."created_at"),
        'updatedAt', "billing_iso_timestamp"("user"."updated_at")
    )
    INTO state_value
    FROM "User" AS "user"
    LEFT JOIN "telegram_notification_channels" AS "channel"
        ON "channel"."user_id" = "user"."id"
    WHERE "user"."id" = user_id_value;

    IF state_value IS NULL THEN
        RETURN;
    END IF;

    PERFORM "billing_record_source_event"(
        'billing.identity.changed.v1',
        'billing.identity.changed.v1',
        'billing.identity',
        user_id_value,
        state_value,
        FALSE
    );
END;
$$;

CREATE FUNCTION "billing_identity_user_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."name" IS NOT DISTINCT FROM OLD."name"
        AND NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."deleted_at" IS NOT DISTINCT FROM OLD."deleted_at"
        AND NEW."rights" IS NOT DISTINCT FROM OLD."rights"
        AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "billing_emit_identity_projection"(OLD."id", TRUE);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        PERFORM "billing_emit_identity_projection"(NEW."id", FALSE);
        IF TG_OP = 'INSERT' AND NOT "billing_core_source_producers_enabled"() THEN
            PERFORM "billing_record_source_event"(
                'billing.trial.requested.v1',
                'billing.trial.requested.v1',
                'billing.trial',
                NEW."id",
                jsonb_build_object(
                    'userId', NEW."id",
                    'trialDays', 7,
                    'registeredAt', "billing_iso_timestamp"(NEW."created_at")
                ),
                FALSE
            );
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "billing_identity_auth_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."type" IS NOT DISTINCT FROM OLD."type"
        AND NEW."value" IS NOT DISTINCT FROM OLD."value"
        AND NEW."verified_at" IS NOT DISTINCT FROM OLD."verified_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id") THEN
        PERFORM "billing_emit_identity_projection"(OLD."user_id", FALSE);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        PERFORM "billing_emit_identity_projection"(NEW."user_id", FALSE);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "billing_identity_telegram_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."chat_id" IS NOT DISTINCT FROM OLD."chat_id"
        AND NEW."is_active" IS NOT DISTINCT FROM OLD."is_active"
        AND NEW."disabled_at" IS NOT DISTINCT FROM OLD."disabled_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id") THEN
        PERFORM "billing_emit_identity_projection"(OLD."user_id", FALSE);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        PERFORM "billing_emit_identity_projection"(NEW."user_id", FALSE);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "billing_notification_routing_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."daily_summary_chat_id" IS NOT DISTINCT FROM OLD."daily_summary_chat_id"
        AND NEW."payments_thread_id" IS NOT DISTINCT FROM OLD."payments_thread_id"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "billing_record_source_event"(
            'billing.notification-routing.changed.v1',
            'billing.notification-routing.changed.v1',
            'billing.notification-routing',
            OLD."id",
            NULL,
            TRUE
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'telegramChatId', NULLIF(BTRIM(NEW."daily_summary_chat_id"), ''),
            'paymentsThreadId', NEW."payments_thread_id",
            'updatedAt', "billing_iso_timestamp"(NEW."updated_at")
        );
        PERFORM "billing_record_source_event"(
            'billing.notification-routing.changed.v1',
            'billing.notification-routing.changed.v1',
            'billing.notification-routing',
            NEW."id",
            state_value,
            FALSE
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "billing_settings_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF NOT "billing_core_source_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE'
        AND NEW."payment_enabled" IS NOT DISTINCT FROM OLD."payment_enabled"
        AND NEW."auto_renewal_signup_enabled" IS NOT DISTINCT FROM OLD."auto_renewal_signup_enabled"
        AND NEW."auto_renewal_charges_enabled" IS NOT DISTINCT FROM OLD."auto_renewal_charges_enabled"
        AND NEW."auto_renewal_charges_enabled_at" IS NOT DISTINCT FROM OLD."auto_renewal_charges_enabled_at"
        AND NEW."affiliate_program_enabled" IS NOT DISTINCT FROM OLD."affiliate_program_enabled"
        AND NEW."affiliate_cashback_percent" IS NOT DISTINCT FROM OLD."affiliate_cashback_percent"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "billing_record_source_event"(
            'billing.settings.source.changed.v1',
            'billing.settings.source.changed.v1',
            'billing.settings',
            OLD."id",
            NULL,
            TRUE
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'paymentEnabled', NEW."payment_enabled",
            'autoRenewalSignupEnabled', NEW."auto_renewal_signup_enabled",
            'autoRenewalChargesEnabled', NEW."auto_renewal_charges_enabled",
            'autoRenewalChargesEnabledAt', "billing_iso_timestamp"(NEW."auto_renewal_charges_enabled_at"),
            'affiliateProgramEnabled', NEW."affiliate_program_enabled",
            'affiliateCashbackPercent', NEW."affiliate_cashback_percent",
            'updatedAt', "billing_iso_timestamp"(NEW."updated_at")
        );
        PERFORM "billing_record_source_event"(
            'billing.settings.source.changed.v1',
            'billing.settings.source.changed.v1',
            'billing.settings',
            NEW."id",
            state_value,
            FALSE
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "billing_offer_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."slug" IS NOT DISTINCT FROM OLD."slug"
        AND NEW."content" IS NOT DISTINCT FROM OLD."content"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE'
        OR (TG_OP = 'UPDATE' AND OLD."slug" = 'oferta' AND NEW."slug" <> 'oferta')
    THEN
        IF OLD."slug" = 'oferta' THEN
            PERFORM "billing_record_source_event"(
                'billing.offer.changed.v1',
                'billing.offer.changed.v1',
                'billing.offer',
                'offer',
                NULL,
                TRUE
            );
        END IF;
    END IF;

    IF TG_OP <> 'DELETE' AND NEW."slug" = 'oferta' THEN
        state_value := jsonb_build_object(
            'id', 'offer',
            'content', NEW."content",
            'sha256', encode(sha256(convert_to(NEW."content", 'UTF8')), 'hex'),
            'updatedAt', "billing_iso_timestamp"(NEW."updated_at"),
            'consentVersion', 'auto-renewal-2026-07-28-v4',
            'consentText', 'Я соглашаюсь сохранить способ оплаты в ЮKassa, автоматически продлевать выбранную подписку и списывать указанную на странице оплаты сумму с выбранной периодичностью. При недостатке средств или временной недоступности банка Исполнитель вправе выполнить после первого отказа не более двух повторных попыток ориентировочно через 24 и 72 часа. Запрос на каждую повторную попытку может быть отправлен в течение не более одного часа после расчётного момента; если это окно пропущено, такая попытка не выполняется. Новый период начинается только после успешного списания. Автопродление можно отключить в личном кабинете или через info@winwidget.ru в любое время до отправки очередного запроса на списание; оплаченный период сохранится. Новая стоимость применяется только после отдельного подтверждения.'
        );
        PERFORM "billing_record_source_event"(
            'billing.offer.changed.v1',
            'billing.offer.changed.v1',
            'billing.offer',
            'offer',
            state_value,
            FALSE
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "billing_identity_user_projection"
AFTER INSERT OR UPDATE OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION "billing_identity_user_projection_trigger"();

CREATE TRIGGER "billing_identity_auth_projection"
AFTER INSERT OR UPDATE OR DELETE ON "auth_identities"
FOR EACH ROW EXECUTE FUNCTION "billing_identity_auth_projection_trigger"();

CREATE TRIGGER "billing_identity_telegram_projection"
AFTER INSERT OR UPDATE OR DELETE ON "telegram_notification_channels"
FOR EACH ROW EXECUTE FUNCTION "billing_identity_telegram_projection_trigger"();

CREATE TRIGGER "billing_notification_routing_projection"
AFTER INSERT OR UPDATE OR DELETE ON "telegram_bot_settings"
FOR EACH ROW EXECUTE FUNCTION "billing_notification_routing_projection_trigger"();

CREATE TRIGGER "billing_settings_projection"
AFTER INSERT OR UPDATE OR DELETE ON "site_settings"
FOR EACH ROW EXECUTE FUNCTION "billing_settings_projection_trigger"();

CREATE TRIGGER "billing_offer_projection"
AFTER INSERT OR UPDATE OR DELETE ON "legal_pages"
FOR EACH ROW EXECUTE FUNCTION "billing_offer_projection_trigger"();

CREATE TRIGGER "billing_payments_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_payment_receipts_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "payment_receipts"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_subscriptions_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_subscription_history_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_history"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_subscription_reminders_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "subscription_expiry_reminders"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_auto_renewals_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "auto_renewals"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_auto_renewal_events_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "auto_renewal_consent_events"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_tariff_prices_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "tariff_prices"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_affiliate_referrals_legacy_write_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "affiliate_referrals"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_table_write_enabled"();

CREATE TRIGGER "billing_site_settings_insert_delete_fence"
BEFORE INSERT OR DELETE ON "site_settings"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_settings_write_enabled"();

CREATE TRIGGER "billing_site_settings_fields_update_fence"
BEFORE UPDATE OF
    "payment_enabled",
    "auto_renewal_signup_enabled",
    "auto_renewal_charges_enabled",
    "auto_renewal_charges_enabled_at",
    "affiliate_program_enabled",
    "affiliate_cashback_percent"
ON "site_settings"
FOR EACH ROW EXECUTE FUNCTION "billing_assert_legacy_settings_write_enabled"();

DROP TRIGGER "reporting_payment_projection" ON "payments";
CREATE TRIGGER "reporting_payment_projection"
AFTER INSERT OR UPDATE OR DELETE ON "payments"
FOR EACH ROW
WHEN ("billing_core_source_producers_enabled"())
EXECUTE FUNCTION "reporting_payment_projection_trigger"();

DROP TRIGGER "reporting_subscription_projection" ON "subscriptions";
CREATE TRIGGER "reporting_subscription_projection"
AFTER INSERT OR UPDATE OR DELETE ON "subscriptions"
FOR EACH ROW
WHEN ("billing_core_source_producers_enabled"())
EXECUTE FUNCTION "reporting_subscription_projection_trigger"();

REVOKE EXECUTE ON FUNCTION
    "billing_core_state_transition_guard"(),
    "billing_core_source_producers_enabled"(),
    "billing_core_ownership_active"(),
    "billing_assert_legacy_table_write_enabled"(),
    "billing_assert_legacy_settings_write_enabled"(),
    "billing_iso_timestamp"(TIMESTAMP WITHOUT TIME ZONE),
    "billing_record_source_event"(TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
    "billing_emit_identity_projection"(TEXT, BOOLEAN),
    "billing_identity_user_projection_trigger"(),
    "billing_identity_auth_projection_trigger"(),
    "billing_identity_telegram_projection_trigger"(),
    "billing_notification_routing_projection_trigger"(),
    "billing_settings_projection_trigger"(),
    "billing_offer_projection_trigger"()
FROM PUBLIC;

DO $billing_acl$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime') THEN
        GRANT SELECT ON TABLE "billing_core_state"
            TO "winwidget_api_runtime";
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
            "billing_source_aggregate_versions",
            "billing_read_projection_versions",
            "billing_subscription_read_projections",
            "billing_payment_read_projections",
            "billing_affiliate_read_projections",
            "billing_settings_read_projection",
            "billing_settings_compositions"
        TO "winwidget_api_runtime";
        GRANT USAGE, SELECT, UPDATE ON SEQUENCE "billing_source_sequence"
            TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION
            "billing_core_source_producers_enabled"(),
            "billing_core_ownership_active"(),
            "billing_assert_legacy_table_write_enabled"(),
            "billing_assert_legacy_settings_write_enabled"(),
            "billing_iso_timestamp"(TIMESTAMP WITHOUT TIME ZONE),
            "billing_record_source_event"(TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
            "billing_emit_identity_projection"(TEXT, BOOLEAN),
            "billing_identity_user_projection_trigger"(),
            "billing_identity_auth_projection_trigger"(),
            "billing_identity_telegram_projection_trigger"(),
            "billing_notification_routing_projection_trigger"(),
            "billing_settings_projection_trigger"(),
            "billing_offer_projection_trigger"()
        TO "winwidget_api_runtime";
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_maintenance') THEN
        GRANT SELECT ON TABLE
            "billing_core_state",
            "billing_source_aggregate_versions",
            "billing_read_projection_versions",
            "billing_subscription_read_projections",
            "billing_payment_read_projections",
            "billing_affiliate_read_projections",
            "billing_settings_read_projection",
            "billing_settings_compositions"
        TO "winwidget_maintenance";
        GRANT SELECT ON SEQUENCE "billing_source_sequence"
            TO "winwidget_maintenance";
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_backup') THEN
        GRANT SELECT ON TABLE
            "billing_core_state",
            "billing_source_aggregate_versions",
            "billing_read_projection_versions",
            "billing_subscription_read_projections",
            "billing_payment_read_projections",
            "billing_affiliate_read_projections",
            "billing_settings_read_projection",
            "billing_settings_compositions"
        TO "winwidget_backup";
        GRANT SELECT ON SEQUENCE "billing_source_sequence"
            TO "winwidget_backup";
    END IF;
END
$billing_acl$;
