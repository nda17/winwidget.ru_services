-- The production lifecycle pre-creates the schema with the migration role as
-- owner. Keep an owner path for isolated development databases.
DO $$
BEGIN
    IF to_regnamespace('support') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "support"';
    END IF;
END
$$;

CREATE TYPE "support"."ServiceDatabasePhase" AS ENUM ('SHADOW', 'ACTIVE');
CREATE TYPE "support"."SupportInboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY', 'IGNORED');
CREATE TYPE "support"."SupportInboxOutcome" AS ENUM ('USER_MESSAGE_FORWARDED', 'START_REPLIED', 'ADMIN_REPLY_DELIVERED', 'USER_MESSAGE_REJECTED', 'IGNORED_BOT', 'IGNORED_CHAT', 'IGNORED_UNMAPPED_REPLY');
CREATE TYPE "support"."SupportMappingKind" AS ENUM ('USER_COPY', 'USER_CONTEXT');
CREATE TYPE "support"."TelegramOutboundMethod" AS ENUM ('SEND_MESSAGE', 'COPY_MESSAGE');
CREATE TYPE "support"."TelegramOutboundDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED');
CREATE TYPE "support"."OutboxExchange" AS ENUM ('EVENTS', 'AUDIT', 'RETRY', 'MANUAL_RETRY', 'DEAD_LETTER');
CREATE TYPE "support"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED');
CREATE TYPE "support"."ConsumerReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY');
CREATE TYPE "support"."ConsumerFailureStatus" AS ENUM ('OPEN', 'RETRYING', 'RESOLVED', 'CLOSED_NO_RETRY');

CREATE TABLE "support"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'support-service',
    "database_id" UUID NOT NULL,
    "phase" "support"."ServiceDatabasePhase" NOT NULL DEFAULT 'SHADOW',
    "ownership_generation" BIGINT NOT NULL DEFAULT 0,
    "source_database_system_id" TEXT,
    "source_revision" CHAR(40),
    "ownership_revision" CHAR(40),
    "source_fingerprint" CHAR(64),
    "source_snapshot_sha256" CHAR(64),
    "source_snapshot_counts" JSONB,
    "source_high_watermark" BIGINT,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_identity_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "service_identity_name_check" CHECK ("service_name" = 'support-service'),
    CONSTRAINT "service_identity_generation_check" CHECK ("ownership_generation" >= 0),
    CONSTRAINT "service_identity_source_check" CHECK (
        (
            "phase" = 'SHADOW'
            AND "ownership_generation" = 0
            AND "activated_at" IS NULL
        )
        OR (
            "phase" = 'ACTIVE'
            AND "ownership_generation" >= 1
            AND "source_database_system_id" IS NOT NULL
            AND "source_database_system_id" ~ '^[1-9][0-9]{0,31}$'
            AND "source_revision" IS NOT NULL
            AND "source_revision" ~ '^[0-9a-f]{40}$'
            AND "ownership_revision" IS NOT NULL
            AND "ownership_revision" = "source_revision"
            AND "source_fingerprint" IS NOT NULL
            AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
            AND "source_snapshot_counts" IS NOT NULL
            AND jsonb_typeof("source_snapshot_counts") = 'object'
            AND "source_high_watermark" IS NOT NULL
            AND "source_high_watermark" > 0
            AND "imported_at" IS NOT NULL
            AND "activated_at" IS NOT NULL
            AND "activated_at" >= "imported_at"
        )
    )
);

CREATE TABLE "support"."routing_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "admin_chat_id" TEXT NOT NULL DEFAULT '',
    "support_thread_id" INTEGER,
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "routing_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "routing_settings_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "routing_settings_chat_check" CHECK (
        "admin_chat_id" = ''
        OR "admin_chat_id" ~ '^-?[1-9][0-9]*$'
        OR "admin_chat_id" ~ '^@[A-Za-z][A-Za-z0-9_]{4,31}$'
    ),
    CONSTRAINT "routing_settings_thread_check" CHECK ("support_thread_id" IS NULL OR "support_thread_id" > 0),
    CONSTRAINT "routing_settings_pair_check" CHECK (
        ("admin_chat_id" = '' AND "support_thread_id" IS NULL)
        OR ("admin_chat_id" <> '' AND "support_thread_id" > 0)
    ),
    CONSTRAINT "routing_settings_version_check" CHECK ("aggregate_version" >= 0)
);

