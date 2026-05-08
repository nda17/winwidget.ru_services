ALTER TYPE "VerificationChallengePurpose" ADD VALUE 'BIND_TELEGRAM_NOTIFICATIONS';

CREATE TABLE "telegram_notification_channels" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_notification_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_notification_channels_user_id_key" ON "telegram_notification_channels"("user_id");
CREATE UNIQUE INDEX "telegram_notification_channels_chat_id_key" ON "telegram_notification_channels"("chat_id");
CREATE UNIQUE INDEX "telegram_notification_channels_telegram_user_id_key" ON "telegram_notification_channels"("telegram_user_id");
CREATE INDEX "telegram_notification_channels_is_active_idx" ON "telegram_notification_channels"("is_active");

ALTER TABLE "telegram_notification_channels"
ADD CONSTRAINT "telegram_notification_channels_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
