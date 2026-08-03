BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtext('winwidget.reporting.daily-summary.owner.v1'));

DO $reporting_cleanup_guard$
DECLARE
    owner_ready BOOLEAN;
    pristine_bootstrap BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM "reporting_producer_state"
        WHERE "id" = 'singleton'
          AND "enabled" = true
          AND "activated_at" IS NOT NULL
          AND "daily_summary_owner" = 'REPORTING'
          AND "daily_summary_switch_generation" > 0
          AND "daily_summary_switched_at" IS NOT NULL
    ) INTO owner_ready;

    SELECT
        (SELECT count(*) = 1 FROM "reporting_producer_state")
        AND EXISTS (
            SELECT 1
            FROM "reporting_producer_state"
            WHERE "id" = 'singleton'
              AND "enabled" = false
              AND "activated_at" IS NULL
              AND "daily_summary_owner" = 'CORE'
              AND "daily_summary_switch_generation" = 0
              AND "daily_summary_switched_at" IS NULL
              AND "daily_summary_schedule_time" = '01:50'
              AND "daily_summary_schedule_generation" = 0
              AND "daily_summary_policy_confirmed_change_id" IS NULL
              AND "daily_summary_policy_pending_change_id" IS NULL
              AND "daily_summary_policy_pending_time" IS NULL
              AND "daily_summary_policy_pending_generation" IS NULL
        )
        AND NOT (SELECT "is_called" FROM "reporting_source_sequence")
        AND NOT EXISTS (SELECT 1 FROM "reporting_projection_versions")
        AND NOT EXISTS (SELECT 1 FROM "outbox_events")
        AND NOT EXISTS (SELECT 1 FROM "scheduled_job_runs")
        AND NOT EXISTS (SELECT 1 FROM "scheduled_job_idempotency_keys")
        AND NOT EXISTS (SELECT 1 FROM "integration_credential_snapshots")
        AND NOT EXISTS (SELECT 1 FROM "integration_delivery_receipts")
        AND NOT EXISTS (SELECT 1 FROM "integration_delivery_failures")
        AND (SELECT count(*) = 1 FROM "telegram_bot_settings")
        AND EXISTS (
            SELECT 1
            FROM "telegram_bot_settings"
            WHERE "id" = 'singleton'
              AND "daily_summary_enabled" = false
              AND "daily_summary_chat_id" = ''
              AND "daily_summary_last_sent_period_start" IS NULL
              AND "daily_summary_last_sent_at" IS NULL
              AND "daily_summary_time" = '01:50'
              AND "reports_thread_id" IS NULL
              AND "database_backup_enabled" = true
              AND "database_backup_time" = '01:45'
              AND "database_backup_last_sent_period_start" IS NULL
              AND "database_backup_last_sent_at" IS NULL
              AND "support_thread_id" IS NULL
              AND "database_backup_thread_id" IS NULL
              AND "payments_thread_id" IS NULL
              AND "operational_alerts_thread_id" = 2024
        )
        AND NOT EXISTS (SELECT 1 FROM "User")
        AND NOT EXISTS (SELECT 1 FROM "auth_identities")
        AND NOT EXISTS (SELECT 1 FROM "payments")
        AND NOT EXISTS (SELECT 1 FROM "subscriptions")
        AND NOT EXISTS (SELECT 1 FROM "widgets")
        AND NOT EXISTS (SELECT 1 FROM "quizzes")
        AND NOT EXISTS (SELECT 1 FROM "callbacks")
        AND NOT EXISTS (SELECT 1 FROM "countdown_timers")
        AND NOT EXISTS (SELECT 1 FROM "stop_offers")
        AND NOT EXISTS (SELECT 1 FROM "online_consultants")
        AND NOT EXISTS (SELECT 1 FROM "calculators")
        AND NOT EXISTS (SELECT 1 FROM "leads")
        AND NOT EXISTS (SELECT 1 FROM "quiz_leads")
        AND NOT EXISTS (SELECT 1 FROM "callback_leads")
        AND NOT EXISTS (SELECT 1 FROM "countdown_timer_leads")
        AND NOT EXISTS (SELECT 1 FROM "stop_offer_leads")
        AND NOT EXISTS (SELECT 1 FROM "online_consultant_leads")
        AND NOT EXISTS (SELECT 1 FROM "calculator_leads")
    INTO pristine_bootstrap;

    IF NOT (owner_ready OR pristine_bootstrap) OR EXISTS (
        SELECT 1
        FROM "scheduled_job_runs"
        WHERE "job_type" = 'DAILY_TELEGRAM_SUMMARY'
          AND "status" IN (
              'QUEUED'::"ScheduledJobRunStatus",
              'PROCESSING'::"ScheduledJobRunStatus"
          )
    ) OR EXISTS (
        SELECT 1
        FROM "outbox_events"
        WHERE "event_type" IN (
            'report.daily-summary.requested.v1',
            'notification.daily-summary.telegram.requested.v1',
            'reporting.settings.changed.v1'
        )
          AND "status" <> 'PUBLISHED'::"OutboxEventStatus"
    ) OR EXISTS (
        SELECT 1
        FROM "integration_delivery_failures"
        WHERE "integration" IN (
            'daily-summary-telegram',
            'daily-summary-delivery-telegram'
        )
          AND "resolved_at" IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM "integration_delivery_receipts"
        WHERE "integration" IN (
            'daily-summary-telegram',
            'daily-summary-delivery-telegram'
        )
          AND "status" IN (
              'PROCESSING'::"IntegrationDeliveryReceiptStatus",
              'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus"
          )
    ) OR EXISTS (
        SELECT 1
        FROM "scheduled_job_idempotency_keys" key
        JOIN "scheduled_job_runs" run ON run."id" = key."job_id"
        WHERE (key."job_type" = 'DAILY_TELEGRAM_SUMMARY') <>
              (run."job_type" = 'DAILY_TELEGRAM_SUMMARY')
    ) THEN
        RAISE EXCEPTION 'Legacy Reporting state is not drained';
    END IF;
