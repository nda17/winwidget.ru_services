ALTER TABLE "telegram_bot_settings"
ADD COLUMN "operational_alerts_thread_id" INTEGER;

CREATE OR REPLACE FUNCTION "reporting_settings_projection_trigger"()
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
        AND NEW."operational_alerts_thread_id" IS NOT DISTINCT FROM OLD."operational_alerts_thread_id"
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
            'coreOperationalAlertsThreadId', NEW."operational_alerts_thread_id",
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

-- The dedicated production topic for Core incidents is 2024. The Reporting
-- cutover gate additionally requires it to differ from the Daily Summary topic
-- before scheduler ownership can move.
UPDATE "telegram_bot_settings"
SET "operational_alerts_thread_id" = 2024
WHERE "operational_alerts_thread_id" IS NULL;

ALTER TABLE "telegram_bot_settings"
ADD CONSTRAINT "telegram_bot_settings_operational_alerts_thread_id_check"
CHECK (
    "operational_alerts_thread_id" IS NULL
    OR "operational_alerts_thread_id" > 0
);