CREATE TABLE "support"."telegram_webhook_inbox" (
    "id" UUID NOT NULL,
    "update_id" BIGINT NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "raw_payload" BYTEA NOT NULL,
    "status" "support"."SupportInboxStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "support"."SupportInboxOutcome",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telegram_webhook_inbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_webhook_inbox_update_check" CHECK ("update_id" >= 0),
    CONSTRAINT "telegram_webhook_inbox_hash_check" CHECK ("body_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "telegram_webhook_inbox_payload_check" CHECK (octet_length("raw_payload") BETWEEN 1 AND 524288),
    CONSTRAINT "telegram_webhook_inbox_attempt_check" CHECK ("attempts" >= 0),
    CONSTRAINT "telegram_webhook_inbox_lease_check" CHECK (
        ("status" = 'PROCESSING' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
        OR ("status" <> 'PROCESSING' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    ),
    CONSTRAINT "telegram_webhook_inbox_outcome_check" CHECK (
        ("status" IN ('DELIVERED', 'IGNORED') AND "outcome" IS NOT NULL AND "processed_at" IS NOT NULL)
        OR ("status" = 'CLOSED_NO_RETRY' AND "processed_at" IS NOT NULL)
        OR ("status" NOT IN ('DELIVERED', 'IGNORED', 'CLOSED_NO_RETRY') AND "outcome" IS NULL AND "processed_at" IS NULL)
    )
);

CREATE TABLE "support"."support_message_mappings" (
    "id" UUID NOT NULL,
    "inbox_id" UUID,
    "legacy_source_id" TEXT,
    "kind" "support"."SupportMappingKind" NOT NULL,
    "admin_chat_id" TEXT NOT NULL,
    "admin_message_id" INTEGER NOT NULL,
    "user_chat_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_message_mappings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_message_mappings_message_check" CHECK ("admin_message_id" > 0),
    CONSTRAINT "support_message_mappings_chat_check" CHECK ("admin_chat_id" <> '' AND "user_chat_id" <> ''),
    CONSTRAINT "support_message_mappings_source_check" CHECK (
        ("inbox_id" IS NOT NULL AND "legacy_source_id" IS NULL)
        OR ("inbox_id" IS NULL AND "legacy_source_id" IS NOT NULL)
    )
);

CREATE TABLE "support"."telegram_outbound_deliveries" (
    "id" UUID NOT NULL,
    "inbox_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "method" "support"."TelegramOutboundMethod" NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "request" JSONB NOT NULL,
    "status" "support"."TelegramOutboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "response_message_id" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telegram_outbound_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_outbound_deliveries_key_check" CHECK (char_length("idempotency_key") BETWEEN 1 AND 255),
    CONSTRAINT "telegram_outbound_deliveries_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "telegram_outbound_deliveries_attempt_check" CHECK ("attempts" >= 0),
    CONSTRAINT "telegram_outbound_deliveries_request_check" CHECK (jsonb_typeof("request") = 'object'),
    CONSTRAINT "telegram_outbound_deliveries_state_check" CHECK (
        (
            "status" = 'PENDING'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "response_message_id" IS NULL
            AND "delivered_at" IS NULL
        )
        OR (
            "status" = 'PROCESSING'
            AND "lease_token" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "response_message_id" IS NULL
            AND "delivered_at" IS NULL
        )
        OR (
            "status" = 'DELIVERED'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "response_message_id" > 0
            AND "delivered_at" IS NOT NULL
        )
    )
);

CREATE TABLE "support"."outbox_events" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "deduplication_key" TEXT,
    "exchange" "support"."OutboxExchange" NOT NULL DEFAULT 'EVENTS',
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "aggregate_type" TEXT,
    "aggregate_id" TEXT,
    "aggregate_version" BIGINT,
    "status" "support"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_attempt_check" CHECK ("attempts" >= 0),
    CONSTRAINT "outbox_events_lease_check" CHECK (
        (
            "status" = 'PROCESSING'
            AND "locked_at" IS NOT NULL
            AND "locked_by" IS NOT NULL
            AND "lease_token" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "published_at" IS NULL
        )
        OR (
            "status" = 'PENDING'
            AND "locked_at" IS NULL
            AND "locked_by" IS NULL
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "published_at" IS NULL
        )
        OR (
            "status" = 'PUBLISHED'
            AND "locked_at" IS NULL
            AND "locked_by" IS NULL
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "published_at" IS NOT NULL
        )
    ),
    CONSTRAINT "outbox_events_aggregate_check" CHECK (
        ("aggregate_type" IS NULL AND "aggregate_id" IS NULL AND "aggregate_version" IS NULL)
        OR ("aggregate_type" IS NOT NULL AND "aggregate_id" IS NOT NULL)
    )
);

CREATE TABLE "support"."consumer_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "support"."ConsumerReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "lock_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "retry_attempt" INTEGER,
    "manual_retry_cycle" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consumer_receipts_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "consumer_receipts_attempt_check" CHECK (
        ("retry_attempt" IS NULL OR "retry_attempt" >= 0) AND "manual_retry_cycle" >= 0
    ),
    CONSTRAINT "consumer_receipts_lease_check" CHECK (
        (
            "status" = 'PROCESSING'
            AND "locked_at" IS NOT NULL
            AND "locked_by" IS NOT NULL
            AND "lock_token" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "delivered_at" IS NULL
        )
        OR (
            "status" = 'RETRY_SCHEDULED'
            AND "locked_at" IS NULL
            AND "locked_by" IS NULL
            AND "lock_token" IS NOT NULL
            AND "lease_expires_at" IS NULL
            AND "delivered_at" IS NULL
        )
        OR (
            "status" IN ('DEAD_LETTERED', 'CLOSED_NO_RETRY')
            AND "locked_at" IS NULL
            AND "locked_by" IS NULL
            AND "lock_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "delivered_at" IS NULL
        )
        OR (
            "status" = 'DELIVERED'
            AND "locked_at" IS NULL
            AND "locked_by" IS NULL
            AND "lock_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "delivered_at" IS NOT NULL
        )
    )
);

CREATE TABLE "support"."consumer_failures" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "payload_hash" CHAR(64) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "status" "support"."ConsumerFailureStatus" NOT NULL DEFAULT 'OPEN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "manual_retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL,
    "last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_requested_at" TIMESTAMP(3),
    "retry_requested_by_id" TEXT,
    "retry_token" UUID,
    "retry_lease_expires_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolution_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "consumer_failures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consumer_failures_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "consumer_failures_attempt_check" CHECK ("attempts" >= 0 AND "manual_retry_count" >= 0),
    CONSTRAINT "consumer_failures_state_check" CHECK (
        (
            "status" = 'OPEN'
            AND "retry_token" IS NULL
            AND "retry_lease_expires_at" IS NULL
            AND "resolved_at" IS NULL
        )
        OR (
            "status" = 'RETRYING'
            AND "retry_requested_at" IS NOT NULL
            AND "retry_requested_by_id" IS NOT NULL
            AND "retry_token" IS NOT NULL
            AND "retry_lease_expires_at" IS NOT NULL
            AND "resolved_at" IS NULL
        )
        OR (
            "status" IN ('RESOLVED', 'CLOSED_NO_RETRY')
            AND "retry_token" IS NULL
            AND "retry_lease_expires_at" IS NULL
            AND "resolved_at" IS NOT NULL
        )
    )
);

