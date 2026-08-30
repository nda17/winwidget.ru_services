BEGIN;

DROP INDEX "operations"."database_restore_permits_target_active_unique";
CREATE UNIQUE INDEX "database_restore_permits_global_active_unique"
ON "operations"."database_restore_permits"((1))
WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED', 'CONSUMED');

ALTER TABLE "operations"."database_restore_jobs"
ADD COLUMN "recovery_resolved_at" TIMESTAMP(3),
ADD COLUMN "artifact_retain_until" TIMESTAMP(3),
ADD COLUMN "writer_fence_roles" JSONB,
ADD COLUMN "writer_fence_requested_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_applied_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_released_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_evidence_sha256" TEXT,
ADD COLUMN "writer_fence_release_evidence_sha256" TEXT,
ADD CONSTRAINT "database_restore_jobs_writer_fence_hashes" CHECK (
    ("writer_fence_evidence_sha256" IS NULL OR "writer_fence_evidence_sha256" ~ '^[0-9a-f]{64}$')
    AND ("writer_fence_release_evidence_sha256" IS NULL OR "writer_fence_release_evidence_sha256" ~ '^[0-9a-f]{64}$')
),
ADD CONSTRAINT "database_restore_jobs_writer_fence_shape" CHECK (
    ("writer_fence_roles" IS NULL AND "writer_fence_requested_at" IS NULL AND "writer_fence_applied_at" IS NULL
        AND "writer_fence_released_at" IS NULL AND "writer_fence_evidence_sha256" IS NULL
        AND "writer_fence_release_evidence_sha256" IS NULL)
    OR
    (jsonb_typeof("writer_fence_roles") = 'array' AND jsonb_array_length("writer_fence_roles") = 3
        AND "writer_fence_requested_at" IS NOT NULL
        AND ("writer_fence_applied_at" IS NULL OR "writer_fence_applied_at" >= "writer_fence_requested_at")
        AND ("writer_fence_applied_at" IS NULL) = ("writer_fence_evidence_sha256" IS NULL)
        AND ("writer_fence_released_at" IS NULL OR ("writer_fence_applied_at" IS NOT NULL AND "writer_fence_released_at" >= "writer_fence_applied_at"))
        AND ("writer_fence_released_at" IS NULL) = ("writer_fence_release_evidence_sha256" IS NULL))
),
ADD CONSTRAINT "database_restore_jobs_writer_fence_exact_roles" CHECK (
    "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    AND ("writer_fence_roles" IS NULL OR "writer_fence_roles" = CASE "target"
        WHEN 'notification-delivery' THEN '["winwidget_notification_delivery_runtime","winwidget_notification_delivery_migration","winwidget_notification_delivery_backup"]'::jsonb
        WHEN 'campaigns' THEN '["winwidget_campaigns_runtime","winwidget_campaigns_migration","winwidget_campaigns_backup"]'::jsonb
        WHEN 'reporting' THEN '["winwidget_reporting_runtime","winwidget_reporting_migration","winwidget_reporting_backup"]'::jsonb
        WHEN 'widgets' THEN '["winwidget_widgets_runtime","winwidget_widgets_migration","winwidget_widgets_backup"]'::jsonb
        WHEN 'identity' THEN '["winwidget_identity_runtime","winwidget_identity_migration","winwidget_identity_backup"]'::jsonb
        WHEN 'platform' THEN '["winwidget_platform_runtime","winwidget_platform_migration","winwidget_platform_backup"]'::jsonb
        WHEN 'support' THEN '["winwidget_support_runtime","winwidget_support_migration","winwidget_support_backup"]'::jsonb
        ELSE '[]'::jsonb
    END)
),
ADD CONSTRAINT "database_restore_jobs_recovery_resolution_shape" CHECK (
    "recovery_resolved_at" IS NULL
    OR ("status" = 'RECOVERY_REQUIRED' AND "recovery_resolved_at" IS NOT NULL)
),
ADD CONSTRAINT "database_restore_jobs_artifact_retention_shape" CHECK (
    "artifact_retain_until" IS NULL
    OR ("status" = 'SUCCEEDED' AND "finished_at" IS NOT NULL
        AND "artifact_retain_until" >= "finished_at")
    OR ("status" = 'RECOVERY_REQUIRED' AND "recovery_resolved_at" IS NOT NULL
        AND "artifact_retain_until" >= "recovery_resolved_at")
);

