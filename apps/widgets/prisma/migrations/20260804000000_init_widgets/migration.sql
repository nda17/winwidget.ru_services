-- The widgets schema is provisioned by the database bootstrap role before
-- Prisma migrations run. Keeping CREATE SCHEMA out of this migration lets the
-- migration credential remain least-privileged and schema-scoped.

CREATE TYPE "widgets"."EntitlementPlan" AS ENUM ('TRIAL', 'EASY', 'HARD');
CREATE TYPE "widgets"."EntitlementBillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "widgets"."EntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "widgets"."OwnerStatus" AS ENUM ('ACTIVE', 'DEACTIVATED', 'DELETED');
CREATE TYPE "widgets"."UsageKind" AS ENUM ('WIDGET', 'LEAD');
CREATE TYPE "widgets"."UsageOperation" AS ENUM ('CREATE', 'DELETE', 'PERIOD_RESET', 'MIGRATION_ADJUSTMENT');
CREATE TYPE "widgets"."WidgetsOutboxStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'QUARANTINED');
CREATE TYPE "widgets"."WidgetsOutboxExchange" AS ENUM ('EVENTS', 'RETRY', 'MANUAL_RETRY', 'DEAD_LETTER');
CREATE TYPE "widgets"."WidgetsConsumerReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED');
CREATE TYPE "widgets"."WidgetsConsumerFailureStatus" AS ENUM ('OPEN', 'RETRY_REQUESTED', 'RESOLVED');
CREATE TYPE "widgets"."IntegrationDeliveryReceiptStatus" AS ENUM ('PROCESSING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTERED', 'CLOSED_NO_RETRY');
CREATE TYPE "widgets"."IntegrationErrorCategory" AS ENUM ('TRANSIENT', 'RATE_LIMIT', 'PERMANENT', 'AUTH_CONFIGURATION');
CREATE TYPE "widgets"."IntegrationFailureResolution" AS ENUM ('DELIVERED', 'CLOSED_NO_RETRY');

