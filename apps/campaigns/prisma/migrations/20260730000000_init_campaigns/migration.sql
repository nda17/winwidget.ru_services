CREATE TYPE "campaigns"."CampaignStatus" AS ENUM (
	'SNAPSHOTTING',
	'QUEUED',
	'RUNNING',
	'CANCEL_REQUESTED',
	'COMPLETED',
	'PARTIAL_FAILED',
	'FAILED',
	'CANCELLED'
);
CREATE TYPE "campaigns"."CampaignAudience" AS ENUM ('ALL', 'ACTIVE_SUBSCRIPTION');
CREATE TYPE "campaigns"."CampaignRequestedChannel" AS ENUM ('EMAIL', 'TELEGRAM', 'BOTH');
CREATE TYPE "campaigns"."CampaignDeliveryChannel" AS ENUM ('EMAIL', 'TELEGRAM');
CREATE TYPE "campaigns"."CampaignDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');
CREATE TYPE "campaigns"."AudienceSnapshotStatus" AS ENUM ('CREATING', 'READY', 'FAILED', 'CANCELLED');
CREATE TYPE "campaigns"."CampaignControlActionKind" AS ENUM ('CANCEL', 'RETRY');
CREATE TYPE "campaigns"."CampaignOutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'CANCELLED');
CREATE TYPE "campaigns"."CampaignOutboxExchange" AS ENUM ('EVENTS', 'RETRY', 'DEAD_LETTER');
CREATE TYPE "campaigns"."CampaignConsumerReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED');

CREATE TABLE "campaigns"."campaigns" (
	"id" UUID NOT NULL,
	"actor_id" TEXT NOT NULL,
	"idempotency_key" UUID NOT NULL,
	"subject" TEXT NOT NULL,
	"message" TEXT NOT NULL,
	"audience" "campaigns"."CampaignAudience" NOT NULL,
	"requested_channel" "campaigns"."CampaignRequestedChannel" NOT NULL,
	"status" "campaigns"."CampaignStatus" NOT NULL DEFAULT 'SNAPSHOTTING',
	"recipient_count" INTEGER NOT NULL DEFAULT 0,
	"sent_count" INTEGER NOT NULL DEFAULT 0,
	"failed_count" INTEGER NOT NULL DEFAULT 0,
	"cancelled_count" INTEGER NOT NULL DEFAULT 0,
	"email_count" INTEGER NOT NULL DEFAULT 0,
	"telegram_count" INTEGER NOT NULL DEFAULT 0,
	"started_at" TIMESTAMP(3),
	"completed_at" TIMESTAMP(3),
	"cancel_requested_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "campaigns_actor_check" CHECK (char_length(btrim("actor_id")) BETWEEN 1 AND 255),
	CONSTRAINT "campaigns_content_check" CHECK (
		char_length(btrim("subject")) BETWEEN 3 AND 120
		AND char_length(btrim("message")) BETWEEN 10 AND 5000
	),
	CONSTRAINT "campaigns_counters_check" CHECK (
		"recipient_count" >= 0
		AND "sent_count" >= 0
		AND "failed_count" >= 0
		AND "cancelled_count" >= 0
		AND "email_count" >= 0
		AND "telegram_count" >= 0
		AND "sent_count" + "failed_count" + "cancelled_count" <= "recipient_count"
	)
);

CREATE TABLE "campaigns"."audience_snapshots" (
	"id" UUID NOT NULL,
	"source_snapshot_id" UUID,
	"campaign_id" UUID NOT NULL,
	"channel" "campaigns"."CampaignDeliveryChannel" NOT NULL,
	"audience" "campaigns"."CampaignAudience" NOT NULL,
	"status" "campaigns"."AudienceSnapshotStatus" NOT NULL DEFAULT 'CREATING',
	"as_of" TIMESTAMP(3),
	"recipient_count" INTEGER NOT NULL DEFAULT 0,
	"sha256" CHAR(64),
	"last_error" TEXT,
	"import_token" UUID,
	"import_lease_expires_at" TIMESTAMP(3),
	"completed_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "audience_snapshots_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "audience_snapshots_count_check" CHECK ("recipient_count" >= 0),
	CONSTRAINT "audience_snapshots_hash_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audience_snapshots_import_lease_check" CHECK (
		("import_token" IS NULL AND "import_lease_expires_at" IS NULL)
		OR ("import_token" IS NOT NULL AND "import_lease_expires_at" IS NOT NULL)
	)
);

