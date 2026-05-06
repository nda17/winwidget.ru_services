-- CreateTable
CREATE TABLE "subscription_expiry_reminders" (
	"id" TEXT NOT NULL,
	"subscription_id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"days_before_expiry" INTEGER NOT NULL,
	"expires_at" TIMESTAMP(3) NOT NULL,
	"sent_to" TEXT NOT NULL,
	"sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

	CONSTRAINT "subscription_expiry_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_expiry_reminder_unique" ON "subscription_expiry_reminders"("subscription_id", "days_before_expiry", "expires_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_user_id_idx" ON "subscription_expiry_reminders"("user_id");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_days_expires_idx" ON "subscription_expiry_reminders"("days_before_expiry", "expires_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_sent_at_idx" ON "subscription_expiry_reminders"("sent_at");

-- AddForeignKey
ALTER TABLE "subscription_expiry_reminders" ADD CONSTRAINT "subscription_expiry_reminders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_expiry_reminders" ADD CONSTRAINT "subscription_expiry_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
