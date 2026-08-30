BEGIN;

LOCK TABLE "operations"."database_restore_jobs" IN ACCESS EXCLUSIVE MODE;

DO $database_restore_forward_only$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "operations"."database_restore_jobs"
    ) THEN
        RAISE EXCEPTION 'Cannot install the exact restore permit contract while legacy restore jobs exist';
    END IF;
END
$database_restore_forward_only$;

CREATE TYPE "operations"."DatabaseRestorePermitStatus" AS ENUM (
    'PENDING_APPROVAL',
    'APPROVED',
    'CONSUMED',
    'CLOSED'
);

CREATE TYPE "operations"."DatabaseRestoreRecoveryActionType" AS ENUM (
    'VERIFY_AS_IS',
    'ROLL_BACK_SAFETY',
    'ROLL_FORWARD_SOURCE'
);

CREATE TYPE "operations"."DatabaseRestoreRecoveryActionStatus" AS ENUM (
    'PENDING_APPROVAL',
    'APPROVED',
    'EXPIRED'
);

CREATE TABLE "operations"."database_restore_permits" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "expected_services_sha" TEXT NOT NULL,
    "migration_manifest_sha" TEXT NOT NULL,
    "status" "operations"."DatabaseRestorePermitStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_restore_permits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_permits_target" CHECK (
        "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    ),
    CONSTRAINT "database_restore_permits_source_sha256" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_permits_services_sha" CHECK ("expected_services_sha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "database_restore_permits_manifest_sha" CHECK ("migration_manifest_sha" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_permits_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "database_restore_permits_distinct_actors" CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "requested_by_id"),
    CONSTRAINT "database_restore_permits_state_shape" CHECK (
        ("status" = 'PENDING_APPROVAL' AND "approved_by_id" IS NULL AND "approved_at" IS NULL AND "consumed_at" IS NULL AND "closed_at" IS NULL AND "close_reason" IS NULL)
        OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "consumed_at" IS NULL AND "closed_at" IS NULL AND "close_reason" IS NULL)
        OR ("status" = 'CONSUMED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "consumed_at" IS NOT NULL AND "closed_at" IS NULL AND "close_reason" IS NULL)
        OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL AND "close_reason" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "database_restore_permits_job_id_unique"
ON "operations"."database_restore_permits"("job_id");
CREATE UNIQUE INDEX "database_restore_permits_exact_binding_unique"
ON "operations"."database_restore_permits"(
    "id",
    "job_id",
    "target",
    "source_sha256",
    "expected_services_sha",
    "migration_manifest_sha"
);
CREATE INDEX "database_restore_permits_status_expiry_idx"
ON "operations"."database_restore_permits"("status", "expires_at");
CREATE UNIQUE INDEX "database_restore_permits_target_active_unique"
ON "operations"."database_restore_permits"("target")
WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED', 'CONSUMED');

ALTER TABLE "operations"."database_restore_jobs"
ADD COLUMN "permit_id" UUID NOT NULL,
ADD COLUMN "expected_services_sha" TEXT NOT NULL,
ADD COLUMN "migration_manifest_sha" TEXT NOT NULL,
ADD CONSTRAINT "database_restore_jobs_target" CHECK (
    "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
),
ADD CONSTRAINT "database_restore_jobs_services_sha"
    CHECK ("expected_services_sha" ~ '^[0-9a-f]{40}$'),
ADD CONSTRAINT "database_restore_jobs_manifest_sha"
    CHECK ("migration_manifest_sha" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "database_restore_jobs_permit_fkey"
    FOREIGN KEY (
        "permit_id",
        "id",
        "target",
        "source_sha256",
        "expected_services_sha",
        "migration_manifest_sha"
    ) REFERENCES "operations"."database_restore_permits"(
        "id",
        "job_id",
        "target",
        "source_sha256",
        "expected_services_sha",
        "migration_manifest_sha"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "database_restore_jobs_permit_id_unique"
ON "operations"."database_restore_jobs"("permit_id");
CREATE UNIQUE INDEX "database_restore_jobs_exact_permit_binding_unique"
ON "operations"."database_restore_jobs"(
    "permit_id",
    "id",
    "target",
    "source_sha256",
    "expected_services_sha",
    "migration_manifest_sha"
);

CREATE TABLE "operations"."database_restore_terminal_receipts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "terminal_status" "operations"."DatabaseRestoreJobStatus" NOT NULL,
    "phase" "operations"."DatabaseRestoreJobPhase",
    "source_sha256" TEXT NOT NULL,
    "safety_backup_sha256" TEXT,
    "expected_services_sha" TEXT NOT NULL,
    "migration_manifest_sha" TEXT NOT NULL,
    "result_sha256" TEXT,
    "error_sha256" TEXT,
    "payload_sha256" TEXT NOT NULL,
    "signature_hmac_sha256" TEXT NOT NULL,
    "signature_key_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_restore_terminal_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_terminal_receipts_target" CHECK (
        "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    ),
    CONSTRAINT "database_restore_terminal_receipts_job_fkey"
        FOREIGN KEY ("job_id") REFERENCES "operations"."database_restore_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_terminal_receipts_terminal_status" CHECK (
        "terminal_status" IN ('SUCCEEDED', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED')
    ),
    CONSTRAINT "database_restore_terminal_receipts_source_sha256" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_safety_sha256" CHECK ("safety_backup_sha256" IS NULL OR "safety_backup_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_services_sha" CHECK ("expected_services_sha" ~ '^[0-9a-f]{40}$'),
    CONSTRAINT "database_restore_terminal_receipts_manifest_sha" CHECK ("migration_manifest_sha" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_result_sha256" CHECK ("result_sha256" IS NULL OR "result_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_error_sha256" CHECK ("error_sha256" IS NULL OR "error_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_payload_sha256" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_hmac_sha256" CHECK ("signature_hmac_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_terminal_receipts_key_id" CHECK ("signature_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$')
);

CREATE UNIQUE INDEX "database_restore_terminal_receipts_job_id_unique"
ON "operations"."database_restore_terminal_receipts"("job_id");

CREATE TABLE "operations"."database_restore_recovery_actions" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "action" "operations"."DatabaseRestoreRecoveryActionType" NOT NULL,
    "status" "operations"."DatabaseRestoreRecoveryActionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "receipt_payload_sha" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_restore_recovery_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_recovery_actions_job_fkey"
        FOREIGN KEY ("job_id") REFERENCES "operations"."database_restore_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_recovery_actions_receipt_sha" CHECK ("receipt_payload_sha" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "database_restore_recovery_actions_expiry" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "database_restore_recovery_actions_distinct_actors" CHECK ("approved_by_id" IS NULL OR "approved_by_id" <> "requested_by_id"),
    CONSTRAINT "database_restore_recovery_actions_state_shape" CHECK (
        ("status" = 'PENDING_APPROVAL' AND "approved_by_id" IS NULL AND "approved_at" IS NULL)
        OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL)
        OR ("status" = 'EXPIRED')
    )
);

CREATE INDEX "database_restore_recovery_actions_job_status_idx"
ON "operations"."database_restore_recovery_actions"("job_id", "status");
CREATE INDEX "database_restore_recovery_actions_status_expiry_idx"
ON "operations"."database_restore_recovery_actions"("status", "expires_at");
CREATE UNIQUE INDEX "database_restore_recovery_actions_active_job_unique"
ON "operations"."database_restore_recovery_actions"("job_id")
WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED');

REVOKE ALL ON TABLE
    "operations"."database_restore_permits",
    "operations"."database_restore_terminal_receipts",
    "operations"."database_restore_recovery_actions"
FROM PUBLIC;

DO $database_restore_role_grants$
BEGIN
    IF to_regrole('winwidget_operations_runtime') IS NOT NULL THEN
        GRANT SELECT, INSERT, UPDATE
        ON TABLE "operations"."database_restore_permits"
        TO "winwidget_operations_runtime";
        GRANT SELECT, INSERT
        ON TABLE "operations"."database_restore_terminal_receipts"
        TO "winwidget_operations_runtime";
        GRANT SELECT, INSERT, UPDATE
        ON TABLE "operations"."database_restore_recovery_actions"
        TO "winwidget_operations_runtime";
    END IF;
    IF to_regrole('winwidget_operations_backup') IS NOT NULL THEN
        GRANT SELECT
        ON TABLE
            "operations"."database_restore_permits",
            "operations"."database_restore_terminal_receipts",
            "operations"."database_restore_recovery_actions"
        TO "winwidget_operations_backup";
    END IF;
END
$database_restore_role_grants$;

CREATE FUNCTION "operations"."prevent_database_restore_terminal_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $immutable_receipt$
BEGIN
    RAISE EXCEPTION 'Database restore terminal receipts are immutable';
END
$immutable_receipt$;

REVOKE ALL ON FUNCTION "operations"."prevent_database_restore_terminal_receipt_mutation"() FROM PUBLIC;

CREATE TRIGGER "database_restore_terminal_receipts_immutable"
BEFORE UPDATE OR DELETE ON "operations"."database_restore_terminal_receipts"
FOR EACH ROW
EXECUTE FUNCTION "operations"."prevent_database_restore_terminal_receipt_mutation"();

COMMIT;
