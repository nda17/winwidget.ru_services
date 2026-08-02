-- The reporting schema is provisioned by the database bootstrap role before
-- Prisma migrations run. Keeping CREATE SCHEMA out of this migration lets the
-- migration credential remain least-privileged and schema-scoped.

CREATE TYPE "reporting"."ProjectionReceiptResult" AS ENUM ('APPLIED', 'DUPLICATE', 'STALE');
CREATE TYPE "reporting"."ReportingConsumerReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED');
CREATE TYPE "reporting"."ReportingOwner" AS ENUM ('CORE_SHADOW', 'REPORTING');
CREATE TYPE "reporting"."ReportRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'WAITING_DELIVERY', 'COMPLETED', 'FAILED');
CREATE TYPE "reporting"."ReportingOutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'QUARANTINED');
CREATE TYPE "reporting"."ReportingOutboxExchange" AS ENUM ('EVENTS', 'RETRY', 'MANUAL_RETRY', 'DEAD_LETTER');
CREATE TYPE "reporting"."ReportingBackfillStatus" AS ENUM ('RUNNING', 'VERIFIED', 'FAILED');
CREATE TYPE "reporting"."ReportingConsumerFailureStatus" AS ENUM ('OPEN', 'RETRY_REQUESTED', 'RESOLVED');

CREATE TABLE "reporting"."identity_user_projections" (
	"id" TEXT NOT NULL,
	"created_at" TIMESTAMP(3),
	"source_updated_at" TIMESTAMP(3),
	"deleted_at" TIMESTAMP(3),
	"status" TEXT,
	"roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
	"has_email_identity" BOOLEAN,
	"has_phone_identity" BOOLEAN,
	"has_telegram_identity" BOOLEAN,
	"login_method_count" INTEGER,
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"state_hash" CHAR(64) NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "identity_user_projections_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "identity_users_version_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0 AND "state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "identity_users_state_check" CHECK (
		"tombstoned"
		OR (
			"created_at" IS NOT NULL
			AND "source_updated_at" IS NOT NULL
			AND "status" IN ('ACTIVE', 'DEACTIVATED')
			AND "roles" <@ ARRAY['USER', 'ADMIN', 'DEV']::TEXT[]
			AND "has_email_identity" IS NOT NULL
			AND "has_phone_identity" IS NOT NULL
			AND "has_telegram_identity" IS NOT NULL
			AND "login_method_count" >= 0
		)
	)
);

CREATE TABLE "reporting"."billing_payment_facts" (
	"id" TEXT NOT NULL,
	"user_id" TEXT,
	"amount" TEXT,
	"normalized_amount" DOUBLE PRECISION,
	"status" TEXT,
	"source_created_at" TIMESTAMP(3),
	"source_updated_at" TIMESTAMP(3),
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"state_hash" CHAR(64) NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "billing_payment_facts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "payment_facts_version_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0 AND "state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_facts_state_check" CHECK (
		"tombstoned"
		OR (
			char_length(btrim("user_id")) BETWEEN 1 AND 255
			AND char_length(btrim("amount")) BETWEEN 1 AND 128
			AND "amount" !~ '[[:cntrl:]]'
			AND ("normalized_amount" IS NULL OR "normalized_amount"::TEXT NOT IN ('NaN', 'Infinity', '-Infinity'))
			AND "status" IN ('PENDING', 'SUCCEEDED', 'CANCELLED', 'EXPIRED')
			AND "source_created_at" IS NOT NULL
			AND "source_updated_at" IS NOT NULL
		)
	)
);

CREATE TABLE "reporting"."billing_subscription_projections" (
	"id" TEXT NOT NULL,
	"user_id" TEXT,
	"plan" TEXT,
	"status" TEXT,
	"expires_at" TIMESTAMP(3),
	"source_created_at" TIMESTAMP(3),
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"state_hash" CHAR(64) NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "billing_subscription_projections_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "subscriptions_version_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0 AND "state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "subscriptions_state_check" CHECK (
		"tombstoned"
		OR (
			char_length(btrim("user_id")) BETWEEN 1 AND 255
			AND "plan" IN ('TRIAL', 'EASY', 'HARD')
			AND "status" IN ('ACTIVE', 'EXPIRED', 'CANCELLED')
			AND "source_created_at" IS NOT NULL
		)
	)
);

