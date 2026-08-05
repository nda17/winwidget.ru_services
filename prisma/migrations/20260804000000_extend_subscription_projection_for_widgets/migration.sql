-- Keep the existing reporting event type and base state stable while adding
-- the complete entitlement snapshot required by widgets-service. Reporting
-- accepts both the historical base state and this all-or-nothing extension.
CREATE OR REPLACE FUNCTION "reporting_subscription_projection_trigger"()
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
        AND NEW."billing_period" IS NOT DISTINCT FROM OLD."billing_period"
        AND NEW."status" IS NOT DISTINCT FROM OLD."status"
        AND NEW."starts_at" IS NOT DISTINCT FROM OLD."starts_at"
        AND NEW."expires_at" IS NOT DISTINCT FROM OLD."expires_at"
        AND NEW."period_resets_at" IS NOT DISTINCT FROM OLD."period_resets_at"
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
            'billingPeriod', CASE
                WHEN NEW."billing_period" IS NULL THEN NULL
                ELSE NEW."billing_period"::TEXT
            END,
            'status', NEW."status"::TEXT,
            'startsAt', "reporting_iso_timestamp"(NEW."starts_at"),
            'expiresAt', CASE
                WHEN NEW."expires_at" IS NULL THEN NULL
                ELSE "reporting_iso_timestamp"(NEW."expires_at")
            END,
            'periodResetsAt', CASE
                WHEN NEW."period_resets_at" IS NULL THEN NULL
                ELSE "reporting_iso_timestamp"(NEW."period_resets_at")
            END,
            'maxWidgets', CASE NEW."plan"::TEXT
                WHEN 'HARD' THEN 10
                ELSE 1
            END,
            'maxLeadsPerPeriod', CASE NEW."plan"::TEXT
                WHEN 'TRIAL' THEN 10
                WHEN 'EASY' THEN 100
                ELSE NULL
            END,
            'unlimited', NEW."plan"::TEXT = 'HARD',
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
