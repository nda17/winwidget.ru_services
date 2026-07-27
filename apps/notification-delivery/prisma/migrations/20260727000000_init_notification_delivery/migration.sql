CREATE TYPE "notification_delivery"."NotificationDeliveryReceiptStatus" AS ENUM (
	'PROCESSING',
	'RETRY_SCHEDULED',
	'DELIVERED',
	'DEAD_LETTERED',
	'CLOSED_NO_RETRY'
);

CREATE TYPE "notification_delivery"."NotificationDeliveryErrorCategory" AS ENUM (
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
);

CREATE TYPE "notification_delivery"."NotificationDeliveryFailureResolution" AS ENUM (
	'DELIVERED',
	'CLOSED_NO_RETRY'
);

CREATE TYPE "notification_delivery"."NotificationDeliveryControlActionKind" AS ENUM (
	'RETRY',
	'CLOSE'
);

CREATE TYPE "notification_delivery"."NotificationDeliveryOutboxStatus" AS ENUM (
	'PENDING',
	'PUBLISHING',
	'PUBLISHED',
	'FAILED'
);

CREATE TYPE "notification_delivery"."NotificationDeliveryExchange" AS ENUM (
	'EVENTS',
	'DEAD_LETTER'
);

CREATE TABLE "notification_delivery"."delivery_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"status" "notification_delivery"."NotificationDeliveryReceiptStatus" NOT NULL,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"delivered_at" TIMESTAMP(3),
	"retry_attempt" INTEGER,
	"retry_available_at" TIMESTAMP(3),
	"retry_token" UUID,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "delivery_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "delivery_receipts_identity_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "consumer" IN ('email', 'telegram', 'payment-email', 'limit-email')
	),
	CONSTRAINT "delivery_receipts_state_check" CHECK ((
		(
			"status" = 'PROCESSING'::"notification_delivery"."NotificationDeliveryReceiptStatus"
			AND "locked_at" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" IS NOT NULL
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" = 'RETRY_SCHEDULED'::"notification_delivery"."NotificationDeliveryReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NOT NULL
			AND "retry_attempt" >= 0
			AND "retry_available_at" IS NOT NULL
			AND "retry_token" IS NOT NULL
		)
		OR (
			"status" = 'DELIVERED'::"notification_delivery"."NotificationDeliveryReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NOT NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" IN (
				'DEAD_LETTERED'::"notification_delivery"."NotificationDeliveryReceiptStatus",
				'CLOSED_NO_RETRY'::"notification_delivery"."NotificationDeliveryReceiptStatus"
			)
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
	) IS TRUE),
	CONSTRAINT "delivery_receipts_lease_check" CHECK (
		"lease_expires_at" IS NULL
		OR (
			"locked_at" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
		)
	)
);

CREATE UNIQUE INDEX "delivery_receipts_event_consumer_unique"
	ON "notification_delivery"."delivery_receipts"("event_id", "consumer");

CREATE INDEX "delivery_receipts_lease_idx"
	ON "notification_delivery"."delivery_receipts"("status", "lease_expires_at");

CREATE INDEX "delivery_receipts_retry_idx"
	ON "notification_delivery"."delivery_receipts"("status", "retry_available_at");

CREATE INDEX "delivery_receipts_consumer_delivered_idx"
	ON "notification_delivery"."delivery_receipts"("consumer", "delivered_at");

