BEGIN;

DO $reject_legacy_unsigned_restore_evidence$
BEGIN
    IF EXISTS (SELECT 1 FROM "operations"."database_restore_jobs")
        OR EXISTS (SELECT 1 FROM "operations"."database_restore_permits")
        OR EXISTS (SELECT 1 FROM "operations"."database_restore_terminal_receipts") THEN
        RAISE EXCEPTION 'Unsigned legacy database restore evidence must be archived before applying backup provenance';
    END IF;
END
$reject_legacy_unsigned_restore_evidence$;

ALTER TABLE "operations"."database_restore_jobs"
DROP CONSTRAINT "database_restore_jobs_permit_fkey";

ALTER TABLE "operations"."database_restore_release_authorizations"
DROP CONSTRAINT "database_restore_release_authorizations_job_fkey";

ALTER TABLE "operations"."database_restore_release_authorizations"
DROP CONSTRAINT "database_restore_release_authorizations_action_fkey",
DROP CONSTRAINT "database_restore_release_authorizations_permit_fkey";

ALTER TABLE "operations"."database_restore_terminal_receipts"
DROP CONSTRAINT "database_restore_terminal_receipts_job_fkey";

DROP INDEX "operations"."database_restore_jobs_exact_permit_binding_unique";
DROP INDEX "operations"."database_restore_permits_exact_binding_unique";

ALTER TABLE "operations"."database_restore_jobs"
ADD COLUMN "source_backup_job_id" UUID NOT NULL,
ADD COLUMN "backup_provenance" TEXT NOT NULL,
ADD COLUMN "backup_provenance_envelope_sha256" TEXT NOT NULL,
ADD COLUMN "backup_provenance_key_id" TEXT NOT NULL;

ALTER TABLE "operations"."database_restore_permits"
ADD COLUMN "source_size" BIGINT NOT NULL,
ADD COLUMN "source_backup_job_id" UUID NOT NULL,
ADD COLUMN "backup_provenance" TEXT NOT NULL,
ADD COLUMN "backup_provenance_envelope_sha256" TEXT NOT NULL,
ADD COLUMN "backup_provenance_key_id" TEXT NOT NULL;

ALTER TABLE "operations"."database_restore_terminal_receipts"
ADD COLUMN "source_size" BIGINT NOT NULL,
ADD COLUMN "source_backup_job_id" UUID NOT NULL,
ADD COLUMN "backup_provenance_envelope_sha256" TEXT NOT NULL,
ADD COLUMN "backup_provenance_key_id" TEXT NOT NULL;

ALTER TABLE "operations"."database_restore_release_authorizations"
ADD COLUMN "source_size" BIGINT NOT NULL,
ADD COLUMN "source_backup_job_id" UUID NOT NULL,
ADD COLUMN "backup_provenance_envelope_sha256" TEXT NOT NULL,
ADD COLUMN "backup_provenance_key_id" TEXT NOT NULL;

ALTER TABLE "operations"."database_restore_jobs"
ADD CONSTRAINT "database_restore_jobs_provenance_check" CHECK (
    "source_size" > 0
    AND "source_size" <= 51380224
    AND "backup_provenance_envelope_sha256" ~ '^[0-9a-f]{64}$'
    AND "backup_provenance_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'
    AND octet_length("backup_provenance") BETWEEN 1 AND 16384
);

ALTER TABLE "operations"."database_restore_permits"
ADD CONSTRAINT "database_restore_permits_provenance_check" CHECK (
    "source_size" > 0
    AND "source_size" <= 51380224
    AND "backup_provenance_envelope_sha256" ~ '^[0-9a-f]{64}$'
    AND "backup_provenance_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'
    AND octet_length("backup_provenance") BETWEEN 1 AND 16384
);

