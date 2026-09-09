-- CreateEnum
CREATE TYPE "support"."SupportConversationStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED');

-- CreateEnum
CREATE TYPE "support"."SupportSenderKind" AS ENUM ('CLIENT', 'OPERATOR');

-- CreateEnum
CREATE TYPE "support"."SupportAttachmentStatus" AS ENUM ('PREPARED', 'TEMPORARY', 'ATTACHED', 'DELETE_PENDING', 'DELETING', 'DELETED');

-- CreateTable
CREATE TABLE "support"."web_conversations" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "author_subject" TEXT NOT NULL,
    "author_name" TEXT,
    "workspace_id" UUID,
    "company_name" TEXT,
    "subject" VARCHAR(160) NOT NULL,
    "status" "support"."SupportConversationStatus" NOT NULL DEFAULT 'NEW',
    "section" VARCHAR(32) NOT NULL,
    "app_version" VARCHAR(64) NOT NULL,
    "last_sequence" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_subject" TEXT NOT NULL,
    "sender_kind" "support"."SupportSenderKind" NOT NULL,
    "sender_name" TEXT,
    "text" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_commands" (
    "id" UUID NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "command_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "web_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_read_states" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reader_subject" TEXT NOT NULL,
    "through_sequence" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_read_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_attachments" (
    "id" UUID NOT NULL,
    "owner_subject" TEXT NOT NULL,
    "command_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "draft_id" UUID,
    "conversation_id" UUID,
    "message_id" UUID,
    "storage_key" TEXT NOT NULL,
    "file_name" VARCHAR(160) NOT NULL,
    "media_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "status" "support"."SupportAttachmentStatus" NOT NULL DEFAULT 'PREPARED',
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "delete_passes" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_notification_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "version" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "staff_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "telegram_enabled" BOOLEAN NOT NULL DEFAULT false,
    "telegram_chat_id" TEXT,
    "telegram_thread_id" INTEGER,
    "client_email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_notification_intents" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "notification_type" TEXT NOT NULL,
    "recipient_subject" TEXT,
    "recipient_email" TEXT,
    "telegram_chat_id" TEXT,
    "telegram_thread_id" INTEGER,
    "settings_version" INTEGER NOT NULL,
    "group_key" CHAR(64) NOT NULL,
    "first_sequence" INTEGER NOT NULL,
    "last_sequence" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "outcome_event_id" UUID,
    "window_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_notification_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."web_rate_buckets" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_rate_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_conversations_number_key" ON "support"."web_conversations"("number");

-- CreateIndex
CREATE INDEX "web_conversations_author_subject_last_message_at_id_idx" ON "support"."web_conversations"("author_subject", "last_message_at", "id");

-- CreateIndex
CREATE INDEX "web_conversations_status_last_message_at_id_idx" ON "support"."web_conversations"("status", "last_message_at", "id");