DROP INDEX "operations"."database_restore_jobs_target_fence";
CREATE UNIQUE INDEX "database_restore_jobs_target_fence"
ON "operations"."database_restore_jobs"("target")
WHERE "status" IN ('QUEUED', 'PROCESSING')
    OR ("status" = 'RECOVERY_REQUIRED' AND "recovery_resolved_at" IS NULL);

ALTER TABLE "operations"."database_restore_terminal_receipts"
ADD COLUMN "permit_id" UUID NOT NULL,
ADD COLUMN "permit_requested_by_id" TEXT NOT NULL,
ADD COLUMN "permit_approved_by_id" TEXT NOT NULL,
ADD COLUMN "permit_created_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN "permit_approved_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN "permit_expires_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN "permit_consumed_at" TIMESTAMP(3) NOT NULL,
ADD COLUMN "writer_fence_roles" JSONB,
ADD COLUMN "writer_fence_requested_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_applied_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_released_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_evidence_sha256" TEXT,
ADD COLUMN "writer_fence_release_evidence_sha256" TEXT,
ADD CONSTRAINT "database_restore_terminal_receipts_writer_fence_hashes" CHECK (
    ("writer_fence_evidence_sha256" IS NULL OR "writer_fence_evidence_sha256" ~ '^[0-9a-f]{64}$')
    AND ("writer_fence_release_evidence_sha256" IS NULL OR "writer_fence_release_evidence_sha256" ~ '^[0-9a-f]{64}$')
),
ADD CONSTRAINT "database_restore_terminal_receipts_permit_fkey" FOREIGN KEY ("permit_id")
    REFERENCES "operations"."database_restore_permits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "database_restore_terminal_receipts_permit_actors" CHECK (
    "permit_requested_by_id" <> "permit_approved_by_id"
),
ADD CONSTRAINT "database_restore_terminal_receipts_permit_timestamps" CHECK (
    "permit_approved_at" >= "permit_created_at"
    AND "permit_consumed_at" >= "permit_approved_at"
    AND "permit_consumed_at" <= "permit_expires_at"
),
ADD CONSTRAINT "database_restore_terminal_receipts_writer_fence_exact_roles" CHECK (
    "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    AND ("writer_fence_roles" IS NULL OR (
        jsonb_typeof("writer_fence_roles") = 'array'
        AND jsonb_array_length("writer_fence_roles") = 3
        AND "writer_fence_roles" = CASE "target"
            WHEN 'notification-delivery' THEN '["winwidget_notification_delivery_runtime","winwidget_notification_delivery_migration","winwidget_notification_delivery_backup"]'::jsonb
            WHEN 'campaigns' THEN '["winwidget_campaigns_runtime","winwidget_campaigns_migration","winwidget_campaigns_backup"]'::jsonb
            WHEN 'reporting' THEN '["winwidget_reporting_runtime","winwidget_reporting_migration","winwidget_reporting_backup"]'::jsonb
            WHEN 'widgets' THEN '["winwidget_widgets_runtime","winwidget_widgets_migration","winwidget_widgets_backup"]'::jsonb
            WHEN 'identity' THEN '["winwidget_identity_runtime","winwidget_identity_migration","winwidget_identity_backup"]'::jsonb
            WHEN 'platform' THEN '["winwidget_platform_runtime","winwidget_platform_migration","winwidget_platform_backup"]'::jsonb
            WHEN 'support' THEN '["winwidget_support_runtime","winwidget_support_migration","winwidget_support_backup"]'::jsonb
            ELSE '[]'::jsonb
        END
    ))
);