CREATE TABLE "campaigns"."deliveries" (
	"id" UUID NOT NULL,
	"campaign_id" UUID NOT NULL,
	"snapshot_id" UUID NOT NULL,
	"channel" "campaigns"."CampaignDeliveryChannel" NOT NULL,
	"destination" TEXT NOT NULL,
	"destination_key" CHAR(64) NOT NULL,
	"status" "campaigns"."CampaignDeliveryStatus" NOT NULL DEFAULT 'PENDING',
	"dispatch_generation" INTEGER NOT NULL DEFAULT 1,
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"request_event_id" UUID,
	"last_outcome_event_id" UUID,
	"last_error_code" TEXT,
	"last_error_reason" TEXT,
	"sent_at" TIMESTAMP(3),
	"cancelled_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "deliveries_destination_check" CHECK (char_length(btrim("destination")) BETWEEN 1 AND 1000),
	CONSTRAINT "deliveries_destination_key_check" CHECK ("destination_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "deliveries_generation_attempts_check" CHECK ("dispatch_generation" > 0 AND "attempts" >= 0),
	CONSTRAINT "deliveries_failure_check" CHECK (
		(
			"status" = 'FAILED'::"campaigns"."CampaignDeliveryStatus"
			AND char_length(btrim("last_error_code")) BETWEEN 1 AND 255
			AND char_length(btrim("last_error_reason")) BETWEEN 1 AND 2000
		)
		OR (
			"status" <> 'FAILED'::"campaigns"."CampaignDeliveryStatus"
			AND "last_error_code" IS NULL
			AND "last_error_reason" IS NULL
		)
	)
);

CREATE TABLE "campaigns"."control_actions" (
	"id" UUID NOT NULL,
	"campaign_id" UUID NOT NULL,
	"delivery_id" UUID,
	"actor_id" TEXT NOT NULL,
	"action" "campaigns"."CampaignControlActionKind" NOT NULL,
	"idempotency_key" UUID,
	"dispatch_generation" INTEGER,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "control_actions_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "control_actions_actor_check" CHECK (char_length(btrim("actor_id")) BETWEEN 1 AND 255),
	CONSTRAINT "control_actions_shape_check" CHECK (
		(
			"action" = 'CANCEL'::"campaigns"."CampaignControlActionKind"
			AND "delivery_id" IS NULL
			AND "idempotency_key" IS NULL
			AND "dispatch_generation" IS NULL
		)
		OR (
			"action" = 'RETRY'::"campaigns"."CampaignControlActionKind"
			AND "delivery_id" IS NOT NULL
			AND "idempotency_key" IS NOT NULL
			AND "dispatch_generation" > 1
		)
	)
);

CREATE TABLE "campaigns"."outbox_events" (
	"id" UUID NOT NULL,
	"message_id" UUID NOT NULL,
	"deduplication_key" TEXT,
	"exchange" "campaigns"."CampaignOutboxExchange" NOT NULL,
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"aggregate_type" TEXT,
	"aggregate_id" UUID,
	"generation" INTEGER,
	"status" "campaigns"."CampaignOutboxStatus" NOT NULL DEFAULT 'PENDING',
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
	CONSTRAINT "outbox_events_route_check" CHECK (
		char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND jsonb_typeof("headers") = 'object'
		AND "attempts" >= 0
	),
	CONSTRAINT "outbox_events_aggregate_check" CHECK (
		("aggregate_type" IS NULL AND "aggregate_id" IS NULL AND "generation" IS NULL)
		OR (
			char_length(btrim("aggregate_type")) > 0
			AND "aggregate_id" IS NOT NULL
			AND ("generation" IS NULL OR "generation" > 0)
		)
	)
);

CREATE TABLE "campaigns"."consumer_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"payload_hash" CHAR(64) NOT NULL,
	"status" "campaigns"."CampaignConsumerReceiptStatus" NOT NULL,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"retry_attempt" INTEGER,
	"delivered_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "consumer_receipts_identity_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT "consumer_receipts_lease_check" CHECK (
		"lease_expires_at" IS NULL
		OR ("locked_at" IS NOT NULL AND "lease_expires_at" > "locked_at")
	)
);

CREATE TABLE "campaigns"."idempotency_records" (
	"id" UUID NOT NULL,
	"scope" TEXT NOT NULL,
	"actor_id" TEXT NOT NULL,
	"key" UUID NOT NULL,
	"request_hash" CHAR(64) NOT NULL,
	"resource_type" TEXT NOT NULL,
	"resource_id" UUID NOT NULL,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"expires_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "idempotency_records_content_check" CHECK (
		char_length(btrim("scope")) BETWEEN 1 AND 100
		AND char_length(btrim("actor_id")) BETWEEN 1 AND 255
		AND "request_hash" ~ '^[0-9a-f]{64}$'
		AND char_length(btrim("resource_type")) BETWEEN 1 AND 100
		AND "expires_at" > "created_at"
	)
);

CREATE TABLE "campaigns"."rate_limits" (
	"id" UUID NOT NULL,
	"campaign_id" UUID NOT NULL,
	"channel" "campaigns"."CampaignDeliveryChannel" NOT NULL,
	"next_available_at" TIMESTAMP(3) NOT NULL,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaigns"."heartbeats" (
	"id" UUID NOT NULL,
	"role" TEXT NOT NULL,
	"instance_id" TEXT NOT NULL,
	"metadata" JSONB NOT NULL DEFAULT '{}',
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "heartbeats_identity_check" CHECK (
		"role" IN ('all', 'api', 'worker', 'publisher')
		AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
		AND jsonb_typeof("metadata") = 'object'
	)
);