CREATE TABLE "notification_delivery"."delivery_failures" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"attempts" INTEGER NOT NULL,
	"last_error" TEXT NOT NULL,
	"category" "notification_delivery"."NotificationDeliveryErrorCategory" NOT NULL,
	"normalized_code" TEXT NOT NULL,
	"safe_reason" TEXT NOT NULL,
	"http_status" INTEGER,
	"provider_code" TEXT,
	"retryable" BOOLEAN NOT NULL,
	"classification_version" INTEGER NOT NULL,
	"first_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"retrying_at" TIMESTAMP(3),
	"active_retry_token" UUID,
	"resolved_at" TIMESTAMP(3),
	"resolution" "notification_delivery"."NotificationDeliveryFailureResolution",
	"resolution_comment" TEXT,
	"resolved_by_id" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "delivery_failures_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "delivery_failures_attempts_check" CHECK ("attempts" > 0),
	CONSTRAINT "delivery_failures_classification_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "consumer" IN ('email', 'telegram', 'payment-email', 'limit-email')
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND char_length(btrim("normalized_code")) BETWEEN 1 AND 255
		AND char_length(btrim("safe_reason")) BETWEEN 1 AND 2000
		AND "classification_version" > 0
		AND ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
		AND jsonb_typeof("headers") = 'object'
	),
	CONSTRAINT "delivery_failures_retry_state_check" CHECK ((
		(
			"retrying_at" IS NULL
			AND "active_retry_token" IS NULL
		)
		OR (
			"retrying_at" IS NOT NULL
			AND "active_retry_token" IS NOT NULL
			AND "resolved_at" IS NULL
		)
	) IS TRUE),
	CONSTRAINT "delivery_failures_resolution_check" CHECK ((
		(
			"resolved_at" IS NULL
			AND "resolution" IS NULL
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'DELIVERED'::"notification_delivery"."NotificationDeliveryFailureResolution"
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
			AND "retrying_at" IS NULL
			AND "active_retry_token" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'CLOSED_NO_RETRY'::"notification_delivery"."NotificationDeliveryFailureResolution"
			AND char_length(btrim("resolution_comment")) BETWEEN 3 AND 1000
			AND char_length(btrim("resolved_by_id")) BETWEEN 1 AND 255
			AND "retrying_at" IS NULL
			AND "active_retry_token" IS NULL
		)
	) IS TRUE)
);

CREATE UNIQUE INDEX "delivery_failures_event_consumer_unique"
	ON "notification_delivery"."delivery_failures"("event_id", "consumer");

CREATE INDEX "delivery_failures_status_idx"
	ON "notification_delivery"."delivery_failures"("resolved_at", "failed_at");

CREATE INDEX "delivery_failures_consumer_idx"
	ON "notification_delivery"."delivery_failures"("consumer", "resolved_at");

CREATE INDEX "delivery_failures_category_idx"
	ON "notification_delivery"."delivery_failures"("category", "resolved_at", "failed_at");

CREATE INDEX "delivery_failures_resolver_idx"
	ON "notification_delivery"."delivery_failures"("resolved_by_id");

CREATE TABLE "notification_delivery"."control_actions" (
	"id" UUID NOT NULL,
	"action" "notification_delivery"."NotificationDeliveryControlActionKind" NOT NULL,
	"failure_id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"kind" TEXT NOT NULL,
	"actor_id" TEXT NOT NULL,
	"comment" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "control_actions_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "control_actions_identity_check" CHECK (
		char_length(btrim("kind")) BETWEEN 1 AND 100
		AND "kind" IN ('email', 'telegram', 'payment-email', 'limit-email')
		AND char_length(btrim("actor_id")) BETWEEN 1 AND 255
	),
	CONSTRAINT "control_actions_content_check" CHECK ((
		(
			"action" = 'RETRY'::"notification_delivery"."NotificationDeliveryControlActionKind"
			AND "comment" IS NULL
		)
		OR (
			"action" = 'CLOSE'::"notification_delivery"."NotificationDeliveryControlActionKind"
			AND char_length(btrim("comment")) BETWEEN 3 AND 1000
		)
	) IS TRUE),
	CONSTRAINT "control_actions_failure_id_fkey"
		FOREIGN KEY ("failure_id")
		REFERENCES "notification_delivery"."delivery_failures"("id")
		ON DELETE RESTRICT
		ON UPDATE CASCADE
);

CREATE INDEX "control_actions_failure_created_idx"
	ON "notification_delivery"."control_actions"("failure_id", "created_at");

CREATE INDEX "control_actions_event_created_idx"
	ON "notification_delivery"."control_actions"("event_id", "created_at");

CREATE INDEX "control_actions_actor_created_idx"
	ON "notification_delivery"."control_actions"("actor_id", "created_at");