ALTER TABLE "operations"."database_restore_terminal_receipts"
ADD CONSTRAINT "database_restore_terminal_receipts_provenance_check" CHECK (
    "source_size" > 0
    AND "source_size" <= 51380224
    AND "backup_provenance_envelope_sha256" ~ '^[0-9a-f]{64}$'
    AND "backup_provenance_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'
);

ALTER TABLE "operations"."database_restore_terminal_receipts"
DROP CONSTRAINT "database_restore_terminal_receipts_release_authorization",
ADD CONSTRAINT "database_restore_terminal_receipts_release_authorization" CHECK (
    ("terminal_status" = 'SUCCEEDED'
        AND "release_authorization_payload_sha256" IS NOT NULL
        AND "release_authorization_payload_sha256" ~ '^[0-9a-f]{64}$')
    OR ("terminal_status" <> 'SUCCEEDED'
        AND "release_authorization_payload_sha256" IS NULL)
);

ALTER TABLE "operations"."database_restore_release_authorizations"
ADD CONSTRAINT "database_restore_release_authorizations_provenance_check" CHECK (
    "source_size" > 0
    AND "source_size" <= 51380224
    AND "backup_provenance_envelope_sha256" ~ '^[0-9a-f]{64}$'
    AND "backup_provenance_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'
);

CREATE UNIQUE INDEX "database_restore_permits_exact_binding_unique"
ON "operations"."database_restore_permits" (
    "id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
);

CREATE UNIQUE INDEX "database_restore_jobs_exact_permit_binding_unique"
ON "operations"."database_restore_jobs" (
    "permit_id",
    "id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
);

CREATE UNIQUE INDEX "database_restore_jobs_exact_release_binding_unique"
ON "operations"."database_restore_jobs" (
    "id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
);

CREATE UNIQUE INDEX "database_restore_recovery_actions_exact_release_binding_unique"
ON "operations"."database_restore_recovery_actions" (
    "id",
    "job_id",
    "action",
    "receipt_payload_sha"
);

CREATE UNIQUE INDEX "database_restore_terminal_receipts_exact_job_binding_unique"
ON "operations"."database_restore_terminal_receipts" (
    "permit_id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
);

CREATE UNIQUE INDEX "database_restore_release_auth_exact_action_binding_unique"
ON "operations"."database_restore_release_authorizations" (
    "action_id",
    "job_id",
    "recovery_action",
    "initial_receipt_payload_sha256"
);

CREATE UNIQUE INDEX "database_restore_release_auth_exact_permit_binding_unique"
ON "operations"."database_restore_release_authorizations" (
    "permit_id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
);