CREATE UNIQUE INDEX "campaigns_actor_idempotency_unique" ON "campaigns"."campaigns"("actor_id", "idempotency_key");
CREATE INDEX "campaigns_status_created_idx" ON "campaigns"."campaigns"("status", "created_at");
CREATE INDEX "campaigns_created_idx" ON "campaigns"."campaigns"("created_at");
CREATE UNIQUE INDEX "audience_snapshots_source_id_unique" ON "campaigns"."audience_snapshots"("source_snapshot_id");
CREATE UNIQUE INDEX "audience_snapshots_campaign_channel_unique" ON "campaigns"."audience_snapshots"("campaign_id", "channel");
CREATE INDEX "audience_snapshots_status_created_idx" ON "campaigns"."audience_snapshots"("status", "created_at");
CREATE INDEX "audience_snapshots_import_lease_idx" ON "campaigns"."audience_snapshots"("status", "import_lease_expires_at");
CREATE UNIQUE INDEX "deliveries_campaign_channel_destination_unique" ON "campaigns"."deliveries"("campaign_id", "channel", "destination_key");
CREATE INDEX "deliveries_campaign_status_created_idx" ON "campaigns"."deliveries"("campaign_id", "status", "created_at");
CREATE INDEX "deliveries_status_created_idx" ON "campaigns"."deliveries"("status", "created_at");
CREATE INDEX "deliveries_request_event_idx" ON "campaigns"."deliveries"("request_event_id");
CREATE UNIQUE INDEX "control_actions_actor_idempotency_unique" ON "campaigns"."control_actions"("actor_id", "idempotency_key");
CREATE INDEX "control_actions_campaign_created_idx" ON "campaigns"."control_actions"("campaign_id", "created_at");
CREATE INDEX "control_actions_delivery_created_idx" ON "campaigns"."control_actions"("delivery_id", "created_at");
CREATE UNIQUE INDEX "outbox_events_deduplication_key_unique" ON "campaigns"."outbox_events"("deduplication_key");
CREATE INDEX "outbox_events_dispatch_idx" ON "campaigns"."outbox_events"("status", "available_at", "created_at");
CREATE INDEX "outbox_events_lease_idx" ON "campaigns"."outbox_events"("status", "lease_expires_at");
CREATE INDEX "outbox_events_message_id_idx" ON "campaigns"."outbox_events"("message_id");
CREATE INDEX "outbox_events_aggregate_idx" ON "campaigns"."outbox_events"("aggregate_type", "aggregate_id", "generation");
CREATE UNIQUE INDEX "consumer_receipts_event_consumer_unique" ON "campaigns"."consumer_receipts"("event_id", "consumer");
CREATE INDEX "consumer_receipts_lease_idx" ON "campaigns"."consumer_receipts"("status", "lease_expires_at");
CREATE UNIQUE INDEX "idempotency_scope_actor_key_unique" ON "campaigns"."idempotency_records"("scope", "actor_id", "key");
CREATE INDEX "idempotency_expires_idx" ON "campaigns"."idempotency_records"("expires_at");
CREATE UNIQUE INDEX "rate_limits_campaign_channel_unique" ON "campaigns"."rate_limits"("campaign_id", "channel");
CREATE INDEX "rate_limits_next_available_idx" ON "campaigns"."rate_limits"("next_available_at");
CREATE UNIQUE INDEX "heartbeats_role_instance_unique" ON "campaigns"."heartbeats"("role", "instance_id");
CREATE INDEX "heartbeats_role_seen_idx" ON "campaigns"."heartbeats"("role", "last_seen_at");

ALTER TABLE "campaigns"."audience_snapshots"
	ADD CONSTRAINT "audience_snapshots_campaign_id_fkey"
	FOREIGN KEY ("campaign_id") REFERENCES "campaigns"."campaigns"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaigns"."deliveries"
	ADD CONSTRAINT "deliveries_campaign_id_fkey"
	FOREIGN KEY ("campaign_id") REFERENCES "campaigns"."campaigns"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaigns"."deliveries"
	ADD CONSTRAINT "deliveries_snapshot_id_fkey"
	FOREIGN KEY ("snapshot_id") REFERENCES "campaigns"."audience_snapshots"("id")
	ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns"."control_actions"
	ADD CONSTRAINT "control_actions_campaign_id_fkey"
	FOREIGN KEY ("campaign_id") REFERENCES "campaigns"."campaigns"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaigns"."control_actions"
	ADD CONSTRAINT "control_actions_delivery_id_fkey"
	FOREIGN KEY ("delivery_id") REFERENCES "campaigns"."deliveries"("id")
	ON DELETE RESTRICT ON UPDATE CASCADE;