ALTER TABLE "operations"."database_restore_recovery_actions"
ADD COLUMN "phase" "operations"."DatabaseRestoreRecoveryActionPhase",
ADD COLUMN "event_id" UUID,
ADD COLUMN "lease_owner" TEXT,
ADD COLUMN "lease_token" UUID,
ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "artifact_sha256" TEXT,
ADD COLUMN "writer_fence_roles" JSONB,
ADD COLUMN "writer_fence_requested_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_applied_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_released_at" TIMESTAMP(3),
ADD COLUMN "writer_fence_evidence_sha256" TEXT,
ADD COLUMN "writer_fence_release_evidence_sha256" TEXT,
ADD COLUMN "result" JSONB,
ADD COLUMN "last_error" TEXT,
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "finished_at" TIMESTAMP(3),
ADD CONSTRAINT "database_restore_recovery_actions_attempts_nonnegative" CHECK ("attempts" >= 0),
ADD CONSTRAINT "database_restore_recovery_actions_artifact_sha" CHECK ("artifact_sha256" IS NULL OR "artifact_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "database_restore_recovery_actions_fence_hashes" CHECK (
    ("writer_fence_evidence_sha256" IS NULL OR "writer_fence_evidence_sha256" ~ '^[0-9a-f]{64}$')
    AND ("writer_fence_release_evidence_sha256" IS NULL OR "writer_fence_release_evidence_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "operations"."database_restore_recovery_actions"
DROP CONSTRAINT "database_restore_recovery_actions_state_shape",
ADD CONSTRAINT "database_restore_recovery_actions_state_shape" CHECK (
    ("status" = 'PENDING_APPROVAL' AND "approved_by_id" IS NULL AND "approved_at" IS NULL
        AND "event_id" IS NULL AND "phase" IS NULL AND "lease_token" IS NULL AND "finished_at" IS NULL)
    OR ("status" = 'APPROVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "event_id" IS NOT NULL AND "phase" IS NULL AND "lease_token" IS NULL AND "finished_at" IS NULL)
    OR ("status" = 'PROCESSING' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "event_id" IS NOT NULL AND "phase" IS NOT NULL AND "lease_owner" IS NOT NULL
        AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "started_at" IS NOT NULL
        AND "finished_at" IS NULL)
    OR ("status" = 'RESOLVED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "event_id" IS NOT NULL AND "phase" = 'RESOLVED' AND "lease_owner" IS NULL
        AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "finished_at" IS NOT NULL
        AND "last_error" IS NULL)
    OR ("status" = 'BLOCKED' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL
        AND "event_id" IS NOT NULL AND "phase" IS NOT NULL AND "lease_owner" IS NULL
        AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "finished_at" IS NOT NULL
        AND "last_error" IS NOT NULL)
    OR ("status" = 'EXPIRED' AND "lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
),
ADD CONSTRAINT "database_restore_recovery_actions_fence_shape" CHECK (
    ("writer_fence_roles" IS NULL AND "writer_fence_requested_at" IS NULL AND "writer_fence_applied_at" IS NULL
        AND "writer_fence_released_at" IS NULL AND "writer_fence_evidence_sha256" IS NULL
        AND "writer_fence_release_evidence_sha256" IS NULL)
    OR
    (jsonb_typeof("writer_fence_roles") = 'array' AND jsonb_array_length("writer_fence_roles") = 3
        AND "writer_fence_requested_at" IS NOT NULL
        AND ("writer_fence_applied_at" IS NULL OR "writer_fence_applied_at" >= "writer_fence_requested_at")
        AND ("writer_fence_applied_at" IS NULL) = ("writer_fence_evidence_sha256" IS NULL)
        AND ("writer_fence_released_at" IS NULL OR ("writer_fence_applied_at" IS NOT NULL AND "writer_fence_released_at" >= "writer_fence_applied_at"))
        AND ("writer_fence_released_at" IS NULL) = ("writer_fence_release_evidence_sha256" IS NULL))
);

CREATE UNIQUE INDEX "database_restore_recovery_actions_event_id_unique"
ON "operations"."database_restore_recovery_actions"("event_id") WHERE "event_id" IS NOT NULL;
CREATE INDEX "database_restore_recovery_actions_processing_lease_idx"
ON "operations"."database_restore_recovery_actions"("status", "lease_expires_at");
DROP INDEX "operations"."database_restore_recovery_actions_active_job_unique";
CREATE UNIQUE INDEX "database_restore_recovery_actions_active_job_unique"
ON "operations"."database_restore_recovery_actions"("job_id")
WHERE "status" IN ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING');

CREATE TABLE "operations"."database_restore_execution_lease" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "operation_type" "operations"."DatabaseRestoreExecutionOperationType",
    "operation_id" UUID,
    "lease_owner" TEXT,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "database_restore_execution_lease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_execution_lease_singleton" CHECK ("id" = 'singleton'),
    CONSTRAINT "database_restore_execution_lease_shape" CHECK (
        ("operation_type" IS NULL AND "operation_id" IS NULL AND "lease_owner" IS NULL
            AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
        OR ("operation_type" IS NOT NULL AND "operation_id" IS NOT NULL AND "lease_owner" IS NOT NULL
            AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    )
);
INSERT INTO "operations"."database_restore_execution_lease" ("id", "updated_at")
VALUES ('singleton', CURRENT_TIMESTAMP);

CREATE TABLE "operations"."database_restore_recovery_receipts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "action_id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "action" "operations"."DatabaseRestoreRecoveryActionType" NOT NULL,
    "initial_receipt_payload_sha" TEXT NOT NULL,
    "artifact_sha256" TEXT,
    "expected_services_sha" TEXT NOT NULL,
    "migration_manifest_sha" TEXT NOT NULL,
    "writer_fence_roles" JSONB NOT NULL,
    "writer_fence_applied_at" TIMESTAMP(3) NOT NULL,
    "writer_fence_released_at" TIMESTAMP(3) NOT NULL,
    "writer_fence_evidence_sha256" TEXT NOT NULL,
    "writer_fence_release_evidence_sha256" TEXT NOT NULL,
    "result_sha256" TEXT NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "signature_hmac_sha256" TEXT NOT NULL,
    "signature_key_id" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "database_restore_recovery_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_recovery_receipts_target" CHECK (
        "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    ),
    CONSTRAINT "database_restore_recovery_receipts_job_fkey" FOREIGN KEY ("job_id")
        REFERENCES "operations"."database_restore_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_recovery_receipts_action_fkey" FOREIGN KEY ("action_id")
        REFERENCES "operations"."database_restore_recovery_actions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_recovery_receipts_sha_shape" CHECK (
        "initial_receipt_payload_sha" ~ '^[0-9a-f]{64}$'
        AND ("artifact_sha256" IS NULL OR "artifact_sha256" ~ '^[0-9a-f]{64}$')
        AND "expected_services_sha" ~ '^[0-9a-f]{40}$'
        AND "migration_manifest_sha" ~ '^[0-9a-f]{64}$'
        AND "writer_fence_evidence_sha256" ~ '^[0-9a-f]{64}$'
        AND "writer_fence_release_evidence_sha256" ~ '^[0-9a-f]{64}$'
        AND "result_sha256" ~ '^[0-9a-f]{64}$'
        AND "payload_sha256" ~ '^[0-9a-f]{64}$'
        AND "signature_hmac_sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "database_restore_recovery_receipts_key_id" CHECK ("signature_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'),
    CONSTRAINT "database_restore_recovery_receipts_roles" CHECK (
        jsonb_typeof("writer_fence_roles") = 'array' AND jsonb_array_length("writer_fence_roles") = 3
        AND "writer_fence_roles" = CASE "target"
            WHEN 'notification-delivery' THEN '["winwidget_notification_delivery_runtime","winwidget_notification_delivery_migration","winwidget_notification_delivery_backup"]'::jsonb
            WHEN 'campaigns' THEN '["winwidget_campaigns_runtime","winwidget_campaigns_migration","winwidget_campaigns_backup"]'::jsonb
            WHEN 'reporting' THEN '["winwidget_reporting_runtime","winwidget_reporting_migration","winwidget_reporting_backup"]'::jsonb
            WHEN 'widgets' THEN '["winwidget_widgets_runtime","winwidget_widgets_migration","winwidget_widgets_backup"]'::jsonb
            WHEN 'identity' THEN '["winwidget_identity_runtime","winwidget_identity_migration","winwidget_identity_backup"]'::jsonb
            WHEN 'platform' THEN '["winwidget_platform_runtime","winwidget_platform_migration","winwidget_platform_backup"]'::jsonb
            WHEN 'support' THEN '["winwidget_support_runtime","winwidget_support_migration","winwidget_support_backup"]'::jsonb
            ELSE '[]'::jsonb
        END
    ),
    CONSTRAINT "database_restore_recovery_receipts_fence_order" CHECK (
        "writer_fence_released_at" >= "writer_fence_applied_at"
    )
);
CREATE UNIQUE INDEX "database_restore_recovery_receipts_job_id_unique"
ON "operations"."database_restore_recovery_receipts"("job_id");
CREATE UNIQUE INDEX "database_restore_recovery_receipts_action_id_unique"
ON "operations"."database_restore_recovery_receipts"("action_id");

CREATE FUNCTION "operations"."validate_database_restore_recovery_action_roles"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $validate_recovery_action_roles$
DECLARE
    restore_target TEXT;
    expected_roles JSONB;
BEGIN
    IF NEW.writer_fence_roles IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT restore_job.target INTO restore_target
    FROM operations.database_restore_jobs AS restore_job
    WHERE restore_job.id = NEW.job_id;
    expected_roles := CASE restore_target
        WHEN 'notification-delivery' THEN '["winwidget_notification_delivery_runtime","winwidget_notification_delivery_migration","winwidget_notification_delivery_backup"]'::jsonb
        WHEN 'campaigns' THEN '["winwidget_campaigns_runtime","winwidget_campaigns_migration","winwidget_campaigns_backup"]'::jsonb
        WHEN 'reporting' THEN '["winwidget_reporting_runtime","winwidget_reporting_migration","winwidget_reporting_backup"]'::jsonb
        WHEN 'widgets' THEN '["winwidget_widgets_runtime","winwidget_widgets_migration","winwidget_widgets_backup"]'::jsonb
        WHEN 'identity' THEN '["winwidget_identity_runtime","winwidget_identity_migration","winwidget_identity_backup"]'::jsonb
        WHEN 'platform' THEN '["winwidget_platform_runtime","winwidget_platform_migration","winwidget_platform_backup"]'::jsonb
        WHEN 'support' THEN '["winwidget_support_runtime","winwidget_support_migration","winwidget_support_backup"]'::jsonb
        ELSE NULL
    END;
    IF expected_roles IS NULL OR NEW.writer_fence_roles <> expected_roles THEN
        RAISE EXCEPTION 'Database restore recovery action writer roles do not match target';
    END IF;
    RETURN NEW;
END
$validate_recovery_action_roles$;
REVOKE ALL ON FUNCTION "operations"."validate_database_restore_recovery_action_roles"() FROM PUBLIC;
CREATE TRIGGER "database_restore_recovery_actions_exact_roles"
BEFORE INSERT OR UPDATE OF "writer_fence_roles", "job_id"
ON "operations"."database_restore_recovery_actions"
FOR EACH ROW
EXECUTE FUNCTION "operations"."validate_database_restore_recovery_action_roles"();

CREATE FUNCTION "operations"."protect_database_restore_recovery_action_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $protect_recovery_action_binding$
BEGIN
    IF OLD.status IN ('RESOLVED', 'BLOCKED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Database restore terminal recovery action is immutable';
    END IF;
    IF NEW.job_id IS DISTINCT FROM OLD.job_id
        OR NEW.action IS DISTINCT FROM OLD.action
        OR NEW.receipt_payload_sha IS DISTINCT FROM OLD.receipt_payload_sha
        OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Database restore recovery action binding is immutable';
    END IF;
    IF OLD.status <> 'PENDING_APPROVAL' AND (
        NEW.approved_by_id IS DISTINCT FROM OLD.approved_by_id
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        OR NEW.event_id IS DISTINCT FROM OLD.event_id
    ) THEN
        RAISE EXCEPTION 'Database restore recovery approval evidence is immutable';
    END IF;
    RETURN NEW;
END
$protect_recovery_action_binding$;
REVOKE ALL ON FUNCTION "operations"."protect_database_restore_recovery_action_binding"() FROM PUBLIC;
CREATE TRIGGER "database_restore_recovery_actions_immutable_binding"
BEFORE UPDATE ON "operations"."database_restore_recovery_actions"
FOR EACH ROW
EXECUTE FUNCTION "operations"."protect_database_restore_recovery_action_binding"();

CREATE FUNCTION "operations"."protect_database_restore_recovery_resolution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $protect_recovery_resolution$
BEGIN
    IF OLD.recovery_resolved_at IS NOT NULL
        AND NEW.recovery_resolved_at IS DISTINCT FROM OLD.recovery_resolved_at THEN
        RAISE EXCEPTION 'Database restore recovery resolution is immutable';
    END IF;
    RETURN NEW;
END
$protect_recovery_resolution$;
REVOKE ALL ON FUNCTION "operations"."protect_database_restore_recovery_resolution"() FROM PUBLIC;
CREATE TRIGGER "database_restore_jobs_immutable_recovery_resolution"
BEFORE UPDATE OF "recovery_resolved_at" ON "operations"."database_restore_jobs"
FOR EACH ROW
EXECUTE FUNCTION "operations"."protect_database_restore_recovery_resolution"();

CREATE FUNCTION "operations"."protect_database_restore_permit_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $protect_restore_permit_binding$
BEGIN
    IF NEW.job_id IS DISTINCT FROM OLD.job_id
        OR NEW.target IS DISTINCT FROM OLD.target
        OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
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
REVOKE ALL ON FUNCTION "operations"."protect_database_restore_permit_binding"() FROM PUBLIC;
CREATE TRIGGER "database_restore_permits_immutable_binding"
BEFORE UPDATE ON "operations"."database_restore_permits"
FOR EACH ROW
EXECUTE FUNCTION "operations"."protect_database_restore_permit_binding"();

CREATE TRIGGER "database_restore_recovery_receipts_immutable"
BEFORE UPDATE OR DELETE ON "operations"."database_restore_recovery_receipts"
FOR EACH ROW
EXECUTE FUNCTION "operations"."prevent_database_restore_terminal_receipt_mutation"();

REVOKE ALL ON TABLE
    "operations"."database_restore_execution_lease",
    "operations"."database_restore_recovery_receipts"
FROM PUBLIC;

DO $database_restore_recovery_role_grants$
BEGIN
    IF to_regrole('winwidget_operations_runtime') IS NOT NULL THEN
        GRANT SELECT, UPDATE ON TABLE "operations"."database_restore_execution_lease"
        TO "winwidget_operations_runtime";
        GRANT SELECT, INSERT ON TABLE "operations"."database_restore_recovery_receipts"
        TO "winwidget_operations_runtime";
    END IF;
    IF to_regrole('winwidget_operations_backup') IS NOT NULL THEN
        GRANT SELECT ON TABLE
            "operations"."database_restore_execution_lease",
            "operations"."database_restore_recovery_receipts"
        TO "winwidget_operations_backup";
    END IF;
END
$database_restore_recovery_role_grants$;

COMMIT;
