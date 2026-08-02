-- Reporting phase A: install disabled, source-owned projection producers.
-- The producer switch is intentionally OFF after deploy. Activation is a
-- separate operational step after the Reporting topology and service are ready:
-- enable producers, run/import a repeatable-read snapshot, consume the entire
-- queued stream, then reconcile the shadow projection.

CREATE TABLE "reporting_producer_state" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMP(3),
    "daily_summary_owner" TEXT NOT NULL DEFAULT 'CORE',
    "daily_summary_switch_generation" BIGINT NOT NULL DEFAULT 0,
    "daily_summary_switched_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reporting_producer_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporting_producer_state_singleton_check"
        CHECK ("id" = 'singleton'),
    CONSTRAINT "reporting_producer_state_activation_check"
        CHECK (NOT "enabled" OR "activated_at" IS NOT NULL),
    CONSTRAINT "reporting_producer_state_daily_summary_owner_check"
        CHECK ("daily_summary_owner" IN ('CORE', 'REPORTING')),
    CONSTRAINT "reporting_producer_state_daily_summary_switch_check"
        CHECK (
            "daily_summary_switch_generation" >= 0
            AND (
                ("daily_summary_owner" = 'CORE' AND (
                    "daily_summary_switch_generation" = 0
                    OR "daily_summary_switched_at" IS NOT NULL
                ))
                OR (
                    "daily_summary_owner" = 'REPORTING'
                    AND "daily_summary_switch_generation" > 0
                    AND "daily_summary_switched_at" IS NOT NULL
                )
            )
        )
);

INSERT INTO "reporting_producer_state" (
    "id",
    "enabled",
    "activated_at",
    "daily_summary_owner",
    "daily_summary_switch_generation",
    "daily_summary_switched_at",
    "updated_at"
) VALUES ('singleton', false, NULL, 'CORE', 0, NULL, CURRENT_TIMESTAMP);

CREATE SEQUENCE "reporting_source_sequence" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE "reporting_projection_versions" (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "source_sequence" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reporting_projection_versions_pkey"
        PRIMARY KEY ("aggregate_type", "aggregate_id"),
    CONSTRAINT "reporting_projection_versions_version_check"
        CHECK ("version" > 0),
    CONSTRAINT "reporting_projection_versions_source_sequence_check"
        CHECK ("source_sequence" > 0)
);

CREATE INDEX "reporting_projection_versions_source_sequence_idx"
    ON "reporting_projection_versions"("source_sequence");

CREATE FUNCTION "reporting_producers_enabled"()
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    enabled_value BOOLEAN;
BEGIN
    -- Every source writer participates in the lifecycle boundary. Under
    -- REPEATABLE READ/SERIALIZABLE, a transaction with a stale snapshot will
    -- serialization-fail instead of committing a write using the old switch.
    SELECT "enabled"
    INTO enabled_value
    FROM "reporting_producer_state"
    WHERE "id" = 'singleton'
    FOR SHARE;

    RETURN COALESCE(enabled_value, false);
END;
$$;

