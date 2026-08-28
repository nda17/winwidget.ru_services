-- Clean replacement: the former online-consultant aggregate and all of its
-- service-owned data are intentionally removed. No aliases or data migration
-- are provided because the product contract has been replaced.

BEGIN;

WITH removed AS (
	SELECT consultant."user_id", COUNT(*)::integer AS removed_count
	FROM "widgets"."online_consultants" AS consultant
	GROUP BY consultant."user_id"
), adjusted AS (
	UPDATE "widgets"."usage_counters" AS counter
	SET
		"widget_count" = GREATEST(0, counter."widget_count" - removed."removed_count"),
		"updated_at" = NOW()
	FROM removed
	WHERE counter."user_id" = removed."user_id"
	RETURNING
		counter."user_id",
		removed."removed_count",
		counter."widget_count",
		counter."entitlement_version"
)
INSERT INTO "widgets"."usage_ledger" (
	"id",
	"user_id",
	"kind",
	"operation",
	"delta",
	"counter_after",
	"aggregate_type",
	"aggregate_id",
	"idempotency_key",
	"entitlement_version",
	"occurred_at",
	"created_at"
)
SELECT
	gen_random_uuid(),
	adjusted."user_id",
	'WIDGET'::"widgets"."UsageKind",
	'MIGRATION_ADJUSTMENT'::"widgets"."UsageOperation",
	-adjusted."removed_count",
	adjusted."widget_count",
	'widgets.migration.aiConsultantReplacement',
	adjusted."user_id",
	'ai-consultant-replacement:widget:' || adjusted."user_id",
	adjusted."entitlement_version",
	NOW(),
	NOW()
FROM adjusted
WHERE adjusted."removed_count" > 0
ON CONFLICT ("idempotency_key") DO NOTHING;

WITH removed AS (
	SELECT consultant."user_id", COUNT(lead."id")::integer AS removed_count
	FROM "widgets"."online_consultants" AS consultant
	JOIN "widgets"."online_consultant_leads" AS lead
		ON lead."online_consultant_id" = consultant."id"
	JOIN "widgets"."usage_counters" AS counter
		ON counter."user_id" = consultant."user_id"
	WHERE
		(counter."lead_period_starts_at" IS NULL OR lead."created_at" >= counter."lead_period_starts_at")
		AND (counter."lead_period_ends_at" IS NULL OR lead."created_at" < counter."lead_period_ends_at")
	GROUP BY consultant."user_id"
), adjusted AS (
	UPDATE "widgets"."usage_counters" AS counter
	SET
		"lead_count" = GREATEST(0, counter."lead_count" - removed."removed_count"),
		"updated_at" = NOW()
	FROM removed
	WHERE counter."user_id" = removed."user_id"
	RETURNING
		counter."user_id",
		removed."removed_count",
		counter."lead_count",
		counter."lead_period_key",
		counter."entitlement_version"
)
INSERT INTO "widgets"."usage_ledger" (
	"id",
	"user_id",
	"kind",
	"operation",
	"delta",
	"counter_after",
	"period_key",
	"aggregate_type",
	"aggregate_id",
	"idempotency_key",
	"entitlement_version",
	"occurred_at",
	"created_at"
)
SELECT
	gen_random_uuid(),
	adjusted."user_id",
	'LEAD'::"widgets"."UsageKind",
	'MIGRATION_ADJUSTMENT'::"widgets"."UsageOperation",
	-adjusted."removed_count",
	adjusted."lead_count",
	adjusted."lead_period_key",
	'widgets.migration.aiConsultantReplacement',
	adjusted."user_id",
	'ai-consultant-replacement:lead:' || adjusted."user_id",
	adjusted."entitlement_version",
	NOW(),
	NOW()
FROM adjusted
WHERE adjusted."removed_count" > 0
ON CONFLICT ("idempotency_key") DO NOTHING;

DELETE FROM "widgets"."widget_config_revisions"
WHERE "widget_type" = 'ONLINE_CONSULTANT';

DELETE FROM "widgets"."widget_runtime_daily_step_metrics"
WHERE "widget_type" = 'ONLINE_CONSULTANT';

DELETE FROM "widgets"."widget_runtime_daily_metrics"
WHERE "widget_type" = 'ONLINE_CONSULTANT';

DELETE FROM "widgets"."widget_runtime_presence"
WHERE "widget_type" = 'ONLINE_CONSULTANT';

