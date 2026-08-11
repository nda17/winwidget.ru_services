-- The production lifecycle pre-creates this schema with the migration role as
-- its owner. Avoid PostgreSQL's database-level CREATE privilege check when the
-- schema already exists, while retaining a convenient owner-path for local
-- databases that have not been provisioned separately.
DO $$
BEGIN
    IF to_regnamespace('billing') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "billing"';
    END IF;
END
$$;

-- CreateEnum
CREATE TYPE "billing"."Plan" AS ENUM ('TRIAL', 'EASY', 'HARD');

-- CreateEnum
CREATE TYPE "billing"."BillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "billing"."SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "billing"."PaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "billing"."PaymentKind" AS ENUM ('ONE_TIME', 'RECURRING');

-- CreateEnum
CREATE TYPE "billing"."AutoRenewalStatus" AS ENUM ('ACTIVE', 'USER_DISABLED', 'ADMIN_PAUSED', 'TECHNICAL_PAUSE', 'REVOKED');

-- CreateEnum
CREATE TYPE "billing"."AutoRenewalConsentEventType" AS ENUM ('CONSENT_GRANTED', 'USER_DISABLED', 'ADMIN_PAUSED', 'ADMIN_RESUMED', 'ADMIN_REVOKED', 'TECHNICAL_PAUSED', 'TECHNICAL_RESUMED', 'PAYMENT_METHOD_UPDATED', 'PRICE_CHANGE_REQUIRED', 'PRICE_CHANGE_CONFIRMED', 'RETRY_SCHEDULED', 'RETRY_EXHAUSTED', 'RETRY_CANCELLED');

-- CreateEnum
CREATE TYPE "billing"."SubscriptionHistoryAction" AS ENUM ('BONUS_DAYS');

-- CreateEnum
CREATE TYPE "billing"."SubscriptionBonusAudience" AS ENUM ('SINGLE', 'ACTIVE_SUBSCRIPTION', 'INACTIVE_SUBSCRIPTION', 'ALL');

-- CreateEnum
CREATE TYPE "billing"."SubscriptionExpiryReminderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "billing"."AffiliateReferralStatus" AS ENUM ('REGISTERED', 'REWARD_PENDING', 'CANCELLED', 'PAID');

-- CreateEnum
CREATE TYPE "billing"."ProviderOperationKind" AS ENUM ('CREATE_CHECKOUT', 'CAPTURE_RECURRING', 'VERIFY_PAYMENT', 'SYNC_RECEIPT');

-- CreateEnum
CREATE TYPE "billing"."ProviderOperationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN', 'FAILED');

-- CreateEnum
CREATE TYPE "billing"."OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "billing"."DeliveryReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY', 'FAILED');

-- CreateEnum
CREATE TYPE "billing"."IntegrationErrorCategory" AS ENUM ('TRANSIENT', 'RATE_LIMIT', 'PERMANENT', 'AUTH_CONFIGURATION');

-- CreateEnum
CREATE TYPE "billing"."IntegrationFailureResolution" AS ENUM ('DELIVERED', 'CLOSED_NO_RETRY');