-- CreateIndex
CREATE INDEX "web_messages_conversation_id_sender_kind_sequence_idx" ON "support"."web_messages"("conversation_id", "sender_kind", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "web_messages_conversation_id_sequence_key" ON "support"."web_messages"("conversation_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "web_commands_actor_subject_command_id_key" ON "support"."web_commands"("actor_subject", "command_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_read_states_conversation_id_reader_subject_key" ON "support"."web_read_states"("conversation_id", "reader_subject");

-- CreateIndex
CREATE UNIQUE INDEX "web_attachments_storage_key_key" ON "support"."web_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "web_attachments_status_expires_at_lease_expires_at_idx" ON "support"."web_attachments"("status", "expires_at", "lease_expires_at");

-- CreateIndex
CREATE INDEX "web_attachments_owner_subject_status_idx" ON "support"."web_attachments"("owner_subject", "status");

-- CreateIndex
CREATE UNIQUE INDEX "web_attachments_owner_subject_command_id_key" ON "support"."web_attachments"("owner_subject", "command_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_notification_intents_event_id_key" ON "support"."web_notification_intents"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "web_notification_intents_group_key_key" ON "support"."web_notification_intents"("group_key");

-- CreateIndex
CREATE INDEX "web_notification_intents_conversation_id_created_at_idx" ON "support"."web_notification_intents"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "web_rate_buckets_expires_at_idx" ON "support"."web_rate_buckets"("expires_at");

-- AddForeignKey
ALTER TABLE "support"."web_messages" ADD CONSTRAINT "web_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "support"."web_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."web_read_states" ADD CONSTRAINT "web_read_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "support"."web_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."web_attachments" ADD CONSTRAINT "web_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "support"."web_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."web_attachments" ADD CONSTRAINT "web_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support"."web_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."web_notification_intents" ADD CONSTRAINT "web_notification_intents_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "support"."web_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Web chat is additive. Existing Telegram settings/history are not rewritten.
ALTER TABLE support.web_conversations ADD CONSTRAINT web_conversation_content_check CHECK (
  length(btrim(subject)) BETWEEN 1 AND 160 AND last_sequence >= 0 AND version >= 0
  AND section IN ('inbox','customers','deals','planner','settings','other')
  AND app_version ~ '^[A-Za-z0-9._+-]{1,64}$'
);
ALTER TABLE support.web_messages ADD CONSTRAINT web_message_content_check CHECK (
  sequence > 0 AND length(btrim(text)) BETWEEN 1 AND 10000
);
ALTER TABLE support.web_read_states ADD CONSTRAINT web_read_sequence_check CHECK (through_sequence >= 0);
ALTER TABLE support.web_commands ADD CONSTRAINT web_command_status_check CHECK (status IN ('PENDING','COMPLETED'));
ALTER TABLE support.web_attachments ADD CONSTRAINT web_attachment_content_check CHECK (
  byte_size BETWEEN 1 AND 5242880 AND width > 0 AND height > 0
  AND width::bigint * height <= 40000000
  AND media_type IN ('image/png','image/jpeg','image/webp')
  AND storage_key ~ '^support/attachments/[0-9a-f-]{36}$'
  AND (status <> 'ATTACHED' OR (message_id IS NOT NULL AND conversation_id IS NOT NULL AND draft_id IS NULL))
  AND (message_id IS NULL OR status='ATTACHED')
);
ALTER TABLE support.web_notification_settings ADD CONSTRAINT web_settings_check CHECK (
  id='singleton' AND version>=0 AND cardinality(staff_emails)<=10
  AND (NOT email_enabled OR cardinality(staff_emails)>0)
  AND ((telegram_chat_id IS NULL AND telegram_thread_id IS NULL)
       OR (telegram_chat_id ~ '^-[1-9][0-9]{0,19}$' AND telegram_thread_id>0))
  AND (NOT telegram_enabled OR (telegram_chat_id IS NOT NULL AND telegram_thread_id IS NOT NULL))
);
ALTER TABLE support.web_notification_intents ADD CONSTRAINT web_intent_check CHECK (
  kind IN ('support-team-email','support-team-telegram','support-client-email')
  AND notification_type IN ('NEW_CONVERSATION','CLIENT_MESSAGE','OPERATOR_REPLY')
  AND status IN ('PENDING','DELIVERED','FAILED','SKIPPED')
  AND first_sequence>0 AND last_sequence>=first_sequence AND settings_version>=0
);
INSERT INTO support.web_notification_settings(id,staff_emails,telegram_chat_id,telegram_thread_id,updated_at)
SELECT 'singleton',ARRAY['zakaz@ybs.one'],
  CASE WHEN r.admin_chat_id ~ '^-[1-9][0-9]{0,19}$' AND r.support_thread_id>0 THEN r.admin_chat_id ELSE NULL END,
  CASE WHEN r.admin_chat_id ~ '^-[1-9][0-9]{0,19}$' AND r.support_thread_id>0 THEN r.support_thread_id ELSE NULL END,
  now()
FROM (SELECT 1) AS seed
LEFT JOIN support.routing_settings r ON r.id='singleton';
