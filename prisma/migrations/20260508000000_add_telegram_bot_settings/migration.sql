-- CreateTable
CREATE TABLE "telegram_bot_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "daily_summary_enabled" BOOLEAN NOT NULL DEFAULT false,
    "daily_summary_chat_id" TEXT NOT NULL DEFAULT '',
    "daily_summary_last_sent_period_start" TIMESTAMP(3),
    "daily_summary_last_sent_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_bot_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "telegram_bot_settings" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
