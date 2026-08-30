ALTER TABLE "notification_delivery"."delivery_receipts"
	ADD COLUMN "details_redacted_at" TIMESTAMP(3);

ALTER TABLE "notification_delivery"."delivery_failures"
	ADD COLUMN "details_redacted_at" TIMESTAMP(3);

CREATE INDEX "delivery_receipts_retention_idx"
	ON "notification_delivery"."delivery_receipts"("status", "delivered_at", "id");

CREATE INDEX "delivery_failures_retention_idx"
	ON "notification_delivery"."delivery_failures"("resolution", "resolved_at", "id");

CREATE INDEX "notification_outbox_events_retention_idx"
	ON "notification_delivery"."outbox_events"("status", "published_at", "id");