DELETE FROM "widgets"."aggregate_versions"
WHERE "aggregate_type" IN (
	'widgets.widget.onlineConsultant',
	'widgets.lead.onlineConsultant'
);

DELETE FROM "widgets"."usage_ledger"
WHERE "aggregate_type" IN (
	'widgets.widget.onlineConsultant',
	'widgets.lead.onlineConsultant'
);

-- The production migration role intentionally has no database TEMP privilege.
-- Use a transaction-scoped staging table in the service-owned schema instead.
CREATE TABLE "widgets"."retired_online_consultant_event_ids" (
	"event_id" UUID PRIMARY KEY
);

INSERT INTO "widgets"."retired_online_consultant_event_ids" ("event_id")
SELECT "message_id"
FROM "widgets"."outbox_events"
WHERE
	"aggregate_type" IN (
		'widgets.widget.onlineConsultant',
		'widgets.lead.onlineConsultant'
	)
	OR "payload" ->> 'source' = 'online-consultant'
	OR "payload" #>> '{entity,type}' = 'online-consultant'
	OR "payload" #>> '{target,widgetType}' = 'ONLINE_CONSULTANT'
ON CONFLICT ("event_id") DO NOTHING;

INSERT INTO "widgets"."retired_online_consultant_event_ids" ("event_id")
SELECT "event_id"
FROM "widgets"."integration_credential_snapshots"
WHERE "source" = 'online-consultant'
ON CONFLICT ("event_id") DO NOTHING;

INSERT INTO "widgets"."retired_online_consultant_event_ids" ("event_id")
SELECT "event_id"
FROM "widgets"."integration_delivery_failures"
WHERE
	"payload" ->> 'source' = 'online-consultant'
	OR "payload" #>> '{entity,type}' = 'online-consultant'
ON CONFLICT ("event_id") DO NOTHING;

INSERT INTO "widgets"."retired_online_consultant_event_ids" ("event_id")
SELECT "event_id"
FROM "widgets"."consumer_failures"
WHERE
	"payload" ->> 'source' = 'online-consultant'
	OR "payload" #>> '{entity,type}' = 'online-consultant'
	OR "payload" #>> '{target,widgetType}' = 'ONLINE_CONSULTANT'
ON CONFLICT ("event_id") DO NOTHING;

DELETE FROM "widgets"."integration_delivery_failures" AS failure
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE failure."event_id" = retired."event_id";

DELETE FROM "widgets"."integration_delivery_receipts" AS receipt
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE receipt."event_id" = retired."event_id";

DELETE FROM "widgets"."integration_credential_snapshots" AS snapshot
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE snapshot."event_id" = retired."event_id";

DELETE FROM "widgets"."consumer_failures" AS failure
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE failure."event_id" = retired."event_id";

DELETE FROM "widgets"."consumer_receipts" AS receipt
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE receipt."event_id" = retired."event_id";

DELETE FROM "widgets"."outbox_events" AS event
USING "widgets"."retired_online_consultant_event_ids" AS retired
WHERE event."message_id" = retired."event_id";

DROP TABLE "widgets"."retired_online_consultant_event_ids";

ALTER TABLE "widgets"."integration_credential_snapshots"
	DROP CONSTRAINT "integration_credential_snapshots_identity_check";

ALTER TABLE "widgets"."integration_credential_snapshots"
	ADD CONSTRAINT "integration_credential_snapshots_identity_check" CHECK (
		"integration" IN ('webhook', 'bitrix24', 'amo-crm')
		AND "source" IN ('widget', 'quiz', 'callback', 'countdown-timer', 'stop-offer', 'calculator')
		AND char_length(btrim("entity_id")) BETWEEN 1 AND 255
		AND char_length(btrim("target_fingerprint")) BETWEEN 1 AND 500
		AND jsonb_typeof("credentials") = 'object'
		AND "version" > 0
	);

DROP TABLE "widgets"."online_consultant_leads";
DROP TABLE "widgets"."online_consultants";

CREATE TABLE "widgets"."ai_consultants" (
	"id" TEXT NOT NULL,
	"user_id" TEXT NOT NULL,
	"public_key" TEXT NOT NULL,
	"name" TEXT NOT NULL DEFAULT 'AI-консультант',
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
	CONSTRAINT "ai_consultants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_consultants_public_key_key"
	ON "widgets"."ai_consultants"("public_key");

CREATE INDEX "ai_consultants_user_id_idx"
	ON "widgets"."ai_consultants"("user_id");

COMMIT;
