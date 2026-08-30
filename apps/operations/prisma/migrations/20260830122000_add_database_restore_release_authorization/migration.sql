BEGIN;

CREATE TABLE "operations"."database_restore_release_authorizations" (
    "id" UUID NOT NULL,
    "operation_type" "operations"."DatabaseRestoreExecutionOperationType" NOT NULL,
    "operation_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "action_id" UUID,
    "permit_id" UUID,
    "event_id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "recovery_action" "operations"."DatabaseRestoreRecoveryActionType",
    "initial_receipt_payload_sha256" TEXT,
    "source_sha256" TEXT NOT NULL,
    "artifact_sha256" TEXT,
    "expected_services_sha" TEXT NOT NULL,
    "migration_manifest_sha" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "approval_evidence_sha256" TEXT NOT NULL,
    "writer_fence_roles" JSONB NOT NULL,
    "writer_fence_applied_at" TIMESTAMP(3) NOT NULL,
    "writer_fence_evidence_sha256" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "migration_ledger_sha256" TEXT NOT NULL,
    "acl_evidence_sha256" TEXT NOT NULL,
    "verified_writer_fence_sha256" TEXT NOT NULL,
    "payload_sha256" TEXT NOT NULL,
    "signature_hmac_sha256" TEXT NOT NULL,
    "signature_key_id" TEXT NOT NULL,
    "authorized_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "database_restore_release_authorizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "database_restore_release_authorizations_job_fkey" FOREIGN KEY ("job_id")
        REFERENCES "operations"."database_restore_jobs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_release_authorizations_action_fkey" FOREIGN KEY ("action_id")
        REFERENCES "operations"."database_restore_recovery_actions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_release_authorizations_permit_fkey" FOREIGN KEY ("permit_id")
        REFERENCES "operations"."database_restore_permits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "database_restore_release_authorizations_target" CHECK (
        "target" IN ('notification-delivery', 'campaigns', 'reporting', 'widgets', 'identity', 'platform', 'support')
    ),
    CONSTRAINT "database_restore_release_authorizations_operation" CHECK (
        ("operation_type" = 'RESTORE' AND "operation_id" = "job_id"
            AND "action_id" IS NULL AND "permit_id" IS NOT NULL
            AND "recovery_action" IS NULL AND "initial_receipt_payload_sha256" IS NULL
            AND "artifact_sha256" IS NOT NULL)
        OR
        ("operation_type" = 'RECOVERY' AND "operation_id" = "action_id"
            AND "action_id" IS NOT NULL AND "permit_id" IS NULL
            AND "recovery_action" IS NOT NULL AND "initial_receipt_payload_sha256" IS NOT NULL
            AND (("recovery_action" = 'VERIFY_AS_IS' AND "artifact_sha256" IS NULL)
                OR ("recovery_action" <> 'VERIFY_AS_IS' AND "artifact_sha256" IS NOT NULL)))
    ),
    CONSTRAINT "database_restore_release_authorizations_actors" CHECK (
        "requested_by_id" <> "approved_by_id"
    ),
    CONSTRAINT "database_restore_release_authorizations_hashes" CHECK (
        ("initial_receipt_payload_sha256" IS NULL OR "initial_receipt_payload_sha256" ~ '^[0-9a-f]{64}$')
        AND "source_sha256" ~ '^[0-9a-f]{64}$'
        AND ("artifact_sha256" IS NULL OR "artifact_sha256" ~ '^[0-9a-f]{64}$')
        AND "expected_services_sha" ~ '^[0-9a-f]{40}$'
        AND "migration_manifest_sha" ~ '^[0-9a-f]{64}$'
        AND "approval_evidence_sha256" ~ '^[0-9a-f]{64}$'
        AND "writer_fence_evidence_sha256" ~ '^[0-9a-f]{64}$'
        AND "migration_ledger_sha256" ~ '^[0-9a-f]{64}$'
        AND "acl_evidence_sha256" ~ '^[0-9a-f]{64}$'
        AND "verified_writer_fence_sha256" ~ '^[0-9a-f]{64}$'
        AND "payload_sha256" ~ '^[0-9a-f]{64}$'
        AND "signature_hmac_sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "database_restore_release_authorizations_key_id" CHECK (
        "signature_key_id" ~ '^[A-Za-z0-9._:-]{1,80}$'
    ),
    CONSTRAINT "database_restore_release_authorizations_time_order" CHECK (
        "verified_at" >= "writer_fence_applied_at"
        AND "verified_at" >= "approved_at"
        AND "authorized_at" >= "verified_at"
    ),
    CONSTRAINT "database_restore_release_authorizations_roles" CHECK (
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
    )
);

CREATE UNIQUE INDEX "database_restore_release_authorizations_operation_unique"
ON "operations"."database_restore_release_authorizations"("operation_type", "operation_id");
CREATE UNIQUE INDEX "database_restore_release_authorizations_action_id_unique"
ON "operations"."database_restore_release_authorizations"("action_id") WHERE "action_id" IS NOT NULL;
CREATE UNIQUE INDEX "database_restore_release_authorizations_permit_id_unique"
ON "operations"."database_restore_release_authorizations"("permit_id") WHERE "permit_id" IS NOT NULL;

ALTER TABLE "operations"."database_restore_terminal_receipts"
ADD COLUMN "release_authorization_payload_sha256" TEXT,
ADD CONSTRAINT "database_restore_terminal_receipts_release_authorization" CHECK (
    ("terminal_status" = 'SUCCEEDED' AND "release_authorization_payload_sha256" ~ '^[0-9a-f]{64}$')
    OR ("terminal_status" <> 'SUCCEEDED' AND "release_authorization_payload_sha256" IS NULL)
);

ALTER TABLE "operations"."database_restore_recovery_receipts"
ADD COLUMN "release_authorization_payload_sha256" TEXT NOT NULL,
ADD CONSTRAINT "database_restore_recovery_receipts_release_authorization" CHECK (
    "release_authorization_payload_sha256" ~ '^[0-9a-f]{64}$'
);

CREATE FUNCTION "operations"."prevent_database_restore_release_authorization_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $immutable_release_authorization$
BEGIN
    RAISE EXCEPTION 'Database restore release authorizations are immutable';
END
$immutable_release_authorization$;

REVOKE ALL ON FUNCTION "operations"."prevent_database_restore_release_authorization_mutation"() FROM PUBLIC;
CREATE TRIGGER "database_restore_release_authorizations_immutable"
BEFORE UPDATE OR DELETE ON "operations"."database_restore_release_authorizations"
FOR EACH ROW
EXECUTE FUNCTION "operations"."prevent_database_restore_release_authorization_mutation"();

REVOKE ALL ON TABLE "operations"."database_restore_release_authorizations" FROM PUBLIC;
DO $database_restore_release_authorization_grants$
BEGIN
    IF to_regrole('winwidget_operations_runtime') IS NOT NULL THEN
        GRANT SELECT, INSERT
        ON TABLE "operations"."database_restore_release_authorizations"
        TO "winwidget_operations_runtime";
    END IF;
    IF to_regrole('winwidget_operations_backup') IS NOT NULL THEN
        GRANT SELECT
        ON TABLE "operations"."database_restore_release_authorizations"
        TO "winwidget_operations_backup";
    END IF;
END
$database_restore_release_authorization_grants$;

COMMIT;
