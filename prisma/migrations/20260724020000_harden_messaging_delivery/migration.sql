CREATE TYPE "IntegrationDeliveryReceiptStatus" AS ENUM (
	'PROCESSING',
	'DELIVERED'
);

ALTER TABLE "outbox_events"
	ADD COLUMN "message_id" UUID;

ALTER TABLE "integration_delivery_receipts"
	ADD COLUMN "status" "IntegrationDeliveryReceiptStatus" NOT NULL DEFAULT 'DELIVERED',
	ADD COLUMN "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	ALTER COLUMN "delivered_at" DROP NOT NULL;

CREATE INDEX "integration_delivery_receipts_processing_idx"
	ON "integration_delivery_receipts"("status", "locked_at");