CREATE TABLE "support"."messaging_heartbeats" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messaging_heartbeats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messaging_heartbeats_service_check" CHECK ("service" IN ('support-api', 'support-worker', 'support-outbox-publisher')),
    CONSTRAINT "messaging_heartbeats_instance_check" CHECK (char_length("instance_id") BETWEEN 1 AND 255),
    CONSTRAINT "messaging_heartbeats_revision_check" CHECK (char_length("revision") BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX "telegram_webhook_inbox_update_id_key" ON "support"."telegram_webhook_inbox"("update_id");
CREATE INDEX "telegram_webhook_inbox_status_lease_expires_at_created_at_idx" ON "support"."telegram_webhook_inbox"("status", "lease_expires_at", "created_at");
CREATE INDEX "support_message_mappings_user_chat_id_created_at_idx" ON "support"."support_message_mappings"("user_chat_id", "created_at");
CREATE INDEX "support_message_mappings_inbox_id_idx" ON "support"."support_message_mappings"("inbox_id");
CREATE UNIQUE INDEX "support_message_mappings_admin_chat_id_admin_message_id_key" ON "support"."support_message_mappings"("admin_chat_id", "admin_message_id");
CREATE UNIQUE INDEX "support_message_mappings_legacy_source_id_key" ON "support"."support_message_mappings"("legacy_source_id");
CREATE UNIQUE INDEX "telegram_outbound_deliveries_idempotency_key_key" ON "support"."telegram_outbound_deliveries"("idempotency_key");
CREATE INDEX "telegram_outbound_deliveries_inbox_id_created_at_idx" ON "support"."telegram_outbound_deliveries"("inbox_id", "created_at");
CREATE INDEX "telegram_outbound_deliveries_status_lease_expires_at_idx" ON "support"."telegram_outbound_deliveries"("status", "lease_expires_at");
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "support"."outbox_events"("deduplication_key");
CREATE INDEX "outbox_events_status_available_at_created_at_idx" ON "support"."outbox_events"("status", "available_at", "created_at");
CREATE INDEX "outbox_events_status_lease_expires_at_idx" ON "support"."outbox_events"("status", "lease_expires_at");
CREATE INDEX "outbox_events_published_at_idx" ON "support"."outbox_events"("published_at");
CREATE INDEX "consumer_receipts_status_lease_expires_at_idx" ON "support"."consumer_receipts"("status", "lease_expires_at");
CREATE UNIQUE INDEX "consumer_receipts_event_id_consumer_key" ON "support"."consumer_receipts"("event_id", "consumer");
CREATE INDEX "consumer_failures_status_last_failed_at_idx" ON "support"."consumer_failures"("status", "last_failed_at");
CREATE INDEX "consumer_failures_status_retry_lease_expires_at_idx" ON "support"."consumer_failures"("status", "retry_lease_expires_at");
CREATE UNIQUE INDEX "consumer_failures_event_id_consumer_key" ON "support"."consumer_failures"("event_id", "consumer");
CREATE UNIQUE INDEX "messaging_heartbeats_service_instance_id_key" ON "support"."messaging_heartbeats"("service", "instance_id");
CREATE INDEX "messaging_heartbeats_service_last_seen_at_idx" ON "support"."messaging_heartbeats"("service", "last_seen_at");

ALTER TABLE "support"."support_message_mappings"
ADD CONSTRAINT "support_message_mappings_inbox_id_fkey"
FOREIGN KEY ("inbox_id") REFERENCES "support"."telegram_webhook_inbox"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support"."telegram_outbound_deliveries"
ADD CONSTRAINT "telegram_outbound_deliveries_inbox_id_fkey"
FOREIGN KEY ("inbox_id") REFERENCES "support"."telegram_webhook_inbox"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "support"."service_identity" (
    "id", "service_name", "database_id", "updated_at"
)
VALUES ('singleton', 'support-service', gen_random_uuid(), CURRENT_TIMESTAMP);

INSERT INTO "support"."routing_settings" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP);
