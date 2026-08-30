BEGIN;

LOCK TABLE "operations"."database_restore_jobs" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "operations"."database_restore_jobs"
        WHERE "status" IN ('QUEUED', 'PROCESSING', 'FAILED')
    ) THEN
        RAISE EXCEPTION 'Cannot migrate database restore state while legacy QUEUED, PROCESSING, or FAILED jobs exist';
    END IF;
END
$$;

ALTER TYPE "operations"."DatabaseRestoreJobStatus" ADD VALUE 'RECOVERY_REQUIRED';

CREATE TYPE "operations"."DatabaseRestoreJobPhase" AS ENUM (
    'PREPARING',
    'SAFETY_READY',
    'MUTATING',
    'VERIFIED'
);

ALTER TABLE "operations"."database_restore_jobs"
ADD COLUMN "phase" "operations"."DatabaseRestoreJobPhase",
ADD COLUMN "event_id" UUID,
ADD COLUMN "lease_owner" TEXT,
ADD COLUMN "lease_token" UUID,
ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "safety_backup_file_name" TEXT,
ADD COLUMN "safety_backup_sha256" TEXT,
ADD COLUMN "source_deleted_at" TIMESTAMP(3),
ADD COLUMN "safety_deleted_at" TIMESTAMP(3),
ADD COLUMN "cleanup_error" TEXT;

UPDATE "operations"."database_restore_jobs"
SET "event_id" = "id"
WHERE "event_id" IS NULL;

ALTER TABLE "operations"."database_restore_jobs"
ALTER COLUMN "event_id" SET NOT NULL;

ALTER TABLE "operations"."database_restore_jobs"
ADD CONSTRAINT "database_restore_jobs_attempts_nonnegative"
CHECK ("attempts" >= 0),
ADD CONSTRAINT "database_restore_jobs_lease_shape"
CHECK (
    ("status" = 'PROCESSING' AND "phase" IS NOT NULL AND "event_id" IS NOT NULL AND "lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR
    ("status" <> 'PROCESSING' AND "lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
),
ADD CONSTRAINT "database_restore_jobs_safety_sha256"
CHECK ("safety_backup_sha256" IS NULL OR "safety_backup_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "database_restore_jobs_safety_pair"
CHECK (("safety_backup_file_name" IS NULL) = ("safety_backup_sha256" IS NULL));

CREATE UNIQUE INDEX "database_restore_jobs_event_id_unique"
ON "operations"."database_restore_jobs"("event_id");

CREATE UNIQUE INDEX "database_restore_jobs_single_processing"
ON "operations"."database_restore_jobs"("status")
WHERE "status" = 'PROCESSING';

CREATE INDEX "database_restore_jobs_processing_lease_idx"
ON "operations"."database_restore_jobs"("status", "lease_expires_at");

COMMIT;
