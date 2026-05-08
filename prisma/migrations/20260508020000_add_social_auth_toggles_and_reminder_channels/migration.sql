ALTER TABLE "site_settings"
ADD COLUMN "github_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "telegram_auth_enabled" BOOLEAN NOT NULL DEFAULT true;

DROP INDEX IF EXISTS "subscription_expiry_reminder_unique";

CREATE UNIQUE INDEX "subscription_expiry_reminder_unique" ON "subscription_expiry_reminders"("subscription_id", "days_before_expiry", "expires_at", "sent_to");