CREATE FUNCTION "reporting_iso_timestamp"(
    value TIMESTAMP WITHOUT TIME ZONE
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
    SELECT to_char(value, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

CREATE FUNCTION "reporting_record_projection_event"(
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
    event_id_value UUID;
    aggregate_version_value BIGINT;
    source_sequence_value BIGINT;
    occurred_at_value TIMESTAMP WITHOUT TIME ZONE;
BEGIN
    IF NOT "reporting_producers_enabled"() THEN
        RETURN;
    END IF;

    IF aggregate_id_value IS NULL OR BTRIM(aggregate_id_value) = '' THEN
        RAISE EXCEPTION 'Reporting aggregate id must be non-empty';
    END IF;
    IF tombstone_value <> (state_value IS NULL) THEN
        RAISE EXCEPTION 'Reporting tombstone and state are inconsistent';
    END IF;

    source_sequence_value := nextval('"reporting_source_sequence"');
    occurred_at_value := clock_timestamp() AT TIME ZONE 'UTC';

    INSERT INTO "reporting_projection_versions" (
        "aggregate_type",
        "aggregate_id",
        "version",
        "source_sequence",
        "created_at",
        "updated_at"
    ) VALUES (
        aggregate_type_value,
        aggregate_id_value,
        1,
        source_sequence_value,
        occurred_at_value,
        occurred_at_value
    )
    ON CONFLICT ("aggregate_type", "aggregate_id") DO UPDATE SET
        "version" = "reporting_projection_versions"."version" + 1,
        "source_sequence" = EXCLUDED."source_sequence",
        "updated_at" = EXCLUDED."updated_at"
    RETURNING "version" INTO aggregate_version_value;

    event_id_value := gen_random_uuid();

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
    ) VALUES (
        event_id_value,
        event_id_value,
        'reporting:' || aggregate_type_value || ':' || aggregate_id_value || ':' || aggregate_version_value::TEXT,
        event_type_value,
        routing_key_value,
        jsonb_build_object(
            'schemaVersion', 1,
            'eventType', event_type_value,
            'eventId', event_id_value::TEXT,
            'aggregateId', aggregate_id_value,
            'aggregateVersion', aggregate_version_value::TEXT,
            'sourceSequence', source_sequence_value::TEXT,
            'occurredAt', "reporting_iso_timestamp"(occurred_at_value),
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

CREATE FUNCTION "reporting_emit_user_projection"(
    user_id_value TEXT,
    tombstone_value BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF NOT "reporting_producers_enabled"() THEN
        RETURN;
    END IF;

    -- Identity state spans User + auth_identities. Serialize the full-state
    -- SELECT before assigning a version so the newer version can never carry a
    -- snapshot which omitted an earlier concurrent identity mutation.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('reporting:identity.user:' || user_id_value, 0)
    );

    IF tombstone_value THEN
        PERFORM "reporting_record_projection_event"(
            'identity.user.changed.v1',
            'identity.user.changed.v1',
            'identity.user',
            user_id_value,
            NULL,
            true
        );
        RETURN;
    END IF;

    SELECT jsonb_build_object(
        'id', "user"."id",
        'status', "user"."status"::TEXT,
        'deletedAt', CASE
            WHEN "user"."deleted_at" IS NULL THEN NULL
            ELSE "reporting_iso_timestamp"("user"."deleted_at")
        END,
        'roles', (
            SELECT COALESCE(jsonb_agg("role_value" ORDER BY "role_value"), '[]'::JSONB)
            FROM (
                SELECT DISTINCT "role"::TEXT AS "role_value"
                FROM unnest("user"."rights") AS "role"
            ) AS "unique_roles"
        ),
        'hasEmailIdentity', EXISTS (
            SELECT 1
            FROM "auth_identities" AS "email_identity"
            WHERE "email_identity"."user_id" = "user"."id"
                AND "email_identity"."type" = 'EMAIL'::"AuthIdentityType"
        ),
        'hasPhoneIdentity', EXISTS (
            SELECT 1
            FROM "auth_identities" AS "phone_identity"
            WHERE "phone_identity"."user_id" = "user"."id"
                AND "phone_identity"."type" = 'PHONE'::"AuthIdentityType"
        ),
        'hasTelegramIdentity', EXISTS (
            SELECT 1
            FROM "auth_identities" AS "telegram_identity"
            WHERE "telegram_identity"."user_id" = "user"."id"
                AND "telegram_identity"."type" = 'TELEGRAM'::"AuthIdentityType"
        ),
        'loginMethodCount', (
            SELECT COUNT(*)::INTEGER
            FROM "auth_identities" AS "login_identity"
            WHERE "login_identity"."user_id" = "user"."id"
                AND (
                    "login_identity"."type" IN (
                        'EMAIL'::"AuthIdentityType",
                        'GOOGLE'::"AuthIdentityType",
                        'GITHUB'::"AuthIdentityType",
                        'TELEGRAM'::"AuthIdentityType"
                    )
                    OR (
                        "login_identity"."type" = 'PHONE'::"AuthIdentityType"
                        AND "login_identity"."verified_at" IS NOT NULL
                    )
                )
        ),
        'createdAt', "reporting_iso_timestamp"("user"."created_at"),
        'updatedAt', "reporting_iso_timestamp"("user"."updated_at")
    )
    INTO state_value
    FROM "User" AS "user"
    WHERE "user"."id" = user_id_value;

    -- During an ON DELETE CASCADE the parent may already be invisible. The
    -- User trigger owns the tombstone, so an identity cascade must not revive it.
    IF state_value IS NULL THEN
        RETURN;
    END IF;

    PERFORM "reporting_record_projection_event"(
        'identity.user.changed.v1',
        'identity.user.changed.v1',
        'identity.user',
        user_id_value,
        state_value,
        false
    );
END;
$$;

CREATE FUNCTION "reporting_user_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."deleted_at" IS NOT DISTINCT FROM OLD."deleted_at"
        AND NEW."rights" IS NOT DISTINCT FROM OLD."rights"
        AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_emit_user_projection"(OLD."id", true);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        PERFORM "reporting_emit_user_projection"(NEW."id", false);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_auth_identity_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."type" IS NOT DISTINCT FROM OLD."type"
        AND NEW."verified_at" IS NOT DISTINCT FROM OLD."verified_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id") THEN
        PERFORM "reporting_emit_user_projection"(OLD."user_id", false);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        PERFORM "reporting_emit_user_projection"(NEW."user_id", false);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_payment_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."amount" IS NOT DISTINCT FROM OLD."amount"
        AND NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
        AND NEW."updated_at" IS NOT DISTINCT FROM OLD."updated_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'billing.payment.changed.v1',
            'billing.payment.changed.v1',
            'billing.payment',
            OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'userId', NEW."user_id",
            'status', NEW."status"::TEXT,
            'amount', NEW."amount"::TEXT,
            'createdAt', "reporting_iso_timestamp"(NEW."created_at"),
            'updatedAt', "reporting_iso_timestamp"(NEW."updated_at")
        );
        PERFORM "reporting_record_projection_event"(
            'billing.payment.changed.v1',
            'billing.payment.changed.v1',
            'billing.payment',
            NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_subscription_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."plan" IS NOT DISTINCT FROM OLD."plan"
        AND NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
        AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'billing.subscription.changed.v1',
            'billing.subscription.changed.v1',
            'billing.subscription',
            OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'userId', NEW."user_id",
            'plan', NEW."plan"::TEXT,
            'status', NEW."status"::TEXT,
            'expiresAt', CASE
                WHEN NEW."expires_at" IS NULL THEN NULL
                ELSE "reporting_iso_timestamp"(NEW."expires_at")
            END,
            'createdAt', "reporting_iso_timestamp"(NEW."created_at")
        );
        PERFORM "reporting_record_projection_event"(
            'billing.subscription.changed.v1',
            'billing.subscription.changed.v1',
            'billing.subscription',
            NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_widget_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
    widget_type_value TEXT := TG_ARGV[0];
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id"
        AND NEW."is_active" IS NOT DISTINCT FROM OLD."is_active"
        AND NEW."install_domain" IS NOT DISTINCT FROM OLD."install_domain"
        AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'widgets.widget.changed.v1',
            'widgets.widget.changed.v1',
            'widgets.widget.' || widget_type_value,
            widget_type_value || ':' || OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'userId', NEW."user_id",
            'widgetType', widget_type_value,
            'isActive', NEW."is_active",
            'hasInstallDomain', NEW."install_domain" <> '',
            'createdAt', "reporting_iso_timestamp"(NEW."created_at")
        );
        PERFORM "reporting_record_projection_event"(
            'widgets.widget.changed.v1',
            'widgets.widget.changed.v1',
            'widgets.widget.' || widget_type_value,
            widget_type_value || ':' || NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_lead_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
    row_value JSONB;
    lead_type_value TEXT := TG_ARGV[0];
    widget_id_column TEXT := TG_ARGV[1];
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF to_jsonb(NEW)->>'id' IS NOT DISTINCT FROM to_jsonb(OLD)->>'id'
            AND to_jsonb(NEW)->>widget_id_column IS NOT DISTINCT FROM to_jsonb(OLD)->>widget_id_column
            AND to_jsonb(NEW)->>'created_at' IS NOT DISTINCT FROM to_jsonb(OLD)->>'created_at'
        THEN
            RETURN NULL;
        END IF;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE'
        OR (
            TG_OP = 'UPDATE'
            AND to_jsonb(NEW)->>'id' IS DISTINCT FROM to_jsonb(OLD)->>'id'
        )
    THEN
        row_value := to_jsonb(OLD);
        PERFORM "reporting_record_projection_event"(
            'widgets.lead.changed.v1',
            'widgets.lead.changed.v1',
            'widgets.lead.' || lead_type_value,
            lead_type_value || ':' || (row_value->>'id'),
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        row_value := to_jsonb(NEW);
        state_value := jsonb_build_object(
            'id', row_value->>'id',
            'widgetId', row_value->>widget_id_column,
            'widgetType', lead_type_value,
            'createdAt', "reporting_iso_timestamp"((row_value->>'created_at')::TIMESTAMP)
        );
        PERFORM "reporting_record_projection_event"(
            'widgets.lead.changed.v1',
            'widgets.lead.changed.v1',
            'widgets.lead.' || lead_type_value,
            lead_type_value || ':' || (row_value->>'id'),
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION "reporting_settings_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."daily_summary_enabled" IS NOT DISTINCT FROM OLD."daily_summary_enabled"
        AND NEW."daily_summary_chat_id" IS NOT DISTINCT FROM OLD."daily_summary_chat_id"
        AND NEW."reports_thread_id" IS NOT DISTINCT FROM OLD."reports_thread_id"
        AND NEW."daily_summary_time" IS NOT DISTINCT FROM OLD."daily_summary_time"
        AND NEW."daily_summary_last_sent_period_start" IS NOT DISTINCT FROM OLD."daily_summary_last_sent_period_start"
        AND NEW."daily_summary_last_sent_at" IS NOT DISTINCT FROM OLD."daily_summary_last_sent_at"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'reporting.settings.changed.v1',
            'reporting.settings.changed.v1',
            'reporting.settings',
            OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'enabled', NEW."daily_summary_enabled",
            'destinationChatId', NEW."daily_summary_chat_id",
            'messageThreadId', NEW."reports_thread_id",
            'scheduleTime', NEW."daily_summary_time",
            'timezone', 'Europe/Moscow',
            'lastSuccessfulPeriodStart', CASE
                WHEN NEW."daily_summary_last_sent_period_start" IS NULL THEN NULL
                ELSE "reporting_iso_timestamp"(NEW."daily_summary_last_sent_period_start")
            END,
            'lastSuccessfulAt', CASE
                WHEN NEW."daily_summary_last_sent_at" IS NULL THEN NULL
                ELSE "reporting_iso_timestamp"(NEW."daily_summary_last_sent_at")
            END
        );
        PERFORM "reporting_record_projection_event"(
            'reporting.settings.changed.v1',
            'reporting.settings.changed.v1',
            'reporting.settings',
            NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "reporting_user_projection"
AFTER INSERT OR UPDATE OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION "reporting_user_projection_trigger"();

CREATE TRIGGER "reporting_auth_identity_projection"
AFTER INSERT OR UPDATE OR DELETE ON "auth_identities"
FOR EACH ROW EXECUTE FUNCTION "reporting_auth_identity_projection_trigger"();

CREATE TRIGGER "reporting_payment_projection"
AFTER INSERT OR UPDATE OR DELETE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "reporting_payment_projection_trigger"();

CREATE TRIGGER "reporting_subscription_projection"
AFTER INSERT OR UPDATE OR DELETE ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "reporting_subscription_projection_trigger"();

CREATE TRIGGER "reporting_widget_projection"
AFTER INSERT OR UPDATE OR DELETE ON "widgets"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('wheel');

CREATE TRIGGER "reporting_quiz_projection"
AFTER INSERT OR UPDATE OR DELETE ON "quizzes"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('quiz');

CREATE TRIGGER "reporting_callback_projection"
AFTER INSERT OR UPDATE OR DELETE ON "callbacks"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('callback');

CREATE TRIGGER "reporting_countdown_timer_projection"
AFTER INSERT OR UPDATE OR DELETE ON "countdown_timers"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('countdownTimer');

CREATE TRIGGER "reporting_stop_offer_projection"
AFTER INSERT OR UPDATE OR DELETE ON "stop_offers"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('stopOffer');

CREATE TRIGGER "reporting_online_consultant_projection"
AFTER INSERT OR UPDATE OR DELETE ON "online_consultants"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('onlineConsultant');

CREATE TRIGGER "reporting_calculator_projection"
AFTER INSERT OR UPDATE OR DELETE ON "calculators"
FOR EACH ROW EXECUTE FUNCTION "reporting_widget_projection_trigger"('calculator');

CREATE TRIGGER "reporting_wheel_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('wheel', 'widget_id');

CREATE TRIGGER "reporting_quiz_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "quiz_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('quiz', 'quiz_id');

CREATE TRIGGER "reporting_callback_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "callback_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('callback', 'callback_id');

CREATE TRIGGER "reporting_countdown_timer_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "countdown_timer_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('countdownTimer', 'countdown_timer_id');

CREATE TRIGGER "reporting_stop_offer_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "stop_offer_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('stopOffer', 'stop_offer_id');

CREATE TRIGGER "reporting_online_consultant_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "online_consultant_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('onlineConsultant', 'online_consultant_id');

CREATE TRIGGER "reporting_calculator_lead_projection"
AFTER INSERT OR UPDATE OR DELETE ON "calculator_leads"
FOR EACH ROW EXECUTE FUNCTION "reporting_lead_projection_trigger"('calculator', 'calculator_id');

CREATE TRIGGER "reporting_settings_projection"
AFTER INSERT OR UPDATE OR DELETE ON "telegram_bot_settings"
FOR EACH ROW EXECUTE FUNCTION "reporting_settings_projection_trigger"();

-- The Core migration role owns these objects, while runtime triggers,
-- maintenance scheduling and backup use separate least-privilege roles in
-- production. CI databases may not provision those named roles, so grants are
-- conditional here and are verified fail-closed by the activation lifecycle.
REVOKE EXECUTE ON FUNCTION
    "reporting_producers_enabled"(),
    "reporting_iso_timestamp"(TIMESTAMP WITHOUT TIME ZONE),
    "reporting_record_projection_event"(TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
    "reporting_emit_user_projection"(TEXT, BOOLEAN),
    "reporting_user_projection_trigger"(),
    "reporting_auth_identity_projection_trigger"(),
    "reporting_payment_projection_trigger"(),
    "reporting_subscription_projection_trigger"(),
    "reporting_widget_projection_trigger"(),
    "reporting_lead_projection_trigger"(),
    "reporting_settings_projection_trigger"()
FROM PUBLIC;

DO $reporting_acl$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime') THEN
        GRANT SELECT ON TABLE "reporting_producer_state"
            TO "winwidget_api_runtime";
        GRANT SELECT, INSERT, UPDATE ON TABLE "reporting_projection_versions"
            TO "winwidget_api_runtime";
        GRANT USAGE, SELECT, UPDATE ON SEQUENCE "reporting_source_sequence"
            TO "winwidget_api_runtime";
        GRANT EXECUTE ON FUNCTION
            "reporting_producers_enabled"(),
            "reporting_iso_timestamp"(TIMESTAMP WITHOUT TIME ZONE),
            "reporting_record_projection_event"(TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN),
            "reporting_emit_user_projection"(TEXT, BOOLEAN),
            "reporting_user_projection_trigger"(),
            "reporting_auth_identity_projection_trigger"(),
            "reporting_payment_projection_trigger"(),
            "reporting_subscription_projection_trigger"(),
            "reporting_widget_projection_trigger"(),
            "reporting_lead_projection_trigger"(),
            "reporting_settings_projection_trigger"()
        TO "winwidget_api_runtime";
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_maintenance') THEN
        GRANT SELECT ON TABLE "reporting_producer_state"
            TO "winwidget_maintenance";
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_backup') THEN
        GRANT SELECT ON TABLE
            "reporting_producer_state",
            "reporting_projection_versions"
        TO "winwidget_backup";
        GRANT SELECT ON SEQUENCE "reporting_source_sequence"
            TO "winwidget_backup";
    END IF;
END
$reporting_acl$;
