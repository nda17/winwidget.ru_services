ALTER TABLE "telegram_bot_settings"
ADD COLUMN "daily_summary_time" TEXT NOT NULL DEFAULT '01:50',
ADD COLUMN "database_backup_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "database_backup_time" TEXT NOT NULL DEFAULT '01:45';