-- CreateEnum
CREATE TYPE "billing"."DeliveryFailureStatus" AS ENUM ('OPEN', 'RETRY_PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "billing"."ScheduledRunStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "billing"."ServiceDatabasePhase" AS ENUM ('SHADOW', 'IMPORTED', 'ACTIVE');

-- CreateEnum
CREATE TYPE "billing"."BillingOwnershipPhase" AS ENUM ('PREPARED', 'ACTIVE', 'COMPLETE');

-- CreateTable
CREATE TABLE "billing"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'billing-service',
    "database_id" UUID NOT NULL,
    "phase" "billing"."ServiceDatabasePhase" NOT NULL DEFAULT 'SHADOW',
    "ownership_generation" BIGINT NOT NULL DEFAULT 0,
    "source_fingerprint" TEXT,
    "source_snapshot" JSONB,
    "source_high_watermark" BIGINT,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."billing_ownership_marker" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "phase" "billing"."BillingOwnershipPhase" NOT NULL DEFAULT 'PREPARED',
    "generation" BIGINT NOT NULL DEFAULT 0,
    "prepared_revision" TEXT NOT NULL,
    "ownership_revision" TEXT,
    "cleanup_revision" TEXT,
    "source_cutoff" TIMESTAMP(3) NOT NULL,
    "source_high_watermark" BIGINT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_ownership_marker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."source_sequences" (
    "id" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."identity_contact_projections" (
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "telegram_chat_id" TEXT,
    "telegram_channel_active" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "projection_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "last_event_id" TEXT,
    "source_created_at" TIMESTAMP(3),
    "source_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_contact_projections_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "billing"."notification_routing_projections" (
    "id" TEXT NOT NULL,
    "telegram_chat_id" TEXT,
    "payments_thread_id" INTEGER,
    "projection_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "last_event_id" TEXT,
    "source_updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_routing_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."offer_projections" (
    "id" TEXT NOT NULL DEFAULT 'offer',
    "content" TEXT,
    "sha256" TEXT,
    "consent_version" TEXT,
    "consent_text" TEXT,
    "source_updated_at" TIMESTAMP(3),
    "projection_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "tombstone" BOOLEAN NOT NULL DEFAULT false,
    "last_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offer_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "payment_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_renewal_signup_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_renewal_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_renewal_charges_enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "affiliate_program_enabled" BOOLEAN NOT NULL DEFAULT false,
    "affiliate_cashback_percent" INTEGER NOT NULL DEFAULT 10,
    "consent_version" TEXT NOT NULL DEFAULT 'v1',
    "consent_text" TEXT NOT NULL DEFAULT '',
    "offer_section_hash" TEXT NOT NULL DEFAULT '',
    "offer_snapshot" TEXT NOT NULL DEFAULT '',
    "offer_updated_at" TIMESTAMP(3),
    "payment_notification_destination" JSONB,
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "yookassa_id" TEXT,
    "provider_idempotency_key" TEXT,
    "recurring_cycle_key" TEXT,
    "recurring_attempt" INTEGER NOT NULL DEFAULT 0,
    "kind" "billing"."PaymentKind" NOT NULL DEFAULT 'ONE_TIME',
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "confirmation_url" TEXT,
    "status" "billing"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider_status" TEXT,
    "plan" "billing"."Plan",
    "billing_period" "billing"."BillingPeriod",
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "consent_version" TEXT,
    "consent_text" TEXT,
    "consented_at" TIMESTAMP(3),
    "consent_ip" TEXT,
    "consent_user_agent" TEXT,
    "offer_snapshot" TEXT,
    "offer_sha256" TEXT,
    "offer_updated_at" TIMESTAMP(3),
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "payment_method_ciphertext" TEXT,
    "provider_created_at" TIMESTAMP(3),
    "checkout_expires_at" TIMESTAMP(3) NOT NULL,
    "provider_expires_at" TIMESTAMP(3),
    "last_provider_checked_at" TIMESTAMP(3),
    "succeeded_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "receipt_sync_eligible" BOOLEAN NOT NULL DEFAULT true,
    "provider_snapshot" JSONB,
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payment_receipts" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "provider_receipt_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "type" TEXT,
    "fiscal_document_number" TEXT,
    "fiscal_storage_number" TEXT,
    "fiscal_attribute" TEXT,
    "registered_at" TIMESTAMP(3),
    "public_url" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" "billing"."Plan" NOT NULL DEFAULT 'TRIAL',
    "billing_period" "billing"."BillingPeriod",
    "status" "billing"."SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "leads_this_period" INTEGER NOT NULL DEFAULT 0,
    "period_resets_at" TIMESTAMP(3),
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."subscription_history" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "user_id" TEXT,
    "admin_id" TEXT,
    "action" "billing"."SubscriptionHistoryAction" NOT NULL,
    "days" INTEGER,
    "old_expires_at" TIMESTAMP(3),
    "new_expires_at" TIMESTAMP(3),
    "target_audience" "billing"."SubscriptionBonusAudience",
    "target_label" TEXT,
    "affected_users_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."subscription_expiry_reminders" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "days_before_expiry" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_to" TEXT NOT NULL,
    "status" "billing"."SubscriptionExpiryReminderStatus" NOT NULL DEFAULT 'PENDING',
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "subscription_expiry_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."auto_renewals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "billing"."AutoRenewalStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" "billing"."Plan" NOT NULL,
    "billing_period" "billing"."BillingPeriod" NOT NULL,
    "amount" TEXT NOT NULL,
    "pending_amount" TEXT,
    "price_change_detected_at" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "payment_method_ciphertext" TEXT,
    "payment_method_type" TEXT,
    "payment_method_title" TEXT,
    "payment_method_last4" TEXT,
    "payment_method_saved_at" TIMESTAMP(3),
    "consent_version" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "offer_snapshot" TEXT,
    "offer_sha256" TEXT,
    "offer_updated_at" TIMESTAMP(3),
    "next_charge_at" TIMESTAMP(3) NOT NULL,
    "retry_started_at" TIMESTAMP(3),
    "retry_attempt" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "dispatch_pending" BOOLEAN NOT NULL DEFAULT false,
    "disabled_at" TIMESTAMP(3),
    "disable_reason" TEXT,
    "last_charge_attempt_at" TIMESTAMP(3),
    "last_charge_error_code" TEXT,
    "state_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_renewals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."auto_renewal_consent_events" (
    "id" TEXT NOT NULL,
    "auto_renewal_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "billing"."AutoRenewalConsentEventType" NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "consent_version" TEXT NOT NULL,
    "consent_text" TEXT NOT NULL,
    "offer_snapshot" TEXT,
    "offer_sha256" TEXT,
    "offer_updated_at" TIMESTAMP(3),
    "plan" "billing"."Plan" NOT NULL,
    "billing_period" "billing"."BillingPeriod" NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "ip" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_renewal_consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."tariff_prices" (
    "id" TEXT NOT NULL,
    "plan" "billing"."Plan" NOT NULL,
    "billing_period" "billing"."BillingPeriod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariff_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."affiliate_referrals" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "first_payment_id" TEXT,
    "status" "billing"."AffiliateReferralStatus" NOT NULL DEFAULT 'REGISTERED',
    "payment_amount" INTEGER,
    "cashback_percent" INTEGER,
    "cashback_amount" INTEGER,
    "available_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "aggregate_version" BIGINT NOT NULL DEFAULT 0,
    "source_sequence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "affiliate_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."provider_operations" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT,
    "provider_payment_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "kind" "billing"."ProviderOperationKind" NOT NULL,
    "status" "billing"."ProviderOperationStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_safe" TEXT,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheduled_runs" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "status" "billing"."ScheduledRunStatus" NOT NULL DEFAULT 'PROCESSING',
    "claim_token" TEXT NOT NULL,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."command_receipts" (
    "command_id" TEXT NOT NULL,
    "command_type" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("command_id")
);

-- CreateTable
CREATE TABLE "billing"."outbox_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "message_id" TEXT,
    "deduplication_key" TEXT,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" BIGINT,
    "source_sequence" BIGINT,
    "correlation_id" UUID,
    "exchange" TEXT NOT NULL DEFAULT 'winwidget.events',
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "delivery_attempt" INTEGER NOT NULL DEFAULT 0,
    "status" "billing"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."integration_delivery_receipts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "integration" TEXT NOT NULL,
    "status" "billing"."DeliveryReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
    "locked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "retry_attempt" INTEGER DEFAULT 0,
    "retry_available_at" TIMESTAMP(3),
    "retry_token" UUID,
    "claim_token" UUID,
    "lease_until" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_delivery_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."integration_delivery_failures" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "integration" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL DEFAULT '',
    "category" "billing"."IntegrationErrorCategory",
    "normalized_code" TEXT,
    "safe_reason" TEXT,
    "http_status" INTEGER,
    "provider_code" TEXT,
    "retryable" BOOLEAN,
    "classification_version" INTEGER,
    "first_failed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retrying_at" TIMESTAMP(3),
    "active_retry_token" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution" "billing"."IntegrationFailureResolution",
    "resolution_comment" TEXT,
    "resolved_by_id" TEXT,
    "error_code" TEXT,
    "error_safe" TEXT,
    "status" "billing"."DeliveryFailureStatus" NOT NULL DEFAULT 'OPEN',
    "retry_outbox_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_delivery_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_contact_projections_status_idx" ON "billing"."identity_contact_projections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_yookassa_id_key" ON "billing"."payments"("yookassa_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_idempotency_key_key" ON "billing"."payments"("provider_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payments_recurring_cycle_key_key" ON "billing"."payments"("recurring_cycle_key");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "billing"."payments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_status_checkout_expires_at_idx" ON "billing"."payments"("status", "checkout_expires_at");

-- CreateIndex
CREATE INDEX "payments_kind_status_created_at_idx" ON "billing"."payments"("kind", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipts_provider_receipt_id_key" ON "billing"."payment_receipts"("provider_receipt_id");

-- CreateIndex
CREATE INDEX "payment_receipts_payment_id_registered_at_idx" ON "billing"."payment_receipts"("payment_id", "registered_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "billing"."subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_expires_at_idx" ON "billing"."subscriptions"("status", "expires_at");

-- CreateIndex
CREATE INDEX "subscription_history_subscription_id_idx" ON "billing"."subscription_history"("subscription_id");

-- CreateIndex
CREATE INDEX "subscription_history_user_id_idx" ON "billing"."subscription_history"("user_id");

-- CreateIndex
CREATE INDEX "subscription_history_admin_id_idx" ON "billing"."subscription_history"("admin_id");

-- CreateIndex
CREATE INDEX "subscription_history_created_at_idx" ON "billing"."subscription_history"("created_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_user_id_idx" ON "billing"."subscription_expiry_reminders"("user_id");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_days_expires_idx" ON "billing"."subscription_expiry_reminders"("days_before_expiry", "expires_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_sent_at_idx" ON "billing"."subscription_expiry_reminders"("sent_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_status_available_idx" ON "billing"."subscription_expiry_reminders"("status", "available_at");

-- CreateIndex
CREATE INDEX "subscription_expiry_reminders_status_locked_idx" ON "billing"."subscription_expiry_reminders"("status", "locked_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_expiry_reminder_unique" ON "billing"."subscription_expiry_reminders"("subscription_id", "days_before_expiry", "expires_at", "sent_to");

-- CreateIndex
CREATE UNIQUE INDEX "auto_renewals_user_id_key" ON "billing"."auto_renewals"("user_id");

-- CreateIndex
CREATE INDEX "auto_renewals_status_next_charge_at_idx" ON "billing"."auto_renewals"("status", "next_charge_at");

-- CreateIndex
CREATE INDEX "auto_renewals_status_next_retry_at_idx" ON "billing"."auto_renewals"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "auto_renewal_consent_events_auto_renewal_id_created_at_idx" ON "billing"."auto_renewal_consent_events"("auto_renewal_id", "created_at");

-- CreateIndex
CREATE INDEX "auto_renewal_consent_events_user_id_created_at_idx" ON "billing"."auto_renewal_consent_events"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_prices_plan_billing_period_key" ON "billing"."tariff_prices"("plan", "billing_period");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_referrals_referred_user_id_key" ON "billing"."affiliate_referrals"("referred_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_referrals_first_payment_id_key" ON "billing"."affiliate_referrals"("first_payment_id");

-- CreateIndex
CREATE INDEX "affiliate_referrals_referrer_id_idx" ON "billing"."affiliate_referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "affiliate_referrals_status_idx" ON "billing"."affiliate_referrals"("status");

-- CreateIndex
CREATE INDEX "affiliate_referrals_available_at_idx" ON "billing"."affiliate_referrals"("available_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_operations_idempotency_key_key" ON "billing"."provider_operations"("idempotency_key");

-- CreateIndex
CREATE INDEX "provider_operations_status_available_at_idx" ON "billing"."provider_operations"("status", "available_at");

-- CreateIndex
CREATE INDEX "provider_operations_provider_payment_id_idx" ON "billing"."provider_operations"("provider_payment_id");

-- CreateIndex
CREATE INDEX "scheduled_runs_status_lease_until_idx" ON "billing"."scheduled_runs"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_runs_task_period_key_key" ON "billing"."scheduled_runs"("task", "period_key");

-- CreateIndex
CREATE INDEX "command_receipts_command_type_created_at_idx" ON "billing"."command_receipts"("command_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_id_key" ON "billing"."outbox_events"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_deduplication_key_key" ON "billing"."outbox_events"("deduplication_key");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "billing"."outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "integration_delivery_receipts_status_lease_until_idx" ON "billing"."integration_delivery_receipts"("status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "integration_delivery_receipts_event_id_integration_key" ON "billing"."integration_delivery_receipts"("event_id", "integration");

-- CreateIndex
CREATE INDEX "integration_delivery_receipts_integration_delivered_at_idx" ON "billing"."integration_delivery_receipts"("integration", "delivered_at");

-- CreateIndex
CREATE INDEX "integration_delivery_receipts_delivered_at_idx" ON "billing"."integration_delivery_receipts"("delivered_at");

-- CreateIndex
CREATE INDEX "integration_delivery_failures_status_created_at_idx" ON "billing"."integration_delivery_failures"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_delivery_failures_event_id_integration_key" ON "billing"."integration_delivery_failures"("event_id", "integration");

-- CreateIndex
CREATE INDEX "integration_delivery_failures_resolved_at_failed_at_idx" ON "billing"."integration_delivery_failures"("resolved_at", "failed_at");

-- CreateIndex
CREATE INDEX "integration_delivery_failures_integration_resolved_at_idx" ON "billing"."integration_delivery_failures"("integration", "resolved_at");

-- CreateIndex
CREATE INDEX "integration_delivery_failures_category_resolved_at_failed_at_idx" ON "billing"."integration_delivery_failures"("category", "resolved_at", "failed_at");

-- AddForeignKey
ALTER TABLE "billing"."payment_receipts" ADD CONSTRAINT "payment_receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing"."payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."subscription_history" ADD CONSTRAINT "subscription_history_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."subscription_expiry_reminders" ADD CONSTRAINT "subscription_expiry_reminders_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."auto_renewal_consent_events" ADD CONSTRAINT "auto_renewal_consent_events_auto_renewal_id_fkey" FOREIGN KEY ("auto_renewal_id") REFERENCES "billing"."auto_renewals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."affiliate_referrals" ADD CONSTRAINT "affiliate_referrals_first_payment_id_fkey" FOREIGN KEY ("first_payment_id") REFERENCES "billing"."payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."provider_operations" ADD CONSTRAINT "provider_operations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing"."payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Billing invariants not expressible in Prisma schema.
ALTER TABLE "billing"."service_identity"
  ADD CONSTRAINT "service_identity_singleton_check" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "service_identity_name_check" CHECK ("service_name" = 'billing-service'),
  ADD CONSTRAINT "service_identity_generation_check" CHECK ("ownership_generation" >= 0),
  ADD CONSTRAINT "service_identity_high_water_check" CHECK ("source_high_watermark" IS NULL OR "source_high_watermark" >= 0);

ALTER TABLE "billing"."billing_ownership_marker"
  ADD CONSTRAINT "billing_ownership_singleton_check" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "billing_ownership_generation_check" CHECK ("generation" > 0),
  ADD CONSTRAINT "billing_ownership_high_water_check" CHECK ("source_high_watermark" >= 0),
  ADD CONSTRAINT "billing_ownership_fingerprint_check" CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "billing_ownership_timestamp_check" CHECK (
    ("phase" = 'PREPARED' AND "activated_at" IS NULL AND "completed_at" IS NULL)
    OR ("phase" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "completed_at" IS NULL)
    OR ("phase" = 'COMPLETE' AND "activated_at" IS NOT NULL AND "completed_at" IS NOT NULL)
  );

ALTER TABLE "billing"."source_sequences"
  ADD CONSTRAINT "source_sequences_positive_check" CHECK ("next_value" > 0);
ALTER TABLE "billing"."offer_projections"
  ADD CONSTRAINT "offer_projections_singleton_check" CHECK ("id" = 'offer'),
  ADD CONSTRAINT "offer_projections_versions_check" CHECK ("projection_version" >= 0 AND "source_sequence" >= 0),
  ADD CONSTRAINT "offer_projections_sha_check" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "billing"."settings"
  ADD CONSTRAINT "settings_singleton_check" CHECK ("id" = 'singleton'),
  ADD CONSTRAINT "settings_cashback_check" CHECK ("affiliate_cashback_percent" BETWEEN 1 AND 50),
  ADD CONSTRAINT "settings_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0);
ALTER TABLE "billing"."payments"
  ADD CONSTRAINT "payments_recurring_attempt_check" CHECK ("recurring_attempt" BETWEEN 0 AND 2),
  ADD CONSTRAINT "payments_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0);
ALTER TABLE "billing"."subscriptions"
  ADD CONSTRAINT "subscriptions_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0),
  ADD CONSTRAINT "subscriptions_leads_check" CHECK ("leads_this_period" >= 0);
ALTER TABLE "billing"."subscription_expiry_reminders"
  ADD CONSTRAINT "subscription_expiry_reminders_days_check" CHECK ("days_before_expiry" IN (0, 3, 6)),
  ADD CONSTRAINT "subscription_expiry_reminders_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "billing"."auto_renewals"
  ADD CONSTRAINT "auto_renewals_retry_check" CHECK ("retry_attempt" BETWEEN 0 AND 2),
  ADD CONSTRAINT "auto_renewals_state_version_check" CHECK ("state_version" > 0);
ALTER TABLE "billing"."affiliate_referrals"
  ADD CONSTRAINT "affiliate_referrals_versions_check" CHECK ("aggregate_version" >= 0 AND "source_sequence" >= 0),
  ADD CONSTRAINT "affiliate_referrals_cashback_check" CHECK ("cashback_percent" IS NULL OR "cashback_percent" BETWEEN 1 AND 50);
ALTER TABLE "billing"."provider_operations"
  ADD CONSTRAINT "provider_operations_attempt_check" CHECK ("attempt" >= 0);
ALTER TABLE "billing"."outbox_events"
  ADD CONSTRAINT "outbox_events_attempt_check" CHECK ("attempt" >= 0 AND "delivery_attempt" >= 0);
ALTER TABLE "billing"."integration_delivery_receipts"
  ADD CONSTRAINT "integration_delivery_receipts_attempt_check" CHECK ("retry_attempt" IS NULL OR "retry_attempt" >= 0);
ALTER TABLE "billing"."integration_delivery_failures"
  ADD CONSTRAINT "integration_delivery_failures_attempt_check" CHECK ("attempts" >= 0);

CREATE FUNCTION "billing"."enforce_ownership_forward_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  old_rank := CASE OLD."phase" WHEN 'PREPARED' THEN 1 WHEN 'ACTIVE' THEN 2 WHEN 'COMPLETE' THEN 3 END;
  new_rank := CASE NEW."phase" WHEN 'PREPARED' THEN 1 WHEN 'ACTIVE' THEN 2 WHEN 'COMPLETE' THEN 3 END;
  IF NEW."generation" < OLD."generation" OR new_rank < old_rank THEN
    RAISE EXCEPTION 'billing ownership rollback is forbidden' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."generation" <> OLD."generation" THEN
    RAISE EXCEPTION 'billing ownership generation is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source_fingerprint" <> OLD."source_fingerprint"
     OR NEW."source_high_watermark" <> OLD."source_high_watermark"
     OR NEW."source_cutoff" <> OLD."source_cutoff"
     OR NEW."prepared_revision" <> OLD."prepared_revision" THEN
    RAISE EXCEPTION 'billing ownership source evidence is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_ownership_forward_only"
BEFORE UPDATE ON "billing"."billing_ownership_marker"
FOR EACH ROW EXECUTE FUNCTION "billing"."enforce_ownership_forward_only"();

CREATE FUNCTION "billing"."enforce_service_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  old_rank := CASE OLD."phase" WHEN 'SHADOW' THEN 1 WHEN 'IMPORTED' THEN 2 WHEN 'ACTIVE' THEN 3 END;
  new_rank := CASE NEW."phase" WHEN 'SHADOW' THEN 1 WHEN 'IMPORTED' THEN 2 WHEN 'ACTIVE' THEN 3 END;
  IF NEW."database_id" <> OLD."database_id" OR NEW."service_name" <> OLD."service_name" OR new_rank < old_rank OR NEW."ownership_generation" < OLD."ownership_generation" THEN
    RAISE EXCEPTION 'billing service identity rollback is forbidden' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billing_service_identity_forward_only"
BEFORE UPDATE ON "billing"."service_identity"
FOR EACH ROW EXECUTE FUNCTION "billing"."enforce_service_identity"();

INSERT INTO "billing"."service_identity" (
  "id", "service_name", "database_id", "phase", "ownership_generation", "created_at", "updated_at"
) VALUES (
  'singleton', 'billing-service', gen_random_uuid(), 'SHADOW', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "billing"."source_sequences" ("id", "next_value", "updated_at")
VALUES ('billing', 1, CURRENT_TIMESTAMP);
