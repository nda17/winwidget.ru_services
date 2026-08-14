-- The production lifecycle pre-creates this schema with the migration role as
-- its owner. Avoid PostgreSQL's database-level CREATE privilege check when the
-- schema already exists, while retaining an owner-path for local databases
-- that have not been provisioned separately.
DO $$
BEGIN
    IF to_regnamespace('identity') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "identity"';
    END IF;
END
$$;

-- CreateEnum
CREATE TYPE "identity"."Role" AS ENUM ('USER', 'ADMIN', 'DEV');

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "identity"."AuthIdentityType" AS ENUM ('EMAIL', 'PHONE', 'GOOGLE', 'GITHUB', 'YANDEX', 'VK', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "identity"."VerificationChallengeType" AS ENUM ('EMAIL', 'PHONE', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "identity"."VerificationChallengePurpose" AS ENUM ('REGISTER', 'BIND_IDENTITY', 'BIND_TELEGRAM_NOTIFICATIONS', 'LOGIN');

-- CreateEnum
CREATE TYPE "identity"."OAuthProvider" AS ENUM ('GOOGLE', 'GITHUB', 'YANDEX', 'VK');

-- CreateEnum
CREATE TYPE "identity"."ServiceDatabasePhase" AS ENUM ('SHADOW', 'IMPORTED', 'ACTIVE');

-- CreateEnum
CREATE TYPE "identity"."OutboxExchange" AS ENUM ('EVENTS', 'AUDIT', 'RETRY', 'MANUAL_RETRY', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "identity"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "identity"."ConsumerReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY');

-- CreateEnum
CREATE TYPE "identity"."ConsumerFailureStatus" AS ENUM ('OPEN', 'RETRYING', 'RESOLVED', 'CLOSED_NO_RETRY');

-- CreateEnum
CREATE TYPE "identity"."TelegramBotKind" AS ENUM ('AUTH', 'INFO');

-- CreateEnum
CREATE TYPE "identity"."WebhookReceiptStatus" AS ENUM ('PROCESSING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT NOT NULL,
    "avatar_path" TEXT,
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "personal_data_consent_revoked_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "rights" "identity"."Role"[] NOT NULL DEFAULT ARRAY['USER']::"identity"."Role"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."user_sessions" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "user_agent" VARCHAR(500),
    "ip_address" VARCHAR(128),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "identity"."AuthIdentityType" NOT NULL,
    "value" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."telegram_notification_channels" (
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

-- CreateTable
CREATE TABLE "identity"."verification_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" "identity"."VerificationChallengeType" NOT NULL,
    "purpose" "identity"."VerificationChallengePurpose" NOT NULL,
    "value" TEXT NOT NULL,
    "password_hash" TEXT,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "telegram_user_id" TEXT,
    "telegram_chat_id" TEXT,
    "telegram_username" TEXT,
    "telegram_first_name" TEXT,
    "telegram_last_name" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."auth_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "recaptcha_enabled" BOOLEAN NOT NULL DEFAULT true,
    "google_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
    "yandex_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
    "github_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
    "vk_auth_enabled" BOOLEAN NOT NULL DEFAULT false,
    "telegram_auth_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."oauth_authorizations" (
    "state_hash" CHAR(64) NOT NULL,
    "provider" "identity"."OAuthProvider" NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "referrer_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorizations_pkey" PRIMARY KEY ("state_hash")
);

-- CreateTable
CREATE TABLE "identity"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'identity-service',
    "database_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phase" "identity"."ServiceDatabasePhase" NOT NULL DEFAULT 'SHADOW',
    "ownership_generation" BIGINT NOT NULL DEFAULT 0,
    "source_fingerprint" CHAR(64),
    "source_snapshot_sha256" CHAR(64),
    "source_snapshot_counts" JSONB,
    "source_identity_high_water" BIGINT,
    "source_billing_high_water" BIGINT,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."aggregate_versions" (
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "version" BIGINT NOT NULL,
    "source_sequence" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aggregate_versions_pkey" PRIMARY KEY ("aggregate_type","aggregate_id")
);

-- CreateTable
CREATE TABLE "identity"."source_sequences" (
    "id" TEXT NOT NULL,
    "last_value" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."outbox_events" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "deduplication_key" TEXT,
    "exchange" "identity"."OutboxExchange" NOT NULL DEFAULT 'EVENTS',
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "aggregate_type" TEXT,
    "aggregate_id" TEXT,
    "aggregate_version" BIGINT,
    "source_sequence" BIGINT,
    "status" "identity"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."consumer_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "identity"."ConsumerReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "lock_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "retry_attempt" INTEGER,
    "manual_retry_cycle" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."consumer_failures" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "payload_hash" CHAR(64) NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "status" "identity"."ConsumerFailureStatus" NOT NULL DEFAULT 'OPEN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "manual_retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL,
    "last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_requested_at" TIMESTAMP(3),
    "retry_requested_by_id" TEXT,
    "retry_token" UUID,
    "retry_lease_expires_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "resolution_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumer_failures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."internal_command_receipts" (
    "id" UUID NOT NULL,
    "client" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_command_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."telegram_update_receipts" (
    "bot_kind" "identity"."TelegramBotKind" NOT NULL,
    "update_id" BIGINT NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "status" "identity"."WebhookReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_update_receipts_pkey" PRIMARY KEY ("bot_kind","update_id")
);

-- CreateTable
CREATE TABLE "identity"."heartbeats" (
    "id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "instance_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "identity"."users"("status");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "identity"."users"("deleted_at");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "identity"."user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "identity"."user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "identity"."auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_type_value_key" ON "identity"."auth_identities"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_user_id_type_key" ON "identity"."auth_identities"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_notification_channels_user_id_key" ON "identity"."telegram_notification_channels"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_notification_channels_chat_id_key" ON "identity"."telegram_notification_channels"("chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_notification_channels_telegram_user_id_key" ON "identity"."telegram_notification_channels"("telegram_user_id");

-- CreateIndex
CREATE INDEX "telegram_notification_channels_is_active_idx" ON "identity"."telegram_notification_channels"("is_active");

-- CreateIndex
CREATE INDEX "verification_challenges_telegram_user_id_idx" ON "identity"."verification_challenges"("telegram_user_id");

-- CreateIndex
CREATE INDEX "verification_challenges_expires_at_idx" ON "identity"."verification_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_challenges_user_id_type_purpose_key" ON "identity"."verification_challenges"("user_id", "type", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "verification_challenges_type_purpose_value_key" ON "identity"."verification_challenges"("type", "purpose", "value");

-- CreateIndex
CREATE INDEX "oauth_authorizations_expires_at_idx" ON "identity"."oauth_authorizations"("expires_at");

-- CreateIndex
CREATE INDEX "aggregate_versions_source_sequence_idx" ON "identity"."aggregate_versions"("source_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "identity"."outbox_events"("deduplication_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_created_at_idx" ON "identity"."outbox_events"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_lease_expires_at_idx" ON "identity"."outbox_events"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_aggregate_version_idx" ON "identity"."outbox_events"("aggregate_type", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "outbox_events_source_sequence_idx" ON "identity"."outbox_events"("source_sequence");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "identity"."outbox_events"("published_at");

-- CreateIndex
CREATE INDEX "consumer_receipts_status_lease_expires_at_idx" ON "identity"."consumer_receipts"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "consumer_receipts_consumer_delivered_at_idx" ON "identity"."consumer_receipts"("consumer", "delivered_at");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_receipts_event_id_consumer_key" ON "identity"."consumer_receipts"("event_id", "consumer");

-- CreateIndex
CREATE INDEX "consumer_failures_status_last_failed_at_idx" ON "identity"."consumer_failures"("status", "last_failed_at");

-- CreateIndex
CREATE INDEX "consumer_failures_status_retry_lease_expires_at_idx" ON "identity"."consumer_failures"("status", "retry_lease_expires_at");

-- CreateIndex
CREATE INDEX "consumer_failures_retry_requested_by_id_idx" ON "identity"."consumer_failures"("retry_requested_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_failures_event_id_consumer_key" ON "identity"."consumer_failures"("event_id", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "internal_command_receipts_client_command_idempotency_key_key" ON "identity"."internal_command_receipts"("client", "command", "idempotency_key");

-- CreateIndex
CREATE INDEX "telegram_update_receipts_status_lease_expires_at_idx" ON "identity"."telegram_update_receipts"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "heartbeats_role_last_seen_at_idx" ON "identity"."heartbeats"("role", "last_seen_at");

-- CreateIndex
CREATE INDEX "heartbeats_last_seen_at_idx" ON "identity"."heartbeats"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "heartbeats_role_instance_id_key" ON "identity"."heartbeats"("role", "instance_id");

-- AddForeignKey
ALTER TABLE "identity"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."telegram_notification_channels" ADD CONSTRAINT "telegram_notification_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."verification_challenges" ADD CONSTRAINT "verification_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email lookups are normalized and case-insensitive in the public contract.
-- Keep the legacy exact unique key as well as the database-level normalized fence.
CREATE UNIQUE INDEX "auth_identities_email_normalized_unique"
ON "identity"."auth_identities" (LOWER(BTRIM("value")))
WHERE "type" = 'EMAIL'::"identity"."AuthIdentityType";

ALTER TABLE "identity"."users"
ADD CONSTRAINT "users_rights_nonempty_check"
CHECK (CARDINALITY("rights") > 0);

ALTER TABLE "identity"."outbox_events"
ADD CONSTRAINT "outbox_events_aggregate_identity_check"
CHECK (
    ("aggregate_type" IS NULL AND "aggregate_id" IS NULL AND "aggregate_version" IS NULL)
    OR
    ("aggregate_type" IS NOT NULL AND "aggregate_id" IS NOT NULL AND "aggregate_version" IS NOT NULL)
);

INSERT INTO "identity"."service_identity" ("id", "service_name", "database_id", "updated_at")
VALUES ('singleton', 'identity-service', gen_random_uuid(), CURRENT_TIMESTAMP);

INSERT INTO "identity"."auth_settings" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP);

INSERT INTO "identity"."source_sequences" ("id", "last_value", "updated_at")
VALUES
    ('identity.user.changed.v1', 0, CURRENT_TIMESTAMP),
    ('billing.identity.changed.v1', 0, CURRENT_TIMESTAMP),
    ('admin.audit.identity.v1', 0, CURRENT_TIMESTAMP);
