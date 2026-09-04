BEGIN;

ALTER TABLE "crm_access"."crm_workspace_access"
    ADD COLUMN "onboarding_command_id" UUID,
    ADD COLUMN "onboarding_template_key" VARCHAR(64),
    ADD COLUMN "onboarding_template_version" SMALLINT,
    ADD COLUMN "onboarding_template_fingerprint" CHAR(64),
    ADD COLUMN "onboarding_pipeline_id" UUID,
    ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "crm_workspace_access_onboarding_command_id_key"
    ON "crm_access"."crm_workspace_access"("onboarding_command_id");

ALTER TABLE "crm_access"."crm_workspace_access"
    ADD CONSTRAINT "crm_workspace_access_onboarding_state_check" CHECK (
        (
            "lifecycle" = 'ONBOARDING'
            AND
            "onboarding_command_id" IS NULL
            AND "onboarding_template_key" IS NULL
            AND "onboarding_template_version" IS NULL
            AND "onboarding_template_fingerprint" IS NULL
            AND "onboarding_pipeline_id" IS NULL
            AND "onboarding_completed_at" IS NULL
        )
        OR (
            "lifecycle" IN ('ACTIVE', 'READ_ONLY', 'SUSPENDED')
            AND
            "onboarding_command_id" IS NOT NULL
            AND "onboarding_template_key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
            AND "onboarding_template_version" > 0
            AND "onboarding_template_fingerprint" ~ '^[0-9a-f]{64}$'
            AND "onboarding_pipeline_id" IS NOT NULL
            AND "onboarding_completed_at" IS NOT NULL
        )
    );

COMMIT;
