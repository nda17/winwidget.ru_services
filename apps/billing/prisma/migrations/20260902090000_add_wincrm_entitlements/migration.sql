BEGIN;

CREATE TYPE "billing"."CrmEntitlementStatus" AS ENUM (
  'ACTIVE',
  'GRACE',
  'READ_ONLY',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TABLE "billing"."crm_entitlements" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "product_code" VARCHAR(32) NOT NULL DEFAULT 'WINCRM',
  "plan_code" VARCHAR(32) NOT NULL DEFAULT 'TRIAL',
  "status" "billing"."CrmEntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
  "seat_limit" INTEGER,
  "trial_started_at" TIMESTAMP(3),
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_until" TIMESTAMP(3) NOT NULL,
  "activated_by_user_id" TEXT NOT NULL,
  "aggregate_version" BIGINT NOT NULL DEFAULT 1,
  "source_sequence" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "crm_entitlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_entitlements_product_code_check"
    CHECK ("product_code" = 'WINCRM'),
  CONSTRAINT "crm_entitlements_plan_code_check"
    CHECK (length(btrim("plan_code")) BETWEEN 1 AND 32),
  CONSTRAINT "crm_entitlements_seat_limit_check"
    CHECK ("seat_limit" IS NULL OR "seat_limit" > 0),
  CONSTRAINT "crm_entitlements_effective_window_check"
    CHECK ("effective_until" > "effective_from"),
  CONSTRAINT "crm_entitlements_trial_start_check"
    CHECK (
      (
        "plan_code" = 'TRIAL'
        AND "trial_started_at" IS NOT NULL
        AND "trial_started_at" = "effective_from"
      )
      OR (
        "plan_code" <> 'TRIAL'
        AND (
          "trial_started_at" IS NULL
          OR "trial_started_at" <= "effective_from"
        )
      )
    ),
  CONSTRAINT "crm_entitlements_activated_by_check"
    CHECK (
      length("activated_by_user_id") BETWEEN 1 AND 256
      AND "activated_by_user_id" = btrim("activated_by_user_id")
    )
);

CREATE UNIQUE INDEX "crm_entitlements_workspace_id_key"
  ON "billing"."crm_entitlements"("workspace_id");

CREATE INDEX "crm_entitlements_status_effective_until_idx"
  ON "billing"."crm_entitlements"("status", "effective_until");

COMMIT;
