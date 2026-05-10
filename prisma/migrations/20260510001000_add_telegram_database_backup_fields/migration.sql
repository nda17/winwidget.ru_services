ALTER TABLE "telegram_bot_settings"
ADD COLUMN "database_backup_last_sent_period_start" TIMESTAMP(3),
ADD COLUMN "database_backup_last_sent_at" TIMESTAMP(3);
