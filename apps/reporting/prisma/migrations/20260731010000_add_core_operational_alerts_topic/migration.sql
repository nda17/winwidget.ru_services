ALTER TABLE reporting."reporting_settings"
ADD COLUMN "core_operational_alerts_destination_chat_id" TEXT,
ADD COLUMN "core_operational_alerts_thread_id" INTEGER,
ADD COLUMN "core_operational_routing_source_aggregate_version" DECIMAL(65, 0),
ADD COLUMN "core_operational_routing_source_sequence" DECIMAL(65, 0),
ADD COLUMN "core_operational_routing_state_hash" CHAR(64);

ALTER TABLE reporting."reporting_settings"
ADD CONSTRAINT "reporting_settings_core_operational_alerts_thread_id_check"
CHECK (
    (
        "core_operational_alerts_destination_chat_id" IS NULL
        OR char_length(btrim("core_operational_alerts_destination_chat_id")) BETWEEN 1 AND 255
    )
    AND (
        "core_operational_alerts_thread_id" IS NULL
        OR "core_operational_alerts_thread_id" > 0
    )
    AND (
        "core_operational_routing_source_aggregate_version" IS NULL
        OR "core_operational_routing_source_aggregate_version" >= 0
    )
    AND (
        "core_operational_routing_source_sequence" IS NULL
        OR "core_operational_routing_source_sequence" >= 0
    )
    AND (
        "core_operational_routing_state_hash" IS NULL
        OR "core_operational_routing_state_hash" ~ '^[0-9a-f]{64}$'
    )
);
