CREATE TYPE "IntegrationErrorCategory" AS ENUM (
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
);

CREATE TYPE "IntegrationFailureResolution" AS ENUM (
	'DELIVERED',
	'CLOSED_NO_RETRY'
);

ALTER TABLE "outbox_events"
	ADD COLUMN "headers" JSONB NOT NULL DEFAULT '{}',
	ADD COLUMN "deduplication_key" TEXT;

CREATE UNIQUE INDEX "outbox_events_deduplication_key_unique"
	ON "outbox_events"("deduplication_key");

ALTER TABLE "integration_delivery_receipts"
	ADD COLUMN "retry_attempt" INTEGER,
	ADD COLUMN "retry_available_at" TIMESTAMP(3),
	ADD COLUMN "retry_token" UUID,
	ADD CONSTRAINT "integration_delivery_receipts_state_check" CHECK ((
		(
			"status" = 'PROCESSING'::"IntegrationDeliveryReceiptStatus"
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" = 'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus"
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NOT NULL
			AND "retry_attempt" >= 0
			AND "retry_available_at" IS NOT NULL
			AND "retry_token" IS NOT NULL
		)
		OR (
			"status" = 'DELIVERED'::"IntegrationDeliveryReceiptStatus"
			AND "delivered_at" IS NOT NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" IN (
				'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus",
				'CLOSED_NO_RETRY'::"IntegrationDeliveryReceiptStatus"
			)
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
	) IS TRUE);

CREATE TABLE "integration_credential_snapshots" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"source" TEXT NOT NULL,
	"entity_id" TEXT NOT NULL,
	"target_fingerprint" TEXT NOT NULL,
	"credentials" JSONB NOT NULL,
	"version" INTEGER NOT NULL DEFAULT 1,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "integration_credential_snapshots_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "integration_credential_snapshots_identity_check" CHECK (
		char_length(btrim("integration")) BETWEEN 1 AND 100
		AND char_length(btrim("source")) BETWEEN 1 AND 100
		AND char_length(btrim("entity_id")) BETWEEN 1 AND 255
		AND char_length(btrim("target_fingerprint")) BETWEEN 1 AND 500
		AND "version" > 0
	)
);

CREATE UNIQUE INDEX "integration_credential_snapshots_event_integration_unique"
	ON "integration_credential_snapshots"("event_id", "integration");

CREATE INDEX "integration_credential_snapshots_entity_idx"
	ON "integration_credential_snapshots"("source", "entity_id", "integration");

ALTER TABLE "integration_delivery_failures"
	ADD COLUMN "category" "IntegrationErrorCategory",
	ADD COLUMN "normalized_code" TEXT,
	ADD COLUMN "safe_reason" TEXT,
	ADD COLUMN "http_status" INTEGER,
	ADD COLUMN "provider_code" TEXT,
	ADD COLUMN "retryable" BOOLEAN,
	ADD COLUMN "classification_version" INTEGER,
	ADD COLUMN "first_failed_at" TIMESTAMP(3),
	ADD COLUMN "active_retry_token" UUID,
	ADD COLUMN "resolution" "IntegrationFailureResolution",
	ADD COLUMN "resolution_comment" TEXT,
	ADD COLUMN "resolved_by_id" TEXT;

UPDATE "integration_delivery_failures"
SET "resolution" = 'DELIVERED'::"IntegrationFailureResolution"
WHERE "resolved_at" IS NOT NULL
	AND "resolution" IS NULL;

ALTER TABLE "integration_delivery_failures"
	ADD CONSTRAINT "integration_delivery_failures_resolution_check" CHECK ((
		(
			"resolved_at" IS NULL
			AND "resolution" IS NULL
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'DELIVERED'::"IntegrationFailureResolution"
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
			AND "active_retry_token" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'CLOSED_NO_RETRY'::"IntegrationFailureResolution"
			AND char_length(btrim("resolution_comment")) BETWEEN 3 AND 1000
			AND "active_retry_token" IS NULL
		)
	) IS TRUE),
	ADD CONSTRAINT "integration_delivery_failures_resolved_by_id_fkey"
		FOREIGN KEY ("resolved_by_id")
		REFERENCES "User"("id")
		ON DELETE SET NULL
		ON UPDATE CASCADE;

CREATE INDEX "integration_delivery_failures_category_idx"
	ON "integration_delivery_failures"("category", "resolved_at", "failed_at");

CREATE INDEX "integration_delivery_failures_resolver_idx"
	ON "integration_delivery_failures"("resolved_by_id");

-- Published Outbox rows and resolved failures are retained for diagnostics only.
-- Remove legacy destinations there so old amoCRM tokens and webhook secrets
-- do not remain duplicated outside the widget configuration.
UPDATE "outbox_events"
SET "payload" = "payload" - 'destination'
WHERE "status" = 'PUBLISHED'::"OutboxEventStatus"
	AND "event_type" = 'lead.integration.requested.v1'
	AND jsonb_typeof("payload") = 'object'
	AND "payload" ? 'destination';

UPDATE "integration_delivery_failures"
SET "payload" = "payload" - 'destination'
WHERE "resolved_at" IS NOT NULL
	AND jsonb_typeof("payload") = 'object'
	AND "payload" ? 'destination';
