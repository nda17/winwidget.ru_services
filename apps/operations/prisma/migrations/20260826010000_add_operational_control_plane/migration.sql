CREATE TYPE "operations"."ScheduledJobRunStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED');
CREATE TYPE "operations"."ScheduledJobRunTrigger" AS ENUM ('SCHEDULED', 'MANUAL');
CREATE TYPE "operations"."IntegrationDeliveryReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY');
CREATE TYPE "operations"."IntegrationErrorCategory" AS ENUM ('TRANSIENT', 'RATE_LIMIT', 'PERMANENT', 'AUTH_CONFIGURATION');
CREATE TYPE "operations"."IntegrationFailureResolution" AS ENUM ('DELIVERED', 'CLOSED_NO_RETRY');
CREATE TYPE "operations"."OperationalAlertSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "operations"."DatabaseRestoreJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "operations"."telegram_bot_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "daily_summary_chat_id" TEXT NOT NULL DEFAULT '',
    "database_backup_thread_id" INTEGER,
    "payments_thread_id" INTEGER,
    "operational_alerts_thread_id" INTEGER,
    "database_backup_enabled" BOOLEAN NOT NULL DEFAULT true,
    "database_backup_time" TEXT NOT NULL DEFAULT '01:45',
    "database_backup_last_sent_period_start" TIMESTAMP(3),
    "database_backup_last_sent_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "telegram_bot_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "telegram_bot_settings_singleton" CHECK ("id" = 'singleton'),
    CONSTRAINT "telegram_bot_settings_time" CHECK ("database_backup_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

CREATE TABLE "operations"."scheduled_job_runs" (
    "id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "schedule_key" TEXT NOT NULL,
    "trigger" "operations"."ScheduledJobRunTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "status" "operations"."ScheduledJobRunStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "input" JSONB NOT NULL DEFAULT '{}',
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_job_runs_attempts" CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 100)
);

CREATE TABLE "operations"."scheduled_job_idempotency_keys" (
    "admin_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scheduled_job_idempotency_keys_pkey" PRIMARY KEY ("admin_id", "job_type", "idempotency_key")
);

CREATE TABLE "operations"."messaging_heartbeats" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messaging_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations"."integration_delivery_failures" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "integration" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "last_error" TEXT NOT NULL,
    "category" "operations"."IntegrationErrorCategory",
    "normalized_code" TEXT,
    "safe_reason" TEXT,
    "http_status" INTEGER,
    "provider_code" TEXT,
    "retryable" BOOLEAN,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrying_at" TIMESTAMP(3),
    "active_retry_token" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution" "operations"."IntegrationFailureResolution",
    "resolution_comment" TEXT,
    "resolved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "integration_delivery_failures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_delivery_failures_attempts" CHECK ("attempts" >= 1)
);