END
$reporting_cleanup_guard$;

DELETE FROM "scheduled_job_idempotency_keys" key
USING "scheduled_job_runs" run
WHERE key."job_id" = run."id"
  AND key."job_type" = 'DAILY_TELEGRAM_SUMMARY'
  AND run."job_type" = 'DAILY_TELEGRAM_SUMMARY';

DELETE FROM "scheduled_job_runs"
WHERE "job_type" = 'DAILY_TELEGRAM_SUMMARY';

DELETE FROM "outbox_events"
WHERE "event_type" IN (
    'report.daily-summary.requested.v1',
    'notification.daily-summary.telegram.requested.v1',
    'reporting.settings.changed.v1'
);

UPDATE "reporting_projection_versions"
SET "aggregate_type" = 'reporting.core-operational-routing.changed.v1',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "aggregate_type" = 'reporting.settings';

DELETE FROM "integration_credential_snapshots"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

DELETE FROM "integration_delivery_receipts"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

DELETE FROM "integration_delivery_failures"
WHERE "integration" IN (
    'daily-summary-telegram',
    'daily-summary-delivery-telegram'
);

CREATE OR REPLACE FUNCTION "reporting_settings_projection_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    state_value JSONB;
BEGIN
    IF TG_OP = 'UPDATE'
        AND NEW."id" IS NOT DISTINCT FROM OLD."id"
        AND NEW."daily_summary_chat_id" IS NOT DISTINCT FROM OLD."daily_summary_chat_id"
        AND NEW."operational_alerts_thread_id" IS NOT DISTINCT FROM OLD."operational_alerts_thread_id"
    THEN
        RETURN NULL;
    END IF;
    IF NOT "reporting_producers_enabled"() THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id") THEN
        PERFORM "reporting_record_projection_event"(
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            OLD."id",
            NULL,
            true
        );
    END IF;
    IF TG_OP <> 'DELETE' THEN
        state_value := jsonb_build_object(
            'id', NEW."id",
            'coreOperationalAlertsDestinationChatId', NEW."daily_summary_chat_id",
            'coreOperationalAlertsThreadId', NEW."operational_alerts_thread_id"
        );
        PERFORM "reporting_record_projection_event"(
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            'reporting.core-operational-routing.changed.v1',
            NEW."id",
            state_value,
            false
        );
    END IF;
    RETURN NULL;
END;
$$;

ALTER TABLE "telegram_bot_settings"
    DROP COLUMN "daily_summary_enabled",
    DROP COLUMN "reports_thread_id",
    DROP COLUMN "daily_summary_time",
    DROP COLUMN "daily_summary_last_sent_period_start",
    DROP COLUMN "daily_summary_last_sent_at";

COMMIT;
