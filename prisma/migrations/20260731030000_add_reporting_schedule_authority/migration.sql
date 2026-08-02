ALTER TABLE "reporting_producer_state"
ADD COLUMN "daily_summary_schedule_time" TEXT,
ADD COLUMN "daily_summary_schedule_generation" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "daily_summary_policy_confirmed_change_id" UUID,
ADD COLUMN "daily_summary_policy_pending_change_id" UUID,
ADD COLUMN "daily_summary_policy_pending_time" TEXT,
ADD COLUMN "daily_summary_policy_pending_generation" BIGINT;

UPDATE "reporting_producer_state"
SET "daily_summary_schedule_time" = COALESCE(
    (
        SELECT "daily_summary_time"
        FROM "telegram_bot_settings"
        WHERE "id" = 'singleton'
    ),
    '01:50'
)
WHERE "id" = 'singleton';

ALTER TABLE "reporting_producer_state"
ALTER COLUMN "daily_summary_schedule_time" SET NOT NULL,
ALTER COLUMN "daily_summary_schedule_time" SET DEFAULT '01:50',
ADD CONSTRAINT "reporting_producer_state_daily_summary_schedule_time_check"
    CHECK (
        "daily_summary_schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ),
ADD CONSTRAINT "reporting_producer_state_schedule_generation_check"
    CHECK ("daily_summary_schedule_generation" >= 0),
ADD CONSTRAINT "reporting_producer_state_schedule_policy_pending_check"
    CHECK (
        (
            "daily_summary_policy_pending_change_id" IS NULL
            AND "daily_summary_policy_pending_time" IS NULL
            AND "daily_summary_policy_pending_generation" IS NULL
        )
        OR (
            "daily_summary_owner" = 'REPORTING'
            AND "daily_summary_policy_pending_change_id" IS NOT NULL
            AND "daily_summary_policy_pending_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            AND "daily_summary_policy_pending_generation" =
                "daily_summary_schedule_generation" + 1
        )
    );

DO $reporting_schedule_acl$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime'
    ) THEN
        GRANT UPDATE (
            "daily_summary_schedule_time",
            "daily_summary_schedule_generation",
            "daily_summary_policy_confirmed_change_id",
            "daily_summary_policy_pending_change_id",
            "daily_summary_policy_pending_time",
            "daily_summary_policy_pending_generation",
            "updated_at"
        ) ON TABLE "reporting_producer_state"
        TO "winwidget_api_runtime";
    END IF;
END
$reporting_schedule_acl$;
