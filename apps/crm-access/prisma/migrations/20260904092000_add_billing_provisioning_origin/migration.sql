BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "crm_access"."crm_workspace_access"
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'crm_workspace_access must be empty before adding Billing-owned provisioning provenance',
            HINT = 'WinCRM is not released. Remove non-production foundation data and rerun the migration; never invent a Billing entitlement ID.';
    END IF;
END
$$;

ALTER TABLE "crm_access"."crm_workspace_access"
    RENAME COLUMN "trial_activation_command_id" TO "provisioning_command_id";

ALTER INDEX "crm_access"."crm_workspace_access_trial_activation_command_id_key"
    RENAME TO "crm_workspace_access_provisioning_command_id_key";

ALTER TABLE "crm_access"."crm_workspace_access"
    ADD COLUMN "billing_entitlement_id" UUID NOT NULL,
    ADD COLUMN "provisioning_command_type" VARCHAR(64) NOT NULL,
    ADD CONSTRAINT "crm_workspace_access_billing_entitlement_id_key"
        UNIQUE ("billing_entitlement_id"),
    ADD CONSTRAINT "crm_workspace_access_provisioning_command_type_check"
        CHECK ("provisioning_command_type" ~ '^[A-Z][A-Z0-9_]{0,63}$');

COMMIT;
