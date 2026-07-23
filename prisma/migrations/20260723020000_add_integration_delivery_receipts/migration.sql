CREATE TABLE "integration_delivery_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "integration_delivery_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_delivery_receipts_event_id_key"
	ON "integration_delivery_receipts"("event_id");

CREATE INDEX "integration_delivery_receipts_integration_delivered_idx"
	ON "integration_delivery_receipts"("integration", "delivered_at");

CREATE INDEX "integration_delivery_receipts_delivered_idx"
	ON "integration_delivery_receipts"("delivered_at");