CREATE TABLE "operations"."integration_delivery_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "integration" TEXT NOT NULL,
    "status" "operations"."IntegrationDeliveryReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "retry_attempt" INTEGER,
    "retry_available_at" TIMESTAMP(3),
    "retry_token" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "integration_delivery_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations"."operational_alerts" (
    "id" UUID NOT NULL,
    "deduplication_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "operations"."OperationalAlertSeverity" NOT NULL,
    "source" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "target_user_id" TEXT,
    "target_user_name" TEXT,
    "target_user_email" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "alert_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operational_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operations"."reporting_schedule_policy" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "reservation_time" TEXT NOT NULL DEFAULT '01:50',
    "reservation_generation" BIGINT NOT NULL DEFAULT 0,
    "confirmed_change_id" UUID,
    "pending_change_id" UUID,
    "pending_time" TEXT,
    "pending_generation" BIGINT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reporting_schedule_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporting_schedule_policy_singleton" CHECK ("id" = 'singleton'),
    CONSTRAINT "reporting_schedule_policy_time" CHECK ("reservation_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ("pending_time" IS NULL OR "pending_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')),
    CONSTRAINT "reporting_schedule_policy_pending_pair" CHECK (("pending_change_id" IS NULL) = ("pending_time" IS NULL) AND ("pending_time" IS NULL) = ("pending_generation" IS NULL))
);

CREATE TABLE "operations"."database_restore_jobs" (
    "id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "status" "operations"."DatabaseRestoreJobStatus" NOT NULL DEFAULT 'QUEUED',
    "source_file_name" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "source_size" BIGINT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "result" JSONB,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "database_restore_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_jobs_sha256" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_jobs_size" CHECK ("source_size" > 0)
);

CREATE TABLE "operations"."operations_control_plane_bootstrap_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "source_revision" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operations_control_plane_bootstrap_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operations_control_plane_bootstrap_state_singleton" CHECK ("id" = 'singleton'),
    CONSTRAINT "operations_control_plane_bootstrap_state_revision" CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "operations_control_plane_bootstrap_state_sha" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "scheduled_job_runs_type_schedule_key_unique" ON "operations"."scheduled_job_runs"("job_type", "schedule_key");
CREATE INDEX "scheduled_job_runs_dispatch_idx" ON "operations"."scheduled_job_runs"("status", "available_at", "created_at");
CREATE INDEX "scheduled_job_runs_lease_idx" ON "operations"."scheduled_job_runs"("status", "lease_expires_at");
CREATE INDEX "scheduled_job_runs_type_created_idx" ON "operations"."scheduled_job_runs"("job_type", "created_at");
CREATE INDEX "scheduled_job_idempotency_keys_job_idx" ON "operations"."scheduled_job_idempotency_keys"("job_id");
CREATE UNIQUE INDEX "messaging_heartbeats_service_instance_unique" ON "operations"."messaging_heartbeats"("service", "instance_id");
CREATE INDEX "messaging_heartbeats_service_seen_idx" ON "operations"."messaging_heartbeats"("service", "last_seen_at");
CREATE INDEX "messaging_heartbeats_seen_idx" ON "operations"."messaging_heartbeats"("last_seen_at");
CREATE UNIQUE INDEX "integration_delivery_failures_event_integration_unique" ON "operations"."integration_delivery_failures"("event_id", "integration");
CREATE INDEX "integration_delivery_failures_status_idx" ON "operations"."integration_delivery_failures"("resolved_at", "failed_at");
CREATE INDEX "integration_delivery_failures_integration_idx" ON "operations"."integration_delivery_failures"("integration", "resolved_at");
CREATE INDEX "integration_delivery_failures_category_idx" ON "operations"."integration_delivery_failures"("category", "resolved_at", "failed_at");
CREATE UNIQUE INDEX "integration_delivery_receipts_event_integration_unique" ON "operations"."integration_delivery_receipts"("event_id", "integration");
CREATE INDEX "integration_delivery_receipts_processing_idx" ON "operations"."integration_delivery_receipts"("status", "locked_at");
CREATE INDEX "integration_delivery_receipts_integration_delivered_idx" ON "operations"."integration_delivery_receipts"("integration", "delivered_at");
CREATE UNIQUE INDEX "operational_alerts_deduplication_key_key" ON "operations"."operational_alerts"("deduplication_key");
CREATE INDEX "operational_alerts_active_idx" ON "operations"."operational_alerts"("resolved_at", "severity", "alert_at");
CREATE INDEX "operational_alerts_source_idx" ON "operations"."operational_alerts"("source", "resolved_at");
CREATE UNIQUE INDEX "database_restore_jobs_actor_idempotency_key" ON "operations"."database_restore_jobs"("requested_by_id", "idempotency_key");
CREATE INDEX "database_restore_jobs_dispatch_idx" ON "operations"."database_restore_jobs"("status", "created_at");
CREATE UNIQUE INDEX "operations_control_plane_bootstrap_state_source_sha256_key" ON "operations"."operations_control_plane_bootstrap_state"("source_sha256");

ALTER TABLE "operations"."scheduled_job_idempotency_keys"
  ADD CONSTRAINT "scheduled_job_idempotency_keys_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "operations"."scheduled_job_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "operations"."telegram_bot_settings" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "operations"."reporting_schedule_policy" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