CREATE TABLE "notification_delivery"."outbox_events" (
	"id" UUID NOT NULL,
	"message_id" UUID NOT NULL,
	"deduplication_key" TEXT,
	"exchange" "notification_delivery"."NotificationDeliveryExchange" NOT NULL,
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"status" "notification_delivery"."NotificationDeliveryOutboxStatus" NOT NULL DEFAULT 'PENDING',
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
	CONSTRAINT "notification_outbox_events_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "notification_outbox_events_identity_check" CHECK (
		char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND (
			"deduplication_key" IS NULL
			OR char_length(btrim("deduplication_key")) BETWEEN 1 AND 500
		)
		AND jsonb_typeof("headers") = 'object'
		AND (
			(
				"exchange" = 'EVENTS'::"notification_delivery"."NotificationDeliveryExchange"
				AND "routing_key" IN (
					'manual.email',
					'manual.telegram',
					'manual.payment-email',
					'manual.limit-email'
				)
			)
			OR (
				"exchange" = 'DEAD_LETTER'::"notification_delivery"."NotificationDeliveryExchange"
				AND "routing_key" IN (
					'email.dead-letter',
					'telegram.dead-letter',
					'payment-email.dead-letter',
					'limit-email.dead-letter'
				)
			)
		)
	),
	CONSTRAINT "notification_outbox_events_state_check" CHECK ((
		(
			"status" = 'PENDING'::"notification_delivery"."NotificationDeliveryOutboxStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "published_at" IS NULL
		)
		OR (
			"status" = 'PUBLISHING'::"notification_delivery"."NotificationDeliveryOutboxStatus"
			AND "locked_at" IS NOT NULL
			AND char_length(btrim("locked_by")) > 0
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" IS NOT NULL
			AND "published_at" IS NULL
		)
		OR (
			"status" = 'PUBLISHED'::"notification_delivery"."NotificationDeliveryOutboxStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "published_at" IS NOT NULL
		)
		OR (
			"status" = 'FAILED'::"notification_delivery"."NotificationDeliveryOutboxStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "published_at" IS NULL
		)
	) IS TRUE),
	CONSTRAINT "notification_outbox_events_lease_check" CHECK (
		"lease_expires_at" IS NULL
		OR (
			"locked_at" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
		)
	)
);

CREATE INDEX "notification_outbox_events_message_id_idx"
	ON "notification_delivery"."outbox_events"("message_id");

CREATE UNIQUE INDEX "notification_outbox_events_deduplication_key_unique"
	ON "notification_delivery"."outbox_events"("deduplication_key");

CREATE INDEX "notification_outbox_events_dispatch_idx"
	ON "notification_delivery"."outbox_events"("status", "available_at", "created_at");

CREATE INDEX "notification_outbox_events_lease_idx"
	ON "notification_delivery"."outbox_events"("status", "lease_expires_at");

CREATE INDEX "notification_outbox_events_published_idx"
	ON "notification_delivery"."outbox_events"("published_at");

CREATE TABLE "notification_delivery"."heartbeats" (
	"id" UUID NOT NULL,
	"service" TEXT NOT NULL,
	"instance_id" TEXT NOT NULL,
	"metadata" JSONB NOT NULL DEFAULT '{}',
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "heartbeats_identity_check" CHECK (
		char_length(btrim("service")) BETWEEN 1 AND 100
		AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
		AND jsonb_typeof("metadata") = 'object'
	)
);

CREATE UNIQUE INDEX "heartbeats_service_instance_unique"
	ON "notification_delivery"."heartbeats"("service", "instance_id");

CREATE INDEX "heartbeats_service_seen_idx"
	ON "notification_delivery"."heartbeats"("service", "last_seen_at");

CREATE INDEX "heartbeats_seen_idx"
	ON "notification_delivery"."heartbeats"("last_seen_at");

-- ALTER DEFAULT PRIVILEGES grants the runtime role CRUD on new service tables,
-- but Prisma creates its migration history table before this migration runs.
-- Keep that internal table private without coupling this migration to a
-- deployment-specific runtime role name.
REVOKE ALL PRIVILEGES
	ON TABLE "notification_delivery"."_prisma_migrations"
	FROM PUBLIC;

DO $$
DECLARE
	grantee_name TEXT;
BEGIN
	FOR grantee_name IN
		SELECT DISTINCT grants.grantee
		FROM information_schema.role_table_grants AS grants
		WHERE grants.table_schema = 'notification_delivery'
			AND grants.table_name = '_prisma_migrations'
			AND grants.grantee <> CURRENT_USER
			AND grants.grantee <> 'PUBLIC'
	LOOP
		EXECUTE format(
			'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
			'notification_delivery',
			'_prisma_migrations',
			grantee_name
		);
	END LOOP;
END
$$;