CREATE TABLE "reporting"."widget_projections" (
	"widget_type" TEXT NOT NULL,
	"id" TEXT NOT NULL,
	"source_aggregate_id" TEXT NOT NULL,
	"user_id" TEXT,
	"is_active" BOOLEAN,
	"has_install_domain" BOOLEAN,
	"source_created_at" TIMESTAMP(3),
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"state_hash" CHAR(64) NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "widget_projections_pkey" PRIMARY KEY ("widget_type", "id"),
	CONSTRAINT "widgets_version_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0 AND "state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "widgets_identity_check" CHECK (char_length(btrim("source_aggregate_id")) BETWEEN 1 AND 255),
	CONSTRAINT "widgets_state_check" CHECK (
		("tombstoned" AND "widget_type" IN ('wheel', 'quiz', 'callback', 'countdownTimer', 'stopOffer', 'onlineConsultant', 'calculator'))
		OR (
			NOT "tombstoned"
			AND "widget_type" IN ('wheel', 'quiz', 'callback', 'countdownTimer', 'stopOffer', 'onlineConsultant', 'calculator')
			AND char_length(btrim("user_id")) BETWEEN 1 AND 255
			AND "is_active" IS NOT NULL
			AND "has_install_domain" IS NOT NULL
			AND "source_created_at" IS NOT NULL
		)
	)
);

CREATE TABLE "reporting"."lead_facts" (
	"widget_type" TEXT NOT NULL,
	"id" TEXT NOT NULL,
	"source_aggregate_id" TEXT NOT NULL,
	"widget_id" TEXT,
	"source_created_at" TIMESTAMP(3),
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"state_hash" CHAR(64) NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "lead_facts_pkey" PRIMARY KEY ("widget_type", "id"),
	CONSTRAINT "lead_facts_version_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0 AND "state_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "lead_facts_identity_check" CHECK (char_length(btrim("source_aggregate_id")) BETWEEN 1 AND 255),
	CONSTRAINT "lead_facts_state_check" CHECK (
		("tombstoned" AND "widget_type" IN ('wheel', 'quiz', 'callback', 'countdownTimer', 'stopOffer', 'onlineConsultant', 'calculator'))
		OR (
			NOT "tombstoned"
			AND "widget_type" IN ('wheel', 'quiz', 'callback', 'countdownTimer', 'stopOffer', 'onlineConsultant', 'calculator')
			AND char_length(btrim("widget_id")) BETWEEN 1 AND 255
			AND "source_created_at" IS NOT NULL
		)
	)
);

CREATE TABLE "reporting"."projection_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"projection" TEXT NOT NULL,
	"event_type" TEXT NOT NULL,
	"aggregate_id" TEXT NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"tombstone" BOOLEAN NOT NULL,
	"state_hash" CHAR(64) NOT NULL,
	"result" "reporting"."ProjectionReceiptResult" NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "projection_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "projection_receipts_content_check" CHECK (
		char_length(btrim("projection")) BETWEEN 1 AND 100
		AND char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("aggregate_id")) BETWEEN 1 AND 255
			AND "aggregate_version" >= 0
			AND "source_sequence" >= 0
			AND "state_hash" ~ '^[0-9a-f]{64}$'
	)
);

CREATE TABLE "reporting"."projection_watermarks" (
	"stream" TEXT NOT NULL,
	"source_sequence" DECIMAL(65,0) NOT NULL,
	"event_id" UUID NOT NULL,
	"aggregate_version" DECIMAL(65,0) NOT NULL,
	"occurred_at" TIMESTAMP(3) NOT NULL,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "projection_watermarks_pkey" PRIMARY KEY ("stream"),
	CONSTRAINT "projection_watermarks_content_check" CHECK (
		char_length(btrim("stream")) BETWEEN 1 AND 100
		AND "source_sequence" >= 0
		AND "aggregate_version" >= 0
	)
);

CREATE TABLE "reporting"."consumer_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"payload_hash" CHAR(64) NOT NULL,
	"status" "reporting"."ReportingConsumerReceiptStatus" NOT NULL,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"retry_attempt" INTEGER,
	"retry_cycle" INTEGER NOT NULL DEFAULT 0,
	"delivered_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "consumer_receipts_identity_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
		AND ("retry_attempt" IS NULL OR "retry_attempt" BETWEEN 0 AND 3)
		AND "retry_cycle" BETWEEN 0 AND 1000000
	),
	CONSTRAINT "consumer_receipts_lease_check" CHECK (
		(
			"status" = 'PROCESSING'::"reporting"."ReportingConsumerReceiptStatus"
			AND "locked_at" IS NOT NULL
			AND "locked_by" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
			AND "retry_attempt" IS NULL
		)
		OR (
			"status" <> 'PROCESSING'::"reporting"."ReportingConsumerReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND (
				("status" = 'RETRY_SCHEDULED'::"reporting"."ReportingConsumerReceiptStatus" AND "retry_attempt" IS NOT NULL)
				OR ("status" <> 'RETRY_SCHEDULED'::"reporting"."ReportingConsumerReceiptStatus" AND "retry_attempt" IS NULL)
			)
		)
	)
);

