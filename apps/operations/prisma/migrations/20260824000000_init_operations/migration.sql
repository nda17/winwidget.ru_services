-- Production provisioning may pre-create this schema with the migration role
-- as owner. The fallback keeps local validation databases self-contained.
DO $$
BEGIN
    IF to_regnamespace('operations') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "operations"';
    END IF;
END
$$;

CREATE TYPE "operations"."AuditReceiptStatus" AS ENUM (
    'PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED'
);
CREATE TYPE "operations"."OutboxStatus" AS ENUM (
    'PENDING', 'PROCESSING', 'PUBLISHED'
);

CREATE TABLE "operations"."notes" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations"."admin_event_logs" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT,
    "admin_name" TEXT,
    "admin_email" TEXT,
    "section" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "entity_label" TEXT,
    "target_user_id" TEXT,
    "target_user_name" TEXT,
    "target_user_email" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_event_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations"."audit_event_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "status" "operations"."AuditReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "retry_available_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "dead_lettered_at" TIMESTAMP(3),
    "dead_letter_source" TEXT,
    "dead_letter_payload" JSONB,
    "manual_retry_cycle" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_event_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_event_receipts_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "audit_event_receipts_manual_retry_cycle_check" CHECK ("manual_retry_cycle" >= 0),
    CONSTRAINT "audit_event_receipts_consumer_check" CHECK (
        char_length("consumer") BETWEEN 1 AND 120
    ),
    CONSTRAINT "audit_event_receipts_error_check" CHECK (
        "last_error" IS NULL OR char_length("last_error") <= 2000
    ),
    CONSTRAINT "audit_event_receipts_state_check" CHECK (
        (
            "status" = 'PROCESSING'
            AND "lease_token" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "retry_available_at" IS NULL
            AND "delivered_at" IS NULL
            AND "dead_lettered_at" IS NULL
            AND "dead_letter_source" IS NULL
            AND "dead_letter_payload" IS NULL
        ) OR (
            "status" = 'RETRY_SCHEDULED'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "retry_available_at" IS NOT NULL
            AND "delivered_at" IS NULL
            AND "dead_lettered_at" IS NULL
            AND "dead_letter_source" IS NULL
            AND "dead_letter_payload" IS NULL
        ) OR (
            "status" = 'DELIVERED'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "retry_available_at" IS NULL
            AND "delivered_at" IS NOT NULL
            AND "dead_lettered_at" IS NULL
            AND "dead_letter_source" IS NULL
            AND "dead_letter_payload" IS NULL
        ) OR (
            "status" = 'DEAD_LETTERED'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "retry_available_at" IS NULL
            AND "delivered_at" IS NULL
            AND "dead_lettered_at" IS NOT NULL
            AND "dead_letter_source" IN (
                'campaigns', 'reporting', 'widgets', 'billing',
                'identity', 'platform', 'support', 'core'
            )
            AND jsonb_typeof("dead_letter_payload") = 'object'
        )
    )
);

CREATE TABLE "operations"."outbox_events" (
    "id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "message_id" UUID,
    "deduplication_key" TEXT,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "correlation_id" UUID,
    "exchange" TEXT NOT NULL DEFAULT 'winwidget.events',
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "status" "operations"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_events_attempt_check" CHECK ("attempt" >= 0),
    CONSTRAINT "outbox_events_payload_object_check" CHECK (
        jsonb_typeof("payload") = 'object'
        AND jsonb_typeof("headers") = 'object'
    ),
    CONSTRAINT "outbox_events_state_check" CHECK (
        (
            "status" = 'PENDING'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "published_at" IS NULL
        ) OR (
            "status" = 'PROCESSING'
            AND "lease_token" IS NOT NULL
            AND "lease_expires_at" IS NOT NULL
            AND "published_at" IS NULL
        ) OR (
            "status" = 'PUBLISHED'
            AND "lease_token" IS NULL
            AND "lease_expires_at" IS NULL
            AND "published_at" IS NOT NULL
        )
    )
);

CREATE INDEX "admin_event_logs_admin_id_idx" ON "operations"."admin_event_logs"("admin_id");
CREATE INDEX "admin_event_logs_target_user_id_idx" ON "operations"."admin_event_logs"("target_user_id");
CREATE INDEX "admin_event_logs_section_idx" ON "operations"."admin_event_logs"("section");
CREATE INDEX "admin_event_logs_action_idx" ON "operations"."admin_event_logs"("action");
CREATE INDEX "admin_event_logs_entity_type_entity_id_idx" ON "operations"."admin_event_logs"("entity_type", "entity_id");
CREATE INDEX "admin_event_logs_created_at_idx" ON "operations"."admin_event_logs"("created_at");

CREATE UNIQUE INDEX "audit_event_receipts_event_consumer_key" ON "operations"."audit_event_receipts"("event_id", "consumer");
CREATE INDEX "audit_event_receipts_claim_idx" ON "operations"."audit_event_receipts"("status", "lease_expires_at");
CREATE INDEX "audit_event_receipts_retry_idx" ON "operations"."audit_event_receipts"("status", "retry_available_at");
CREATE INDEX "audit_event_receipts_delivered_idx" ON "operations"."audit_event_receipts"("delivered_at");

CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "operations"."outbox_events"("event_id");
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "operations"."outbox_events"("deduplication_key");
CREATE INDEX "outbox_events_dispatch_idx" ON "operations"."outbox_events"("status", "available_at", "created_at");
CREATE INDEX "outbox_events_retention_idx" ON "operations"."outbox_events"("status", "published_at", "id");
