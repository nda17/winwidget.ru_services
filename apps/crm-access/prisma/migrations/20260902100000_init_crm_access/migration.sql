BEGIN;

DO $$
BEGIN
    IF to_regnamespace('crm_access') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "crm_access"';
    END IF;
END
$$;

CREATE TYPE "crm_access"."CrmAccessLifecycle" AS ENUM ('ONBOARDING', 'ACTIVE', 'READ_ONLY', 'SUSPENDED');

CREATE TABLE "crm_access"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'crm-access-service',
    "database_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_identity_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "service_identity_name_check" CHECK ("service_name" = 'crm-access-service')
);

CREATE TABLE "crm_access"."crm_workspace_access" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "lifecycle" "crm_access"."CrmAccessLifecycle" NOT NULL DEFAULT 'ONBOARDING',
    "activated_by_subject" VARCHAR(256) NOT NULL,
    "trial_activation_command_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_workspace_access_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "crm_workspace_access_subject_check" CHECK (
        char_length("activated_by_subject") BETWEEN 1 AND 256
        AND "activated_by_subject" = btrim("activated_by_subject")
    )
);

CREATE UNIQUE INDEX "service_identity_database_id_key"
    ON "crm_access"."service_identity"("database_id");
CREATE UNIQUE INDEX "crm_workspace_access_workspace_id_key"
    ON "crm_access"."crm_workspace_access"("workspace_id");
CREATE UNIQUE INDEX "crm_workspace_access_trial_activation_command_id_key"
    ON "crm_access"."crm_workspace_access"("trial_activation_command_id");
CREATE INDEX "crm_workspace_access_lifecycle_updated_at_idx"
    ON "crm_access"."crm_workspace_access"("lifecycle", "updated_at");

INSERT INTO "crm_access"."service_identity" ("id", "service_name")
VALUES ('singleton', 'crm-access-service');

COMMIT;