CREATE TABLE "reporting"."consumer_failures" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"consumer_kind" TEXT NOT NULL,
	"event_type" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"payload_hash" CHAR(64) NOT NULL,
	"correlation_id" TEXT NOT NULL,
	"status" "reporting"."ReportingConsumerFailureStatus" NOT NULL DEFAULT 'OPEN',
	"manual_retry_count" INTEGER NOT NULL DEFAULT 0,
	"last_error" TEXT NOT NULL,
	"last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"retry_requested_at" TIMESTAMP(3),
	"resolved_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "consumer_failures_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "consumer_failures_content_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "consumer_kind" IN ('identityUser', 'billingPayment', 'billingSubscription', 'widget', 'lead', 'reportingSettings', 'deliveryOutcome')
		AND char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND jsonb_typeof("payload") = 'object'
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
		AND "correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'
		AND "manual_retry_count" BETWEEN 0 AND 1000000
		AND char_length("last_error") BETWEEN 1 AND 2000
	),
	CONSTRAINT "consumer_failures_state_check" CHECK (
		("status" = 'OPEN'::"reporting"."ReportingConsumerFailureStatus" AND "retry_requested_at" IS NULL AND "resolved_at" IS NULL)
		OR ("status" = 'RETRY_REQUESTED'::"reporting"."ReportingConsumerFailureStatus" AND "retry_requested_at" IS NOT NULL AND "resolved_at" IS NULL)
		OR ("status" = 'RESOLVED'::"reporting"."ReportingConsumerFailureStatus" AND "resolved_at" IS NOT NULL)
	)
);

CREATE TABLE "reporting"."reporting_settings" (
	"id" TEXT NOT NULL DEFAULT 'daily-summary',
	"owner" "reporting"."ReportingOwner" NOT NULL DEFAULT 'CORE_SHADOW',
	"enabled" BOOLEAN NOT NULL DEFAULT false,
	"destination_chat_id" TEXT,
	"message_thread_id" INTEGER,
	"schedule_time" TEXT NOT NULL DEFAULT '01:50',
	"timezone" TEXT NOT NULL DEFAULT 'Europe/Moscow',
	"source_aggregate_version" DECIMAL(65,0),
	"source_sequence" DECIMAL(65,0),
	"state_hash" CHAR(64),
	"last_successful_period_start" TIMESTAMP(3),
	"last_successful_at" TIMESTAMP(3),
	"last_failed_period_start" TIMESTAMP(3),
	"last_failed_at" TIMESTAMP(3),
	"last_failure_code" TEXT,
	"last_failure_reason" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "reporting_settings_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "reporting_settings_content_check" CHECK (
		"id" = 'daily-summary'
		AND "schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
		AND char_length(btrim("timezone")) BETWEEN 1 AND 100
		AND ("destination_chat_id" IS NULL OR char_length(btrim("destination_chat_id")) BETWEEN 1 AND 255)
		AND ("message_thread_id" IS NULL OR "message_thread_id" > 0)
		AND (NOT "enabled" OR ("destination_chat_id" IS NOT NULL AND "message_thread_id" IS NOT NULL))
		AND ("source_aggregate_version" IS NULL OR "source_aggregate_version" >= 0)
			AND ("source_sequence" IS NULL OR "source_sequence" >= 0)
			AND ("state_hash" IS NULL OR "state_hash" ~ '^[0-9a-f]{64}$')
	)
);

CREATE TABLE "reporting"."report_runs" (
	"id" UUID NOT NULL,
	"period_key" TEXT NOT NULL,
	"period_start" TIMESTAMP(3) NOT NULL,
	"period_end" TIMESTAMP(3) NOT NULL,
	"timezone" TEXT NOT NULL,
	"status" "reporting"."ReportRunStatus" NOT NULL DEFAULT 'PENDING',
	"checkpoint" TEXT NOT NULL DEFAULT 'CREATED',
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"destination_chat_id" TEXT NOT NULL,
	"message_thread_id" INTEGER NOT NULL,
	"message_text" TEXT,
	"message_sha256" CHAR(64),
	"request_event_id" UUID,
	"outcome_event_id" UUID,
	"failure_code" TEXT,
	"failure_reason" TEXT,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"completed_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "report_runs_content_check" CHECK (
		char_length(btrim("period_key")) BETWEEN 1 AND 200
		AND "period_start" < "period_end"
		AND char_length(btrim("timezone")) BETWEEN 1 AND 100
		AND char_length(btrim("checkpoint")) BETWEEN 1 AND 100
		AND "attempts" >= 0
		AND char_length(btrim("destination_chat_id")) BETWEEN 1 AND 255
		AND "message_thread_id" > 0
		AND (("message_text" IS NULL AND "message_sha256" IS NULL) OR (char_length("message_text") BETWEEN 1 AND 10000 AND "message_sha256" ~ '^[0-9a-f]{64}$'))
	),
	CONSTRAINT "report_runs_lease_check" CHECK (
		(
			"status" = 'PROCESSING'::"reporting"."ReportRunStatus"
			AND "locked_at" IS NOT NULL
			AND "locked_by" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
		)
		OR (
			"status" <> 'PROCESSING'::"reporting"."ReportRunStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
		)
	)
);