CREATE TABLE "widgets"."widgets" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Виджет',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."callbacks" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Обратный звонок',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "callbacks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."callback_leads" (
	"id" TEXT NOT NULL,
	"callback_id" TEXT NOT NULL,
	"phone" TEXT NOT NULL,
	"time_slot" TEXT NOT NULL DEFAULT '',
	"timezone" TEXT NOT NULL DEFAULT '',
	"url" TEXT,
	"ip" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "callback_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."countdown_timers" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Таймер',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "countdown_timers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."countdown_timer_leads" (
	"id" TEXT NOT NULL,
	"countdown_timer_id" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"url" TEXT,
	"ip" TEXT,
	"timer_reset_token" TEXT NOT NULL DEFAULT '',
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "countdown_timer_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."stop_offers" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Стоп-оффер',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "stop_offers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."stop_offer_leads" (
	"id" TEXT NOT NULL,
	"stop_offer_id" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"url" TEXT,
	"ip" TEXT,
	"reset_token" TEXT NOT NULL DEFAULT '',
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "stop_offer_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."online_consultants" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Онлайн-консультант',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "online_consultants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."online_consultant_leads" (
	"id" TEXT NOT NULL,
	"online_consultant_id" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"action_label" TEXT NOT NULL DEFAULT '',
	"action_value" TEXT NOT NULL DEFAULT '',
	"url" TEXT,
	"ip" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "online_consultant_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."calculators" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Калькулятор',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "calculators_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."calculator_leads" (
	"id" TEXT NOT NULL,
	"calculator_id" TEXT NOT NULL,
	"contact" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"answers" JSONB NOT NULL DEFAULT '[]',
	"calculated_price" DECIMAL(14,2) NOT NULL,
	"currency" TEXT NOT NULL DEFAULT 'RUB',
	"url" TEXT,
	"ip" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "calculator_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."quizzes" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'Квиз',
	"is_active" BOOLEAN NOT NULL DEFAULT true,
	"install_domain" TEXT NOT NULL DEFAULT '',
	"config" JSONB NOT NULL DEFAULT '{}',
	"draft_config" JSONB,
	"draft_install_domain" TEXT,
	"draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_version" INTEGER NOT NULL DEFAULT 0,
	"published_from_draft_revision" INTEGER NOT NULL DEFAULT 0,
	"published_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."quiz_leads" (
	"id" TEXT NOT NULL,
	"quiz_id" TEXT NOT NULL,
	"contact" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"answers" JSONB NOT NULL DEFAULT '[]',
	"result" TEXT,
	"url" TEXT,
	"ip" TEXT,
	"quiz_reset_token" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "quiz_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."leads" (
	"id" TEXT NOT NULL,
	"widget_id" TEXT NOT NULL,
	"contact" TEXT NOT NULL,
	"phone" TEXT,
	"email" TEXT,
	"bonus" TEXT,
	"url" TEXT,
	"ip" TEXT,
	"spin_reset_token" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."widget_config_revisions" (
	"id" TEXT NOT NULL,
	"widget_type" TEXT NOT NULL,
	"widget_id" TEXT NOT NULL,
	"version" INTEGER NOT NULL,
	"config" JSONB NOT NULL,
	"install_domain" TEXT NOT NULL,
	"source_version" INTEGER,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "widget_config_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."widget_runtime_presence" (
	"id" TEXT NOT NULL,
	"widget_type" TEXT NOT NULL,
	"widget_id" TEXT NOT NULL,
	"install_domain" TEXT NOT NULL,
	"runtime_version" TEXT NOT NULL,
	"published_version" INTEGER NOT NULL,
	"first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "widget_runtime_presence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."widget_runtime_daily_metrics" (
	"id" TEXT NOT NULL,
	"widget_type" TEXT NOT NULL,
	"widget_id" TEXT NOT NULL,
	"published_version" INTEGER NOT NULL,
	"date" DATE NOT NULL,
	"impressions" INTEGER NOT NULL DEFAULT 0,
	"opens" INTEGER NOT NULL DEFAULT 0,
	"starts" INTEGER NOT NULL DEFAULT 0,
	"completions" INTEGER NOT NULL DEFAULT 0,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "widget_runtime_daily_metrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."widget_runtime_daily_step_metrics" (
	"id" TEXT NOT NULL,
	"widget_type" TEXT NOT NULL,
	"widget_id" TEXT NOT NULL,
	"published_version" INTEGER NOT NULL,
	"date" DATE NOT NULL,
	"step_key" TEXT NOT NULL,
	"count" INTEGER NOT NULL DEFAULT 0,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "widget_runtime_daily_step_metrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "widgets"."entitlement_projections" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"plan" "widgets"."EntitlementPlan",
	"billing_period" "widgets"."EntitlementBillingPeriod",
	"status" "widgets"."EntitlementStatus",
	"starts_at" TIMESTAMP(3),
	"expires_at" TIMESTAMP(3),
	"period_resets_at" TIMESTAMP(3),
	"max_widgets" INTEGER,
	"max_leads_per_period" INTEGER,
	"unlimited" BOOLEAN,
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"aggregate_version" BIGINT NOT NULL,
	"source_sequence" BIGINT NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"source_created_at" TIMESTAMP(3),
	"source_updated_at" TIMESTAMP(3),
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "entitlement_projections_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "entitlement_projections_version_check" CHECK (
		"aggregate_version" >= 0
		AND "source_sequence" >= 0
		AND ("max_widgets" IS NULL OR "max_widgets" >= 1)
		AND ("max_leads_per_period" IS NULL OR "max_leads_per_period" >= 1)
	),
	CONSTRAINT "entitlement_projections_state_check" CHECK ((
		(
			"tombstoned"
			AND "plan" IS NULL
			AND "billing_period" IS NULL
			AND "status" IS NULL
			AND "starts_at" IS NULL
			AND "expires_at" IS NULL
			AND "period_resets_at" IS NULL
			AND "max_widgets" IS NULL
			AND "max_leads_per_period" IS NULL
			AND "unlimited" IS NULL
		)
		OR (
			NOT "tombstoned"
			AND "plan" IS NOT NULL
			AND "status" IS NOT NULL
			AND "starts_at" IS NOT NULL
			AND "max_widgets" IS NOT NULL
			AND "unlimited" IS NOT NULL
			AND "source_created_at" IS NOT NULL
			AND (
				("unlimited" AND "max_leads_per_period" IS NULL)
				OR (
					NOT "unlimited"
					AND "max_leads_per_period" IS NOT NULL
					AND "max_leads_per_period" >= 1
				)
			)
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."usage_counters" (
	"user_id" TEXT NOT NULL,
	"widget_count" INTEGER NOT NULL DEFAULT 0,
	"lead_count" INTEGER NOT NULL DEFAULT 0,
	"lead_period_key" TEXT,
	"lead_period_starts_at" TIMESTAMP(3),
	"lead_period_ends_at" TIMESTAMP(3),
	"entitlement_version" BIGINT NOT NULL DEFAULT 0,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("user_id"),
	CONSTRAINT "usage_counters_values_check" CHECK (
		"widget_count" >= 0
		AND "lead_count" >= 0
		AND "entitlement_version" >= 0
	),
	CONSTRAINT "usage_counters_period_check" CHECK ((
		(
			"lead_period_key" IS NULL
			AND "lead_period_starts_at" IS NULL
			AND "lead_period_ends_at" IS NULL
			AND "lead_count" = 0
		)
		OR (
			char_length(btrim("lead_period_key")) BETWEEN 1 AND 200
			AND "lead_period_starts_at" IS NOT NULL
			AND (
				"lead_period_ends_at" IS NULL
				OR "lead_period_starts_at" < "lead_period_ends_at"
			)
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."usage_ledger" (
	"id" UUID NOT NULL,
	"user_id" TEXT NOT NULL,
	"kind" "widgets"."UsageKind" NOT NULL,
	"operation" "widgets"."UsageOperation" NOT NULL,
	"delta" INTEGER NOT NULL,
	"counter_after" INTEGER NOT NULL,
	"period_key" TEXT,
	"aggregate_type" TEXT,
	"aggregate_id" TEXT,
	"idempotency_key" TEXT NOT NULL,
	"entitlement_version" BIGINT NOT NULL,
	"correlation_id" TEXT,
	"occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "usage_ledger_values_check" CHECK (
		"counter_after" >= 0
		AND "entitlement_version" >= 0
		AND (
			"delta" <> 0
			OR "operation" IN (
				'PERIOD_RESET'::"widgets"."UsageOperation",
				'MIGRATION_ADJUSTMENT'::"widgets"."UsageOperation"
			)
		)
		AND char_length(btrim("idempotency_key")) BETWEEN 1 AND 255
		AND ("correlation_id" IS NULL OR "correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$')
	),
	CONSTRAINT "usage_ledger_scope_check" CHECK ((
		(
			"kind" = 'WIDGET'::"widgets"."UsageKind"
			AND "period_key" IS NULL
		)
		OR (
			"kind" = 'LEAD'::"widgets"."UsageKind"
			AND char_length(btrim("period_key")) BETWEEN 1 AND 200
		)
	) IS TRUE),
	CONSTRAINT "usage_ledger_aggregate_check" CHECK ((
		("aggregate_type" IS NULL AND "aggregate_id" IS NULL)
		OR (
			char_length(btrim("aggregate_type")) BETWEEN 1 AND 100
			AND char_length(btrim("aggregate_id")) BETWEEN 1 AND 255
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."owner_projections" (
	"user_id" TEXT NOT NULL,
	"status" "widgets"."OwnerStatus" NOT NULL,
	"deleted_at" TIMESTAMP(3),
	"tombstoned" BOOLEAN NOT NULL DEFAULT false,
	"aggregate_version" BIGINT NOT NULL,
	"source_sequence" BIGINT NOT NULL,
	"source_occurred_at" TIMESTAMP(3) NOT NULL,
	"applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "owner_projections_pkey" PRIMARY KEY ("user_id"),
	CONSTRAINT "owner_projections_version_check" CHECK (
		"aggregate_version" >= 0 AND "source_sequence" >= 0
	),
	CONSTRAINT "owner_projections_state_check" CHECK ((
		(
			"tombstoned"
			AND "status" = 'DELETED'::"widgets"."OwnerStatus"
			AND "deleted_at" IS NOT NULL
		)
		OR (
			NOT "tombstoned"
			AND "status" IN ('ACTIVE'::"widgets"."OwnerStatus", 'DEACTIVATED'::"widgets"."OwnerStatus")
			AND "deleted_at" IS NULL
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."aggregate_versions" (
	"aggregate_type" TEXT NOT NULL,
	"aggregate_id" TEXT NOT NULL,
	"version" BIGINT NOT NULL,
	"source_sequence" BIGINT NOT NULL,
	"state_hash" CHAR(64) NOT NULL,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "aggregate_versions_pkey" PRIMARY KEY ("aggregate_type", "aggregate_id"),
	CONSTRAINT "aggregate_versions_values_check" CHECK (
		char_length(btrim("aggregate_type")) BETWEEN 1 AND 100
		AND char_length(btrim("aggregate_id")) BETWEEN 1 AND 255
		AND "version" >= 0
		AND "source_sequence" >= 0
		AND "state_hash" ~ '^[0-9a-f]{64}$'
	)
);

CREATE TABLE "widgets"."source_sequences" (
	"id" TEXT NOT NULL DEFAULT 'reporting',
	"last_value" BIGINT NOT NULL DEFAULT 0,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "source_sequences_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "source_sequences_singleton_check" CHECK (
		"id" = 'reporting' AND "last_value" >= 0
	)
);

CREATE TABLE "widgets"."outbox_events" (
	"id" UUID NOT NULL,
	"message_id" UUID NOT NULL,
	"deduplication_key" TEXT,
	"exchange" "widgets"."WidgetsOutboxExchange" NOT NULL DEFAULT 'EVENTS',
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"aggregate_type" TEXT,
	"aggregate_id" TEXT,
	"aggregate_version" BIGINT,
	"source_sequence" BIGINT,
	"status" "widgets"."WidgetsOutboxStatus" NOT NULL DEFAULT 'PENDING',
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"published_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "outbox_events_content_check" CHECK (
		char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND jsonb_typeof("payload") = 'object'
		AND jsonb_typeof("headers") = 'object'
		AND "attempts" >= 0
		AND ("aggregate_version" IS NULL OR "aggregate_version" >= 0)
		AND ("source_sequence" IS NULL OR "source_sequence" >= 0)
		AND (
			"source_sequence" IS NULL
			OR (
				"aggregate_type" IS NOT NULL
				AND "aggregate_id" IS NOT NULL
				AND "aggregate_version" IS NOT NULL
			)
		)
	),
	CONSTRAINT "outbox_events_aggregate_check" CHECK ((
		("aggregate_type" IS NULL AND "aggregate_id" IS NULL AND "aggregate_version" IS NULL)
		OR (
			char_length(btrim("aggregate_type")) BETWEEN 1 AND 100
			AND char_length(btrim("aggregate_id")) BETWEEN 1 AND 255
			AND "aggregate_version" IS NOT NULL
		)
	) IS TRUE),
	CONSTRAINT "outbox_events_lease_check" CHECK ((
		(
			"status" = 'PUBLISHING'::"widgets"."WidgetsOutboxStatus"
			AND "locked_at" IS NOT NULL
			AND char_length(btrim("locked_by")) BETWEEN 1 AND 255
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
			AND "published_at" IS NULL
		)
		OR (
			"status" <> 'PUBLISHING'::"widgets"."WidgetsOutboxStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND (
				("status" = 'PUBLISHED'::"widgets"."WidgetsOutboxStatus" AND "published_at" IS NOT NULL)
				OR ("status" <> 'PUBLISHED'::"widgets"."WidgetsOutboxStatus" AND "published_at" IS NULL)
			)
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."consumer_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"payload_hash" CHAR(64) NOT NULL,
	"status" "widgets"."WidgetsConsumerReceiptStatus" NOT NULL,
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"retry_attempt" INTEGER,
	"retry_cycle" INTEGER NOT NULL DEFAULT 0,
	"delivered_at" TIMESTAMP(3),
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "consumer_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "consumer_receipts_identity_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
		AND ("retry_attempt" IS NULL OR "retry_attempt" BETWEEN 0 AND 1000000)
		AND "retry_cycle" BETWEEN 0 AND 1000000
	),
	CONSTRAINT "consumer_receipts_lease_check" CHECK ((
		(
			"status" = 'PROCESSING'::"widgets"."WidgetsConsumerReceiptStatus"
			AND "locked_at" IS NOT NULL
			AND char_length(btrim("locked_by")) BETWEEN 1 AND 255
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
			AND "retry_attempt" IS NULL
			AND "delivered_at" IS NULL
		)
		OR (
			"status" <> 'PROCESSING'::"widgets"."WidgetsConsumerReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND (
				("status" = 'RETRY_SCHEDULED'::"widgets"."WidgetsConsumerReceiptStatus" AND "retry_attempt" IS NOT NULL AND "delivered_at" IS NULL)
				OR ("status" = 'DELIVERED'::"widgets"."WidgetsConsumerReceiptStatus" AND "retry_attempt" IS NULL AND "delivered_at" IS NOT NULL)
				OR ("status" = 'DEAD_LETTERED'::"widgets"."WidgetsConsumerReceiptStatus" AND "retry_attempt" IS NULL AND "delivered_at" IS NULL)
			)
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."consumer_failures" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"consumer" TEXT NOT NULL,
	"event_type" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"payload_hash" CHAR(64) NOT NULL,
	"correlation_id" TEXT NOT NULL,
	"status" "widgets"."WidgetsConsumerFailureStatus" NOT NULL DEFAULT 'OPEN',
	"manual_retry_count" INTEGER NOT NULL DEFAULT 0,
	"last_error" TEXT NOT NULL,
	"last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"retry_requested_at" TIMESTAMP(3),
	"retry_requested_by_id" TEXT,
	"retry_token" UUID,
	"retry_lease_expires_at" TIMESTAMP(3),
	"resolved_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "consumer_failures_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "consumer_failures_content_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND jsonb_typeof("payload") = 'object'
		AND jsonb_typeof("headers") = 'object'
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
		AND "correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'
		AND "manual_retry_count" BETWEEN 0 AND 1000000
		AND char_length("last_error") BETWEEN 1 AND 4000
	),
	CONSTRAINT "consumer_failures_state_check" CHECK ((
		(
			"status" = 'OPEN'::"widgets"."WidgetsConsumerFailureStatus"
			AND "retry_requested_at" IS NULL
			AND "retry_requested_by_id" IS NULL
			AND "retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
			AND "resolved_at" IS NULL
		)
		OR (
			"status" = 'RETRY_REQUESTED'::"widgets"."WidgetsConsumerFailureStatus"
			AND "retry_requested_at" IS NOT NULL
			AND char_length(btrim("retry_requested_by_id")) BETWEEN 1 AND 255
			AND "retry_token" IS NOT NULL
			AND "retry_lease_expires_at" > "retry_requested_at"
			AND "resolved_at" IS NULL
		)
		OR (
			"status" = 'RESOLVED'::"widgets"."WidgetsConsumerFailureStatus"
			AND "retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
			AND "resolved_at" IS NOT NULL
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."integration_credential_snapshots" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"source" TEXT NOT NULL,
	"entity_id" TEXT NOT NULL,
	"target_fingerprint" TEXT NOT NULL,
	"credentials" JSONB NOT NULL,
	"version" INTEGER NOT NULL DEFAULT 1,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "integration_credential_snapshots_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "integration_credential_snapshots_identity_check" CHECK (
		"integration" IN ('webhook', 'bitrix24', 'amo-crm')
		AND "source" IN ('widget', 'quiz', 'callback', 'countdown-timer', 'stop-offer', 'online-consultant', 'calculator')
		AND char_length(btrim("entity_id")) BETWEEN 1 AND 255
		AND char_length(btrim("target_fingerprint")) BETWEEN 1 AND 500
		AND jsonb_typeof("credentials") = 'object'
		AND "version" > 0
	)
);

CREATE TABLE "widgets"."integration_delivery_receipts" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"payload_hash" CHAR(64) NOT NULL,
	"status" "widgets"."IntegrationDeliveryReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
	"locked_at" TIMESTAMP(3),
	"locked_by" TEXT,
	"lock_token" UUID,
	"lease_expires_at" TIMESTAMP(3),
	"delivered_at" TIMESTAMP(3),
	"retry_attempt" INTEGER,
	"retry_cycle" INTEGER NOT NULL DEFAULT 0,
	"retry_available_at" TIMESTAMP(3),
	"retry_token" UUID,
	"last_error" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "integration_delivery_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "integration_delivery_receipts_identity_check" CHECK (
		"integration" IN ('webhook', 'bitrix24', 'amo-crm')
		AND "payload_hash" ~ '^[0-9a-f]{64}$'
		AND ("retry_attempt" IS NULL OR "retry_attempt" BETWEEN 0 AND 1000000)
		AND "retry_cycle" BETWEEN 0 AND 1000000
	),
	CONSTRAINT "integration_delivery_receipts_state_check" CHECK ((
		(
			"status" = 'PROCESSING'::"widgets"."IntegrationDeliveryReceiptStatus"
			AND "locked_at" IS NOT NULL
			AND char_length(btrim("locked_by")) BETWEEN 1 AND 255
			AND "lock_token" IS NOT NULL
			AND "lease_expires_at" > "locked_at"
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" = 'RETRY_SCHEDULED'::"widgets"."IntegrationDeliveryReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NOT NULL
			AND "retry_available_at" IS NOT NULL
			AND "retry_token" IS NOT NULL
		)
		OR (
			"status" = 'DELIVERED'::"widgets"."IntegrationDeliveryReceiptStatus"
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NOT NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
		OR (
			"status" IN ('DEAD_LETTERED'::"widgets"."IntegrationDeliveryReceiptStatus", 'CLOSED_NO_RETRY'::"widgets"."IntegrationDeliveryReceiptStatus")
			AND "locked_at" IS NULL
			AND "locked_by" IS NULL
			AND "lock_token" IS NULL
			AND "lease_expires_at" IS NULL
			AND "delivered_at" IS NULL
			AND "retry_attempt" IS NULL
			AND "retry_available_at" IS NULL
			AND "retry_token" IS NULL
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."integration_delivery_failures" (
	"id" UUID NOT NULL,
	"event_id" UUID NOT NULL,
	"integration" TEXT NOT NULL,
	"routing_key" TEXT NOT NULL,
	"payload" JSONB NOT NULL,
	"headers" JSONB NOT NULL DEFAULT '{}',
	"attempts" INTEGER NOT NULL,
	"last_error" TEXT NOT NULL,
	"category" "widgets"."IntegrationErrorCategory",
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
	"retry_lease_expires_at" TIMESTAMP(3),
	"manual_retry_count" INTEGER NOT NULL DEFAULT 0,
	"resolved_at" TIMESTAMP(3),
	"resolution" "widgets"."IntegrationFailureResolution",
	"resolution_comment" TEXT,
	"resolved_by_id" TEXT,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "integration_delivery_failures_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "integration_delivery_failures_content_check" CHECK (
		"integration" IN ('webhook', 'bitrix24', 'amo-crm')
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND jsonb_typeof("payload") = 'object'
		AND jsonb_typeof("headers") = 'object'
		AND "attempts" >= 0
		AND "manual_retry_count" BETWEEN 0 AND 1000000
		AND ("classification_version" IS NULL OR "classification_version" > 0)
		AND ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
	),
	CONSTRAINT "integration_delivery_failures_retry_lease_check" CHECK ((
		(
			"active_retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
		)
		OR (
			"resolved_at" IS NULL
			AND "retrying_at" IS NOT NULL
			AND "active_retry_token" IS NOT NULL
			AND "retry_lease_expires_at" > "retrying_at"
		)
	) IS TRUE),
	CONSTRAINT "integration_delivery_failures_resolution_check" CHECK ((
		(
			"resolved_at" IS NULL
			AND "resolution" IS NULL
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'DELIVERED'::"widgets"."IntegrationFailureResolution"
			AND "resolution_comment" IS NULL
			AND "resolved_by_id" IS NULL
			AND "active_retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
		)
		OR (
			"resolved_at" IS NOT NULL
			AND "resolution" = 'CLOSED_NO_RETRY'::"widgets"."IntegrationFailureResolution"
			AND char_length(btrim("resolution_comment")) BETWEEN 3 AND 1000
			AND char_length(btrim("resolved_by_id")) BETWEEN 1 AND 255
			AND "active_retry_token" IS NULL
			AND "retry_lease_expires_at" IS NULL
		)
	) IS TRUE)
);

CREATE TABLE "widgets"."heartbeats" (
	"id" UUID NOT NULL,
	"role" TEXT NOT NULL,
	"instance_id" TEXT NOT NULL,
	"metadata" JSONB NOT NULL DEFAULT '{}',
	"last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "heartbeats_identity_check" CHECK (
		"role" IN ('all', 'api', 'worker', 'publisher')
		AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
		AND jsonb_typeof("metadata") = 'object'
	)
);

CREATE TABLE "widgets"."service_identity" (
	"id" TEXT NOT NULL DEFAULT 'widgets-service',
	"database_id" UUID NOT NULL,
	"ownership_generation" BIGINT NOT NULL DEFAULT 0,
	"source_database_fingerprint" CHAR(64),
	"source_exported_at" TIMESTAMP(3),
	"source_snapshot_sha256" CHAR(64),
	"source_snapshot_counts" JSONB,
	"source_reporting_high_water" BIGINT,
	"handoff_started_at" TIMESTAMP(3),
	"ownership_activated_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "service_identity_singleton_check" CHECK (
		"id" = 'widgets-service'
		AND (
			(
				"ownership_generation" = 0
				AND "source_database_fingerprint" IS NULL
				AND "source_exported_at" IS NULL
				AND "source_snapshot_sha256" IS NULL
				AND "source_snapshot_counts" IS NULL
				AND "source_reporting_high_water" IS NULL
				AND "handoff_started_at" IS NULL
				AND "ownership_activated_at" IS NULL
			)
			OR (
				"ownership_generation" = 0
				AND "source_database_fingerprint" ~ '^[0-9a-f]{64}$'
				AND "source_exported_at" IS NOT NULL
				AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
				AND jsonb_typeof("source_snapshot_counts") = 'object'
				AND "source_reporting_high_water" >= 0
				AND "handoff_started_at" IS NULL
				AND "ownership_activated_at" IS NULL
			)
			OR (
				"ownership_generation" = 0
				AND "source_database_fingerprint" ~ '^[0-9a-f]{64}$'
				AND "source_exported_at" IS NOT NULL
				AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
				AND jsonb_typeof("source_snapshot_counts") = 'object'
				AND "source_reporting_high_water" >= 0
				AND "handoff_started_at" IS NOT NULL
				AND "ownership_activated_at" IS NULL
			)
			OR (
				"ownership_generation" > 0
				AND "source_database_fingerprint" ~ '^[0-9a-f]{64}$'
				AND "source_exported_at" IS NOT NULL
				AND "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
				AND jsonb_typeof("source_snapshot_counts") = 'object'
				AND "source_reporting_high_water" >= 0
				AND "handoff_started_at" IS NOT NULL
				AND "ownership_activated_at" IS NOT NULL
			)
		)
	)
);

CREATE UNIQUE INDEX "widgets_public_key_key" ON "widgets"."widgets"("public_key");
CREATE INDEX "widgets_user_id_idx" ON "widgets"."widgets"("user_id");
CREATE UNIQUE INDEX "callbacks_public_key_key" ON "widgets"."callbacks"("public_key");
CREATE INDEX "callbacks_user_id_idx" ON "widgets"."callbacks"("user_id");
CREATE INDEX "callback_leads_callback_id_idx" ON "widgets"."callback_leads"("callback_id");
CREATE INDEX "callback_leads_callback_id_ip_idx" ON "widgets"."callback_leads"("callback_id", "ip");
CREATE UNIQUE INDEX "countdown_timers_public_key_key" ON "widgets"."countdown_timers"("public_key");
CREATE INDEX "countdown_timers_user_id_idx" ON "widgets"."countdown_timers"("user_id");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_idx" ON "widgets"."countdown_timer_leads"("countdown_timer_id");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_ip_idx" ON "widgets"."countdown_timer_leads"("countdown_timer_id", "ip");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_timer_reset_token_idx" ON "widgets"."countdown_timer_leads"("countdown_timer_id", "timer_reset_token");
CREATE INDEX "countdown_timer_leads_countdown_timer_id_timer_reset_token_ip_idx" ON "widgets"."countdown_timer_leads"("countdown_timer_id", "timer_reset_token", "ip");
CREATE UNIQUE INDEX "stop_offers_public_key_key" ON "widgets"."stop_offers"("public_key");
CREATE INDEX "stop_offers_user_id_idx" ON "widgets"."stop_offers"("user_id");
CREATE INDEX "stop_offer_leads_stop_offer_id_idx" ON "widgets"."stop_offer_leads"("stop_offer_id");
CREATE INDEX "stop_offer_leads_stop_offer_id_ip_idx" ON "widgets"."stop_offer_leads"("stop_offer_id", "ip");
CREATE INDEX "stop_offer_leads_stop_offer_id_reset_token_idx" ON "widgets"."stop_offer_leads"("stop_offer_id", "reset_token");
CREATE INDEX "stop_offer_leads_stop_offer_id_reset_token_ip_idx" ON "widgets"."stop_offer_leads"("stop_offer_id", "reset_token", "ip");
CREATE UNIQUE INDEX "online_consultants_public_key_key" ON "widgets"."online_consultants"("public_key");
CREATE INDEX "online_consultants_user_id_idx" ON "widgets"."online_consultants"("user_id");
CREATE INDEX "online_consultant_leads_online_consultant_id_idx" ON "widgets"."online_consultant_leads"("online_consultant_id");
CREATE INDEX "online_consultant_leads_online_consultant_id_ip_idx" ON "widgets"."online_consultant_leads"("online_consultant_id", "ip");
CREATE UNIQUE INDEX "calculators_public_key_key" ON "widgets"."calculators"("public_key");
CREATE INDEX "calculators_user_id_idx" ON "widgets"."calculators"("user_id");
CREATE INDEX "calculator_leads_calculator_id_idx" ON "widgets"."calculator_leads"("calculator_id");
CREATE INDEX "calculator_leads_calculator_id_ip_idx" ON "widgets"."calculator_leads"("calculator_id", "ip");
CREATE UNIQUE INDEX "quizzes_public_key_key" ON "widgets"."quizzes"("public_key");
CREATE INDEX "quizzes_user_id_idx" ON "widgets"."quizzes"("user_id");
CREATE INDEX "quiz_leads_quiz_id_idx" ON "widgets"."quiz_leads"("quiz_id");
CREATE INDEX "quiz_leads_quiz_id_ip_idx" ON "widgets"."quiz_leads"("quiz_id", "ip");
CREATE INDEX "leads_widget_id_idx" ON "widgets"."leads"("widget_id");
CREATE INDEX "leads_widget_id_ip_idx" ON "widgets"."leads"("widget_id", "ip");
CREATE UNIQUE INDEX "widget_config_revisions_widget_type_widget_id_version_key" ON "widgets"."widget_config_revisions"("widget_type", "widget_id", "version");
CREATE INDEX "widget_config_revisions_widget_type_widget_id_created_at_idx" ON "widgets"."widget_config_revisions"("widget_type", "widget_id", "created_at");
CREATE UNIQUE INDEX "widget_runtime_presence_widget_type_widget_id_key" ON "widgets"."widget_runtime_presence"("widget_type", "widget_id");
CREATE INDEX "widget_runtime_presence_last_seen_at_idx" ON "widgets"."widget_runtime_presence"("last_seen_at");
CREATE UNIQUE INDEX "widget_runtime_metric_unique" ON "widgets"."widget_runtime_daily_metrics"("widget_type", "widget_id", "published_version", "date");
CREATE INDEX "widget_runtime_metric_lookup_idx" ON "widgets"."widget_runtime_daily_metrics"("widget_type", "widget_id", "published_version", "date");
CREATE UNIQUE INDEX "widget_runtime_step_metric_unique" ON "widgets"."widget_runtime_daily_step_metrics"("widget_type", "widget_id", "published_version", "date", "step_key");
CREATE INDEX "widget_runtime_step_metric_lookup_idx" ON "widgets"."widget_runtime_daily_step_metrics"("widget_type", "widget_id", "published_version", "date");

CREATE UNIQUE INDEX "entitlement_projections_user_unique" ON "widgets"."entitlement_projections"("user_id");
CREATE INDEX "entitlement_projections_status_expiry_idx" ON "widgets"."entitlement_projections"("status", "expires_at");
CREATE INDEX "entitlement_projections_source_sequence_idx" ON "widgets"."entitlement_projections"("source_sequence");
CREATE INDEX "usage_counters_period_end_idx" ON "widgets"."usage_counters"("lead_period_ends_at");
CREATE UNIQUE INDEX "usage_ledger_idempotency_unique" ON "widgets"."usage_ledger"("idempotency_key");
CREATE INDEX "usage_ledger_user_kind_occurred_idx" ON "widgets"."usage_ledger"("user_id", "kind", "occurred_at");
CREATE INDEX "usage_ledger_aggregate_idx" ON "widgets"."usage_ledger"("aggregate_type", "aggregate_id");
CREATE INDEX "owner_projections_status_idx" ON "widgets"."owner_projections"("status");
CREATE INDEX "owner_projections_source_sequence_idx" ON "widgets"."owner_projections"("source_sequence");
CREATE INDEX "aggregate_versions_source_sequence_idx" ON "widgets"."aggregate_versions"("source_sequence");

CREATE UNIQUE INDEX "outbox_events_deduplication_unique" ON "widgets"."outbox_events"("deduplication_key");
CREATE INDEX "outbox_events_dispatch_idx" ON "widgets"."outbox_events"("status", "available_at", "created_at");
CREATE INDEX "outbox_events_lease_idx" ON "widgets"."outbox_events"("status", "lease_expires_at");
CREATE INDEX "outbox_events_message_idx" ON "widgets"."outbox_events"("message_id");
CREATE INDEX "outbox_events_aggregate_idx" ON "widgets"."outbox_events"("aggregate_type", "aggregate_id", "aggregate_version");
CREATE INDEX "outbox_events_source_sequence_idx" ON "widgets"."outbox_events"("source_sequence");
CREATE UNIQUE INDEX "consumer_receipts_event_consumer_unique" ON "widgets"."consumer_receipts"("event_id", "consumer");
CREATE INDEX "consumer_receipts_lease_idx" ON "widgets"."consumer_receipts"("status", "lease_expires_at");
CREATE INDEX "consumer_receipts_consumer_delivered_idx" ON "widgets"."consumer_receipts"("consumer", "delivered_at");
CREATE UNIQUE INDEX "consumer_failures_event_consumer_unique" ON "widgets"."consumer_failures"("event_id", "consumer");
CREATE INDEX "consumer_failures_status_failed_idx" ON "widgets"."consumer_failures"("status", "last_failed_at");
CREATE INDEX "consumer_failures_retry_lease_idx" ON "widgets"."consumer_failures"("status", "retry_lease_expires_at");
CREATE INDEX "consumer_failures_retry_actor_idx" ON "widgets"."consumer_failures"("retry_requested_by_id");
CREATE UNIQUE INDEX "integration_credential_snapshots_event_integration_unique" ON "widgets"."integration_credential_snapshots"("event_id", "integration");
CREATE INDEX "integration_credential_snapshots_entity_idx" ON "widgets"."integration_credential_snapshots"("source", "entity_id", "integration");
CREATE UNIQUE INDEX "integration_delivery_receipts_event_integration_unique" ON "widgets"."integration_delivery_receipts"("event_id", "integration");
CREATE INDEX "integration_delivery_receipts_lease_idx" ON "widgets"."integration_delivery_receipts"("status", "lease_expires_at");
CREATE INDEX "integration_delivery_receipts_retry_idx" ON "widgets"."integration_delivery_receipts"("status", "retry_available_at");
CREATE INDEX "integration_delivery_receipts_integration_delivered_idx" ON "widgets"."integration_delivery_receipts"("integration", "delivered_at");
CREATE UNIQUE INDEX "integration_delivery_failures_event_integration_unique" ON "widgets"."integration_delivery_failures"("event_id", "integration");
CREATE INDEX "integration_delivery_failures_status_idx" ON "widgets"."integration_delivery_failures"("resolved_at", "failed_at");
CREATE INDEX "integration_delivery_failures_integration_idx" ON "widgets"."integration_delivery_failures"("integration", "resolved_at");
CREATE INDEX "integration_delivery_failures_category_idx" ON "widgets"."integration_delivery_failures"("category", "resolved_at", "failed_at");
CREATE INDEX "integration_delivery_failures_retry_lease_idx" ON "widgets"."integration_delivery_failures"("retry_lease_expires_at");
CREATE INDEX "integration_delivery_failures_resolver_idx" ON "widgets"."integration_delivery_failures"("resolved_by_id");
CREATE UNIQUE INDEX "heartbeats_role_instance_unique" ON "widgets"."heartbeats"("role", "instance_id");
CREATE INDEX "heartbeats_role_seen_idx" ON "widgets"."heartbeats"("role", "last_seen_at");
CREATE INDEX "heartbeats_seen_idx" ON "widgets"."heartbeats"("last_seen_at");
CREATE UNIQUE INDEX "service_identity_database_unique" ON "widgets"."service_identity"("database_id");

ALTER TABLE "widgets"."callback_leads"
	ADD CONSTRAINT "callback_leads_callback_id_fkey"
	FOREIGN KEY ("callback_id") REFERENCES "widgets"."callbacks"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."countdown_timer_leads"
	ADD CONSTRAINT "countdown_timer_leads_countdown_timer_id_fkey"
	FOREIGN KEY ("countdown_timer_id") REFERENCES "widgets"."countdown_timers"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."stop_offer_leads"
	ADD CONSTRAINT "stop_offer_leads_stop_offer_id_fkey"
	FOREIGN KEY ("stop_offer_id") REFERENCES "widgets"."stop_offers"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."online_consultant_leads"
	ADD CONSTRAINT "online_consultant_leads_online_consultant_id_fkey"
	FOREIGN KEY ("online_consultant_id") REFERENCES "widgets"."online_consultants"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."calculator_leads"
	ADD CONSTRAINT "calculator_leads_calculator_id_fkey"
	FOREIGN KEY ("calculator_id") REFERENCES "widgets"."calculators"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."quiz_leads"
	ADD CONSTRAINT "quiz_leads_quiz_id_fkey"
	FOREIGN KEY ("quiz_id") REFERENCES "widgets"."quizzes"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."leads"
	ADD CONSTRAINT "leads_widget_id_fkey"
	FOREIGN KEY ("widget_id") REFERENCES "widgets"."widgets"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "widgets"."source_sequences" (
	"id", "last_value", "created_at", "updated_at"
) VALUES (
	'reporting', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

INSERT INTO "widgets"."service_identity" (
	"id", "database_id", "ownership_generation", "created_at", "updated_at"
) VALUES (
	'widgets-service', gen_random_uuid(), 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
