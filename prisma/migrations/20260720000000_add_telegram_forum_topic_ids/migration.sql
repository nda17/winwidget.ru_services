ALTER TABLE "telegram_bot_settings"
ADD COLUMN "support_thread_id" INTEGER,
ADD COLUMN "database_backup_thread_id" INTEGER,
ADD COLUMN "payments_thread_id" INTEGER,
ADD COLUMN "reports_thread_id" INTEGER;
