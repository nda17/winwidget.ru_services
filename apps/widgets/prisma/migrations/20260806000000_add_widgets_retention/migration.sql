ALTER TABLE "widgets"."consumer_receipts"
	ADD COLUMN "details_purged_at" TIMESTAMP(3),
	ADD CONSTRAINT "consumer_receipts_details_purged_check" CHECK ((
		"details_purged_at" IS NULL
		OR (
			"status" = 'DELIVERED'::"widgets"."WidgetsConsumerReceiptStatus"
			AND "delivered_at" IS NOT NULL
			AND "details_purged_at" >= "delivered_at"
			AND "last_error" IS NULL
		)
	) IS TRUE);

ALTER TABLE "widgets"."consumer_failures"
	ADD COLUMN "details_purged_at" TIMESTAMP(3),
	ADD CONSTRAINT "consumer_failures_details_purged_check" CHECK ((
		"details_purged_at" IS NULL
		OR (
			"status" = 'RESOLVED'::"widgets"."WidgetsConsumerFailureStatus"
			AND "resolved_at" IS NOT NULL
			AND "details_purged_at" >= "resolved_at"
			AND "retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
			AND "payload" = '{}'::jsonb
			AND "headers" = '{}'::jsonb
			AND "last_error" = '[redacted after retention]'
		)
	) IS TRUE);

ALTER TABLE "widgets"."integration_delivery_receipts"
	ADD COLUMN "details_purged_at" TIMESTAMP(3),
	ADD CONSTRAINT "integration_delivery_receipts_details_purged_check" CHECK ((
		"details_purged_at" IS NULL
		OR (
			"status" IN (
				'DELIVERED'::"widgets"."IntegrationDeliveryReceiptStatus",
				'CLOSED_NO_RETRY'::"widgets"."IntegrationDeliveryReceiptStatus"
			)
			AND "details_purged_at" >= COALESCE("delivered_at", "updated_at")
			AND "last_error" IS NULL
		)
	) IS TRUE);

ALTER TABLE "widgets"."integration_delivery_failures"
	ADD COLUMN "details_purged_at" TIMESTAMP(3),
	ADD CONSTRAINT "integration_delivery_failures_details_purged_check" CHECK ((
		"details_purged_at" IS NULL
		OR (
			"resolved_at" IS NOT NULL
			AND "details_purged_at" >= "resolved_at"
			AND "resolution" IS NOT NULL
			AND "active_retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
			AND "payload" = '{}'::jsonb
			AND "headers" = '{}'::jsonb
			AND "last_error" = '[redacted after retention]'
			AND "safe_reason" IS NULL
			AND "http_status" IS NULL
			AND "provider_code" IS NULL
			AND (
				(
					"resolution" = 'DELIVERED'::"widgets"."IntegrationFailureResolution"
					AND "resolution_comment" IS NULL
				)
				OR (
					"resolution" = 'CLOSED_NO_RETRY'::"widgets"."IntegrationFailureResolution"
					AND "resolution_comment" = '[redacted after retention]'
				)
			)
		)
	) IS TRUE);

CREATE INDEX "outbox_events_retention_idx"
	ON "widgets"."outbox_events"("status", "published_at", "id");
CREATE INDEX "consumer_receipts_retention_idx"
	ON "widgets"."consumer_receipts"("status", "details_purged_at", "delivered_at", "id");
CREATE INDEX "consumer_failures_retention_idx"
	ON "widgets"."consumer_failures"("status", "details_purged_at", "resolved_at", "id");
CREATE INDEX "integration_delivery_receipts_delivered_retention_idx"
	ON "widgets"."integration_delivery_receipts"("status", "details_purged_at", "delivered_at", "id");
CREATE INDEX "integration_delivery_receipts_closed_retention_idx"
	ON "widgets"."integration_delivery_receipts"("status", "details_purged_at", "updated_at", "id");
CREATE INDEX "integration_delivery_receipts_snapshot_delivered_retention_idx"
	ON "widgets"."integration_delivery_receipts"("status", "delivered_at", "id");
CREATE INDEX "integration_delivery_receipts_snapshot_closed_retention_idx"
	ON "widgets"."integration_delivery_receipts"("status", "updated_at", "id");
CREATE INDEX "integration_delivery_failures_retention_idx"
	ON "widgets"."integration_delivery_failures"("details_purged_at", "resolved_at", "id");
