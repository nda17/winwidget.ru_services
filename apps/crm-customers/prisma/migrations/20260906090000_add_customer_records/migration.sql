BEGIN;

CREATE TABLE "crm_customers"."companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL CHECK (char_length(btrim("name")) > 0 AND "name" = btrim("name")),
    "inn" VARCHAR(12) CHECK ("inn" IS NULL OR "inn" ~ '^([0-9]{10}|[0-9]{12})$'),
    "website" VARCHAR(2048),
    "notes" VARCHAR(5000),
    "created_by_subject" VARCHAR(256) NOT NULL CHECK (char_length("created_by_subject") > 0),
    "team_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "companies_workspace_id_id_key" ON "crm_customers"."companies"("workspace_id", "id");
CREATE INDEX "companies_workspace_id_archived_at_created_at_id_idx" ON "crm_customers"."companies"("workspace_id", "archived_at", "created_at", "id");
CREATE INDEX "companies_workspace_id_created_by_subject_archived_at_idx" ON "crm_customers"."companies"("workspace_id", "created_by_subject", "archived_at");
CREATE INDEX "companies_workspace_id_team_id_archived_at_idx" ON "crm_customers"."companies"("workspace_id", "team_id", "archived_at");
CREATE INDEX "companies_workspace_id_inn_idx" ON "crm_customers"."companies"("workspace_id", "inn");

CREATE TABLE "crm_customers"."contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL CHECK (char_length(btrim("name")) > 0 AND "name" = btrim("name")),
    "phone" VARCHAR(16) CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$'),
    "email" VARCHAR(254),
    "company_id" UUID,
    "notes" VARCHAR(5000),
    "created_by_subject" VARCHAR(256) NOT NULL CHECK (char_length("created_by_subject") > 0),
    "team_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contacts_workspace_id_company_id_fkey" FOREIGN KEY ("workspace_id", "company_id")
        REFERENCES "crm_customers"."companies"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "contacts_workspace_id_archived_at_created_at_id_idx" ON "crm_customers"."contacts"("workspace_id", "archived_at", "created_at", "id");
CREATE INDEX "contacts_workspace_id_created_by_subject_archived_at_idx" ON "crm_customers"."contacts"("workspace_id", "created_by_subject", "archived_at");
CREATE INDEX "contacts_workspace_id_team_id_archived_at_idx" ON "crm_customers"."contacts"("workspace_id", "team_id", "archived_at");
CREATE INDEX "contacts_workspace_id_phone_idx" ON "crm_customers"."contacts"("workspace_id", "phone");
CREATE INDEX "contacts_workspace_id_email_idx" ON "crm_customers"."contacts"("workspace_id", "email");
CREATE INDEX "contacts_workspace_id_company_id_idx" ON "crm_customers"."contacts"("workspace_id", "company_id");

CREATE TABLE "crm_customers"."customer_commands" (
    "command_id" UUID NOT NULL PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_kind" VARCHAR(16) NOT NULL CHECK ("entity_kind" IN ('contact', 'company')),
    "actor_subject" VARCHAR(256) NOT NULL CHECK (char_length("actor_subject") > 0),
    "request_hash" CHAR(64) NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    "response" JSONB NOT NULL CHECK (jsonb_typeof("response") = 'object'),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "customer_commands_workspace_id_entity_id_idx" ON "crm_customers"."customer_commands"("workspace_id", "entity_id");

CREATE TABLE "crm_customers"."customer_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_kind" VARCHAR(16) NOT NULL CHECK ("entity_kind" IN ('contact', 'company')),
    "command_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL CHECK (char_length("actor_subject") > 0),
    "action" VARCHAR(16) NOT NULL CHECK ("action" IN ('CREATED', 'UPDATED', 'ARCHIVED')),
    "entity_version" INTEGER NOT NULL CHECK ("entity_version" > 0),
    "changed_fields" TEXT[] NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "customer_activities_command_id_key" ON "crm_customers"."customer_activities"("command_id");
CREATE INDEX "customer_activities_entity_created_idx" ON "crm_customers"."customer_activities"("workspace_id", "entity_kind", "entity_id", "created_at", "id");

COMMIT;