CREATE TABLE "reporting"."outbox_events" (
	"id" UUID NOT NULL,
	"message_id" UUID NOT NULL,
	"deduplication_key" TEXT,
	"exchange" "reporting"."ReportingOutboxExchange" NOT NULL DEFAULT 'EVENTS',
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"status" "reporting"."ReportingOutboxStatus" NOT NULL DEFAULT 'PENDING',
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"published_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "outbox_events_content_check" CHECK (
		char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND jsonb_typeof("headers") = 'object'
		AND "attempts" >= 0
	),
	CONSTRAINT "outbox_events_lease_check" CHECK (
		(
			"status" = 'PUBLISHING'::"reporting"."ReportingOutboxStatus"
			AND "locked_at" IS NOT NULL
			AND "locked_by" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
		)
		OR (
			"status" <> 'PUBLISHING'::"reporting"."ReportingOutboxStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
		)
	)
);

CREATE TABLE "reporting"."heartbeats" (
	"id" UUID NOT NULL,
	"role" TEXT NOT NULL,
	"instance_id" TEXT NOT NULL,
	"metadata" JSONB NOT NULL DEFAULT '{}',
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "heartbeats_identity_check" CHECK (
		"role" IN ('all', 'api', 'worker', 'publisher', 'scheduler', 'backfill')
		AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
		AND jsonb_typeof("metadata") = 'object'
	)
);

CREATE TABLE "reporting"."backfill_runs" (
	"id" UUID NOT NULL,
	"snapshot_id" UUID NOT NULL,
	"status" "reporting"."ReportingBackfillStatus" NOT NULL DEFAULT 'RUNNING',
	"watermarks" JSONB NOT NULL,
	"counts" JSONB NOT NULL DEFAULT '{}',
	"record_count" INTEGER NOT NULL DEFAULT 0,
	"applied_count" INTEGER NOT NULL DEFAULT 0,
	"duplicate_count" INTEGER NOT NULL DEFAULT 0,
	"stale_count" INTEGER NOT NULL DEFAULT 0,
	"sha256" CHAR(64),
	"expected_sha256" CHAR(64),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"last_error" TEXT,
	"started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"verified_at" TIMESTAMP(3),
	"failed_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "backfill_runs_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "backfill_runs_progress_check" CHECK (
		"record_count" >= 0
		AND "applied_count" >= 0
		AND "duplicate_count" >= 0
		AND "stale_count" >= 0
		AND jsonb_typeof("watermarks") = 'object'
		AND jsonb_typeof("counts") = 'object'
	),
	CONSTRAINT "backfill_runs_state_check" CHECK (
		(
			"status" = 'RUNNING'::"reporting"."ReportingBackfillStatus"
			AND "locked_by" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" IS NOT NULL
			AND "verified_at" IS NULL
			AND "failed_at" IS NULL
		)
		OR (
			"status" = 'VERIFIED'::"reporting"."ReportingBackfillStatus"
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "sha256" IS NOT NULL
			AND "expected_sha256" = "sha256"
			AND "verified_at" IS NOT NULL
			AND "failed_at" IS NULL
		)
		OR (
			"status" = 'FAILED'::"reporting"."ReportingBackfillStatus"
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "verified_at" IS NULL
			AND "failed_at" IS NOT NULL
		)
	)
);

