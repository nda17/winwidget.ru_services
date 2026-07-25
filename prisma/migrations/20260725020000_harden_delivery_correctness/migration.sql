ALTER TABLE "mailing_campaigns"
	ADD COLUMN "idempotency_key" UUID;

-- Existing campaigns predate mandatory Idempotency-Key. Their own UUID is a
-- stable, collision-free technical backfill; current code always supplies the
-- request key explicitly.
UPDATE "mailing_campaigns"
SET "idempotency_key" = "id"
WHERE "idempotency_key" IS NULL;

ALTER TABLE "mailing_campaigns"
	ALTER COLUMN "idempotency_key" SET NOT NULL;

CREATE UNIQUE INDEX "mailing_campaigns_admin_idempotency_key_unique"
	ON "mailing_campaigns"("admin_id", "idempotency_key");

ALTER TABLE "mailing_deliveries"
	ADD COLUMN "next_chunk_index" INTEGER NOT NULL DEFAULT 0,
	ADD CONSTRAINT "mailing_deliveries_next_chunk_index_check"
		CHECK ("next_chunk_index" >= 0);

CREATE TABLE "messaging_rate_limits" (
	"key" TEXT NOT NULL,
	"next_available_at" TIMESTAMP(3) NOT NULL,
	"updated_at" TIMESTAMP(3) NOT NULL,

	CONSTRAINT "messaging_rate_limits_pkey" PRIMARY KEY ("key")
);

CREATE TYPE "SubscriptionExpiryReminderStatus" AS ENUM (
	'PENDING',
	'PROCESSING',
	'SENT',
	'FAILED'
);

ALTER TABLE "subscription_expiry_reminders"
	ADD COLUMN "status" "SubscriptionExpiryReminderStatus" NOT NULL DEFAULT 'PENDING',
	ADD COLUMN "locked_at" TIMESTAMP(3),
	ADD COLUMN "locked_by" TEXT,
	ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
	ADD COLUMN "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	ADD COLUMN "last_error" TEXT,
	ALTER COLUMN "sent_at" DROP NOT NULL,
	ALTER COLUMN "sent_at" DROP DEFAULT;

UPDATE "subscription_expiry_reminders"
SET "status" = 'SENT';

ALTER TABLE "subscription_expiry_reminders"
	ADD CONSTRAINT "subscription_expiry_reminders_attempts_check"
		CHECK ("attempts" >= 0),
	ADD CONSTRAINT "subscription_expiry_reminders_state_check"
		CHECK (
			(
				"status" = 'PENDING'
				AND "locked_at" IS NULL
				AND "locked_by" IS NULL
				AND "sent_at" IS NULL
			)
			OR (
				"status" = 'PROCESSING'
				AND "locked_at" IS NOT NULL
				AND "locked_by" IS NOT NULL
				AND "sent_at" IS NULL
			)
			OR (
				"status" = 'SENT'
				AND "locked_at" IS NULL
				AND "locked_by" IS NULL
				AND "sent_at" IS NOT NULL
			)
			OR (
				"status" = 'FAILED'
				AND "locked_at" IS NULL
				AND "locked_by" IS NULL
				AND "sent_at" IS NULL
			)
		);

CREATE INDEX "subscription_expiry_reminders_status_available_idx"
	ON "subscription_expiry_reminders"("status", "available_at");

CREATE INDEX "subscription_expiry_reminders_status_locked_idx"
	ON "subscription_expiry_reminders"("status", "locked_at");
