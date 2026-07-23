DROP INDEX "integration_delivery_failures_event_id_key";
DROP INDEX "integration_delivery_receipts_event_id_key";

CREATE UNIQUE INDEX "integration_delivery_failures_event_integration_unique"
	ON "integration_delivery_failures"("event_id", "integration");

CREATE UNIQUE INDEX "integration_delivery_receipts_event_integration_unique"
	ON "integration_delivery_receipts"("event_id", "integration");