ALTER TABLE "operations"."database_restore_jobs"
ADD CONSTRAINT "database_restore_jobs_permit_fkey"
FOREIGN KEY (
    "permit_id",
    "id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
REFERENCES "operations"."database_restore_permits" (
    "id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
ON DELETE RESTRICT
ON UPDATE RESTRICT;

ALTER TABLE "operations"."database_restore_permits"
ADD CONSTRAINT "database_restore_permits_source_backup_job_fkey"
FOREIGN KEY ("source_backup_job_id")
REFERENCES "operations"."scheduled_job_runs" ("id")
ON DELETE RESTRICT
ON UPDATE RESTRICT;

ALTER TABLE "operations"."database_restore_terminal_receipts"
ADD CONSTRAINT "database_restore_terminal_receipts_job_fkey"
FOREIGN KEY (
    "permit_id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
REFERENCES "operations"."database_restore_jobs" (
    "permit_id",
    "id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
ON DELETE RESTRICT
ON UPDATE RESTRICT;

ALTER TABLE "operations"."database_restore_release_authorizations"
ADD CONSTRAINT "database_restore_release_authorizations_job_fkey"
FOREIGN KEY (
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
REFERENCES "operations"."database_restore_jobs" (
    "id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
ON DELETE RESTRICT
ON UPDATE RESTRICT;

ALTER TABLE "operations"."database_restore_release_authorizations"
ADD CONSTRAINT "database_restore_release_authorizations_permit_fkey"
FOREIGN KEY (
    "permit_id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
REFERENCES "operations"."database_restore_permits" (
    "id",
    "job_id",
    "target",
    "source_sha256",
    "source_size",
    "source_backup_job_id",
    "backup_provenance_envelope_sha256",
    "backup_provenance_key_id",
    "expected_services_sha",
    "migration_manifest_sha"
)
ON DELETE RESTRICT
ON UPDATE RESTRICT;

ALTER TABLE "operations"."database_restore_release_authorizations"
ADD CONSTRAINT "database_restore_release_authorizations_action_fkey"
FOREIGN KEY (
    "action_id",
    "job_id",
    "recovery_action",
    "initial_receipt_payload_sha256"
)
REFERENCES "operations"."database_restore_recovery_actions" (
    "id",
    "job_id",
    "action",
    "receipt_payload_sha"
)
ON DELETE RESTRICT
ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "operations"."protect_database_restore_permit_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $protect_restore_permit_binding$
BEGIN
    IF NEW.job_id IS DISTINCT FROM OLD.job_id
        OR NEW.target IS DISTINCT FROM OLD.target
        OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
        OR NEW.source_size IS DISTINCT FROM OLD.source_size
        OR NEW.source_backup_job_id IS DISTINCT FROM OLD.source_backup_job_id
        OR NEW.backup_provenance IS DISTINCT FROM OLD.backup_provenance
        OR NEW.backup_provenance_envelope_sha256 IS DISTINCT FROM OLD.backup_provenance_envelope_sha256
        OR NEW.backup_provenance_key_id IS DISTINCT FROM OLD.backup_provenance_key_id
        OR NEW.expected_services_sha IS DISTINCT FROM OLD.expected_services_sha
        OR NEW.migration_manifest_sha IS DISTINCT FROM OLD.migration_manifest_sha
        OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Database restore permit binding is immutable';
    END IF;
    IF OLD.status <> 'PENDING_APPROVAL' AND (
        NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    ) THEN
        RAISE EXCEPTION 'Database restore permit approval evidence is immutable';
    END IF;
    IF OLD.status IN ('CONSUMED', 'CLOSED') AND
        NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
        RAISE EXCEPTION 'Database restore permit consumption evidence is immutable';
    END IF;
    IF OLD.status = 'CLOSED' AND (
        NEW.closed_at IS DISTINCT FROM OLD.closed_at
        OR NEW.close_reason IS DISTINCT FROM OLD.close_reason
        OR NEW.status IS DISTINCT FROM OLD.status
    ) THEN
        RAISE EXCEPTION 'Database restore closed permit is immutable';
    END IF;
    RETURN NEW;
END
$protect_restore_permit_binding$;

CREATE FUNCTION "operations"."protect_database_restore_job_provenance"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $protect_restore_job_provenance$
BEGIN
    IF NEW.source_size IS DISTINCT FROM OLD.source_size
        OR NEW.source_backup_job_id IS DISTINCT FROM OLD.source_backup_job_id
        OR NEW.backup_provenance IS DISTINCT FROM OLD.backup_provenance
        OR NEW.backup_provenance_envelope_sha256 IS DISTINCT FROM OLD.backup_provenance_envelope_sha256
        OR NEW.backup_provenance_key_id IS DISTINCT FROM OLD.backup_provenance_key_id THEN
        RAISE EXCEPTION 'Database restore job provenance is immutable';
    END IF;
    RETURN NEW;
END
$protect_restore_job_provenance$;
REVOKE ALL ON FUNCTION "operations"."protect_database_restore_job_provenance"() FROM PUBLIC;
CREATE TRIGGER "database_restore_jobs_immutable_provenance"
BEFORE UPDATE ON "operations"."database_restore_jobs"
FOR EACH ROW
EXECUTE FUNCTION "operations"."protect_database_restore_job_provenance"();

COMMIT;
