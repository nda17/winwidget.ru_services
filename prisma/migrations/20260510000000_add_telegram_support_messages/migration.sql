CREATE TABLE "telegram_support_messages" (
    "id" TEXT NOT NULL,
    "admin_chat_id" TEXT NOT NULL,
    "admin_message_id" INTEGER NOT NULL,
    "user_chat_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_support_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_support_messages_admin_message_unique" ON "telegram_support_messages"("admin_chat_id", "admin_message_id");
CREATE INDEX "telegram_support_messages_user_chat_id_idx" ON "telegram_support_messages"("user_chat_id");
CREATE INDEX "telegram_support_messages_created_at_idx" ON "telegram_support_messages"("created_at");
