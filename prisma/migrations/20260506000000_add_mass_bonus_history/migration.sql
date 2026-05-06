-- CreateEnum
CREATE TYPE "SubscriptionBonusAudience" AS ENUM ('SINGLE', 'ACTIVE_SUBSCRIPTION', 'INACTIVE_SUBSCRIPTION', 'ALL');

-- AlterTable
ALTER TABLE "subscription_history"
	ADD COLUMN "target_audience" "SubscriptionBonusAudience",
	ADD COLUMN "target_label" TEXT,
	ADD COLUMN "affected_users_count" INTEGER;

UPDATE "subscription_history"
SET
	"target_audience" = 'SINGLE'::"SubscriptionBonusAudience",
	"affected_users_count" = 1
WHERE "target_audience" IS NULL;

ALTER TABLE "subscription_history"
	ALTER COLUMN "subscription_id" DROP NOT NULL,
	ALTER COLUMN "user_id" DROP NOT NULL;
