ALTER TABLE reporting."heartbeats"
DROP CONSTRAINT "heartbeats_identity_check",
ADD CONSTRAINT "heartbeats_identity_check" CHECK (
    "role" IN ('all', 'api', 'worker', 'publisher', 'scheduler')
    AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
    AND jsonb_typeof("metadata") = 'object'
);

ALTER TABLE reporting."reporting_settings"
DROP CONSTRAINT "reporting_settings_content_check",
DROP CONSTRAINT "reporting_settings_core_operational_alerts_thread_id_check",
DROP COLUMN "owner",
DROP COLUMN "source_aggregate_version",
DROP COLUMN "source_sequence",
DROP COLUMN "state_hash",
DROP COLUMN "core_operational_alerts_destination_chat_id",
DROP COLUMN "core_operational_routing_source_aggregate_version",
DROP COLUMN "core_operational_routing_source_sequence",
DROP COLUMN "core_operational_routing_state_hash";

ALTER TABLE reporting."reporting_settings"
RENAME COLUMN "core_operational_alerts_thread_id" TO "operational_alerts_thread_id";

ALTER TABLE reporting."reporting_settings"
ADD COLUMN "operational_alerts_changed_at" TIMESTAMP(3);

ALTER TABLE reporting."reporting_settings"
ADD CONSTRAINT "reporting_settings_content_check" CHECK (
    "id" = 'daily-summary'
    AND "schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND char_length(btrim("timezone")) BETWEEN 1 AND 100
    AND (
        "destination_chat_id" IS NULL
        OR char_length(btrim("destination_chat_id")) BETWEEN 1 AND 255
    )
    AND ("message_thread_id" IS NULL OR "message_thread_id" > 0)
    AND (
        "operational_alerts_thread_id" IS NULL
        OR "operational_alerts_thread_id" > 0
    )
    AND (
        NOT "enabled"
        OR (
            "destination_chat_id" IS NOT NULL
            AND "message_thread_id" IS NOT NULL
            AND "operational_alerts_thread_id" IS NOT NULL
            AND "message_thread_id" <> "operational_alerts_thread_id"
        )
    )
);

DROP TABLE reporting."backfill_runs";
DROP TYPE reporting."ReportingBackfillStatus";
DROP TYPE reporting."ReportingOwner";