CREATE INDEX "identity_users_reporting_idx" ON "reporting"."identity_user_projections"("tombstoned", "deleted_at", "created_at");
CREATE INDEX "identity_users_active_idx" ON "reporting"."identity_user_projections"("tombstoned", "source_updated_at");
CREATE INDEX "payment_facts_status_updated_idx" ON "reporting"."billing_payment_facts"("tombstoned", "status", "source_updated_at");
CREATE INDEX "payment_facts_user_updated_idx" ON "reporting"."billing_payment_facts"("tombstoned", "user_id", "source_updated_at");
CREATE INDEX "subscriptions_status_expiry_idx" ON "reporting"."billing_subscription_projections"("tombstoned", "status", "expires_at");
CREATE INDEX "subscriptions_user_idx" ON "reporting"."billing_subscription_projections"("tombstoned", "user_id");
CREATE UNIQUE INDEX "widgets_source_aggregate_unique" ON "reporting"."widget_projections"("source_aggregate_id");
CREATE INDEX "widgets_type_active_idx" ON "reporting"."widget_projections"("tombstoned", "widget_type", "is_active");
CREATE INDEX "widgets_created_idx" ON "reporting"."widget_projections"("tombstoned", "source_created_at");
CREATE UNIQUE INDEX "leads_source_aggregate_unique" ON "reporting"."lead_facts"("source_aggregate_id");
CREATE INDEX "lead_facts_type_created_idx" ON "reporting"."lead_facts"("tombstoned", "widget_type", "source_created_at");
CREATE INDEX "projection_receipts_watermark_idx" ON "reporting"."projection_receipts"("projection", "source_sequence");
CREATE INDEX "projection_receipts_aggregate_idx" ON "reporting"."projection_receipts"("projection", "aggregate_id", "aggregate_version");
CREATE UNIQUE INDEX "projection_receipts_event_projection_unique" ON "reporting"."projection_receipts"("event_id", "projection");
CREATE INDEX "consumer_receipts_lease_idx" ON "reporting"."consumer_receipts"("status", "lease_expires_at");
CREATE UNIQUE INDEX "consumer_receipts_event_consumer_unique" ON "reporting"."consumer_receipts"("event_id", "consumer");
CREATE UNIQUE INDEX "reporting_consumer_failures_event_consumer_unique" ON "reporting"."consumer_failures"("event_id", "consumer");
CREATE INDEX "reporting_consumer_failures_status_failed_idx" ON "reporting"."consumer_failures"("status", "last_failed_at");
CREATE UNIQUE INDEX "report_runs_period_key_unique" ON "reporting"."report_runs"("period_key");
CREATE UNIQUE INDEX "report_runs_request_event_unique" ON "reporting"."report_runs"("request_event_id");
CREATE UNIQUE INDEX "report_runs_outcome_event_unique" ON "reporting"."report_runs"("outcome_event_id");
CREATE INDEX "report_runs_dispatch_idx" ON "reporting"."report_runs"("status", "available_at", "created_at");
CREATE INDEX "report_runs_lease_idx" ON "reporting"."report_runs"("status", "lease_expires_at");
CREATE UNIQUE INDEX "reporting_outbox_dedup_unique" ON "reporting"."outbox_events"("deduplication_key");
CREATE INDEX "reporting_outbox_dispatch_idx" ON "reporting"."outbox_events"("status", "available_at", "created_at");
CREATE INDEX "reporting_outbox_lease_idx" ON "reporting"."outbox_events"("status", "lease_expires_at");
CREATE INDEX "reporting_outbox_message_idx" ON "reporting"."outbox_events"("message_id");
CREATE INDEX "reporting_heartbeats_role_seen_idx" ON "reporting"."heartbeats"("role", "last_seen_at");
CREATE UNIQUE INDEX "reporting_heartbeats_role_instance_unique" ON "reporting"."heartbeats"("role", "instance_id");
CREATE UNIQUE INDEX "reporting_backfill_runs_snapshot_unique" ON "reporting"."backfill_runs"("snapshot_id");
CREATE INDEX "reporting_backfill_runs_lease_idx" ON "reporting"."backfill_runs"("status", "lease_expires_at");

CREATE FUNCTION "reporting"."reject_report_run_snapshot_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."destination_chat_id" IS DISTINCT FROM NEW."destination_chat_id"
		OR OLD."message_thread_id" IS DISTINCT FROM NEW."message_thread_id"
		OR (OLD."message_text" IS NOT NULL AND OLD."message_text" IS DISTINCT FROM NEW."message_text")
		OR (OLD."message_sha256" IS NOT NULL AND OLD."message_sha256" IS DISTINCT FROM NEW."message_sha256")
	THEN
		RAISE EXCEPTION 'report run content and destination snapshot are immutable';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER "report_runs_snapshot_immutable"
BEFORE UPDATE ON "reporting"."report_runs"
FOR EACH ROW
EXECUTE FUNCTION "reporting"."reject_report_run_snapshot_mutation"();
