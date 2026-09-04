BEGIN;

CREATE TYPE "crm_sales"."CrmPipelineStageState" AS ENUM ('OPEN', 'WON', 'LOST');

CREATE TABLE "crm_sales"."pipelines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "template_key" VARCHAR(64) NOT NULL,
    "template_version" SMALLINT NOT NULL,
    "template_fingerprint" CHAR(64) NOT NULL,
    "installed_by_subject" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pipelines_name_check" CHECK (
        char_length("name") BETWEEN 1 AND 200
        AND "name" = btrim("name")
    ),
    CONSTRAINT "pipelines_template_key_check" CHECK (
        "template_key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    ),
    CONSTRAINT "pipelines_template_version_check" CHECK (
        "template_version" > 0
    ),
    CONSTRAINT "pipelines_template_fingerprint_check" CHECK (
        "template_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "pipelines_installed_by_subject_check" CHECK (
        char_length("installed_by_subject") BETWEEN 1 AND 256
        AND "installed_by_subject" = btrim("installed_by_subject")
    )
);

CREATE TABLE "crm_sales"."pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pipeline_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "position" SMALLINT NOT NULL,
    "state" "crm_sales"."CrmPipelineStageState" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pipeline_stages_key_check" CHECK (
        "key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    ),
    CONSTRAINT "pipeline_stages_name_check" CHECK (
        char_length("name") BETWEEN 1 AND 200
        AND "name" = btrim("name")
    ),
    CONSTRAINT "pipeline_stages_position_check" CHECK ("position" > 0)
);

CREATE TABLE "crm_sales"."pipeline_template_installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "initial_command_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "template_key" VARCHAR(64) NOT NULL,
    "template_version" SMALLINT NOT NULL,
    "template_fingerprint" CHAR(64) NOT NULL,
    "installed_by_subject" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_template_installations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pipeline_template_installations_template_key_check" CHECK (
        "template_key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
    ),
    CONSTRAINT "pipeline_template_installations_template_version_check" CHECK (
        "template_version" > 0
    ),
    CONSTRAINT "pipeline_template_installations_fingerprint_check" CHECK (
        "template_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "pipeline_template_installations_subject_check" CHECK (
        char_length("installed_by_subject") BETWEEN 1 AND 256
        AND "installed_by_subject" = btrim("installed_by_subject")
    )
);

CREATE TABLE "crm_sales"."pipeline_template_installation_commands" (
    "command_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "request_hash_version" SMALLINT NOT NULL DEFAULT 1,
    "requested_by_subject" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pipeline_template_installation_commands_pkey" PRIMARY KEY ("command_id"),
    CONSTRAINT "pipeline_template_installation_commands_request_hash_check" CHECK (
        "request_hash" ~ '^[0-9a-f]{64}$'
        AND "request_hash_version" = 1
    ),
    CONSTRAINT "pipeline_template_installation_commands_subject_check" CHECK (
        char_length("requested_by_subject") BETWEEN 1 AND 256
        AND "requested_by_subject" = btrim("requested_by_subject")
    )
);

CREATE INDEX "pipelines_workspace_id_created_at_idx"
    ON "crm_sales"."pipelines"("workspace_id", "created_at");
CREATE UNIQUE INDEX "pipelines_id_workspace_id_key"
    ON "crm_sales"."pipelines"("id", "workspace_id");
CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_key_key"
    ON "crm_sales"."pipeline_stages"("pipeline_id", "key");
CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_position_key"
    ON "crm_sales"."pipeline_stages"("pipeline_id", "position");
CREATE UNIQUE INDEX "pipeline_template_installations_workspace_id_key"
    ON "crm_sales"."pipeline_template_installations"("workspace_id");
CREATE UNIQUE INDEX "pipeline_template_installations_initial_command_id_key"
    ON "crm_sales"."pipeline_template_installations"("initial_command_id");
CREATE UNIQUE INDEX "pipeline_template_installations_pipeline_id_key"
    ON "crm_sales"."pipeline_template_installations"("pipeline_id");
CREATE UNIQUE INDEX "pipeline_template_installations_pipeline_id_workspace_id_key"
    ON "crm_sales"."pipeline_template_installations"("pipeline_id", "workspace_id");
CREATE INDEX "pipeline_template_installation_commands_installation_id_created_at_idx"
    ON "crm_sales"."pipeline_template_installation_commands"("installation_id", "created_at");

ALTER TABLE "crm_sales"."pipeline_stages"
    ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey"
    FOREIGN KEY ("pipeline_id", "workspace_id")
    REFERENCES "crm_sales"."pipelines"("id", "workspace_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crm_sales"."pipeline_template_installations"
    ADD CONSTRAINT "pipeline_template_installations_pipeline_id_fkey"
    FOREIGN KEY ("pipeline_id", "workspace_id")
    REFERENCES "crm_sales"."pipelines"("id", "workspace_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "crm_sales"."pipeline_template_installation_commands"
    ADD CONSTRAINT "pipeline_template_installation_commands_installation_id_fkey"
    FOREIGN KEY ("installation_id")
    REFERENCES "crm_sales"."pipeline_template_installations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
