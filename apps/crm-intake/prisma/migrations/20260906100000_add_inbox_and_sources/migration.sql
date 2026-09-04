BEGIN;

CREATE TABLE "crm_intake"."intake_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL CHECK (char_length(btrim("name")) > 0 AND "name" = btrim("name")),
    "kind" VARCHAR(16) NOT NULL DEFAULT 'API' CHECK ("kind" = 'API'),
    "token_hash" CHAR(64) NOT NULL CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    "token_version" INTEGER NOT NULL DEFAULT 1 CHECK ("token_version" > 0),
    "created_by_subject" VARCHAR(256) NOT NULL CHECK (char_length("created_by_subject") > 0),
    "team_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "intake_sources_token_hash_key" ON "crm_intake"."intake_sources"("token_hash");
CREATE UNIQUE INDEX "intake_sources_workspace_id_id_key" ON "crm_intake"."intake_sources"("workspace_id", "id");
CREATE INDEX "intake_sources_workspace_id_created_at_id_idx" ON "crm_intake"."intake_sources"("workspace_id", "created_at", "id");

CREATE TABLE "crm_intake"."inbox_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL CHECK (char_length(btrim("title")) > 0 AND "title" = btrim("title")),
    "name" VARCHAR(200) NOT NULL CHECK (char_length(btrim("name")) > 0 AND "name" = btrim("name")),
    "phone" VARCHAR(16) CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$'),
    "email" VARCHAR(254),
    "message" VARCHAR(5000),
    "origin" VARCHAR(16) NOT NULL CHECK ("origin" IN ('MANUAL', 'API')),
    "source_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'NEW' CHECK ("status" IN ('NEW', 'ACCEPTED', 'REJECTED')),
    "created_by_subject" VARCHAR(256) NOT NULL CHECK (char_length("created_by_subject") > 0),
    "team_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
    "contact_id" UUID,
    "deal_id" UUID,
    "rejection_reason" VARCHAR(2000),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    CONSTRAINT "inbox_entries_workspace_id_source_id_fkey" FOREIGN KEY ("workspace_id", "source_id") REFERENCES "crm_intake"."intake_sources"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "inbox_entries_origin_source_check" CHECK (("origin" = 'MANUAL' AND "source_id" IS NULL) OR ("origin" = 'API' AND "source_id" IS NOT NULL)),
    CONSTRAINT "inbox_entries_outcome_check" CHECK (
        ("status" = 'NEW' AND "contact_id" IS NULL AND "deal_id" IS NULL AND "accepted_at" IS NULL AND "rejected_at" IS NULL AND "rejection_reason" IS NULL)
        OR ("status" = 'ACCEPTED' AND "contact_id" IS NOT NULL AND "deal_id" IS NOT NULL AND "accepted_at" IS NOT NULL AND "rejected_at" IS NULL AND "rejection_reason" IS NULL)
        OR ("status" = 'REJECTED' AND "contact_id" IS NULL AND "deal_id" IS NULL AND "accepted_at" IS NULL AND "rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL AND char_length(btrim("rejection_reason")) > 0)
    )
);
CREATE INDEX "inbox_entries_workspace_id_status_received_at_id_idx" ON "crm_intake"."inbox_entries"("workspace_id", "status", "received_at", "id");
CREATE INDEX "inbox_entries_workspace_id_created_by_subject_status_idx" ON "crm_intake"."inbox_entries"("workspace_id", "created_by_subject", "status");
CREATE INDEX "inbox_entries_workspace_id_team_id_status_idx" ON "crm_intake"."inbox_entries"("workspace_id", "team_id", "status");
CREATE INDEX "inbox_entries_workspace_id_source_id_idx" ON "crm_intake"."inbox_entries"("workspace_id", "source_id");

CREATE TABLE "crm_intake"."intake_commands" (
    "command_id" UUID NOT NULL PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_kind" VARCHAR(16) NOT NULL CHECK ("entity_kind" IN ('entry', 'source')),
    "actor_subject" VARCHAR(256) NOT NULL CHECK (char_length("actor_subject") > 0),
    "request_hash" CHAR(64) NOT NULL CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    "response" JSONB NOT NULL CHECK (jsonb_typeof("response") = 'object'),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "intake_commands_workspace_id_entity_id_idx" ON "crm_intake"."intake_commands"("workspace_id", "entity_id");

CREATE TABLE "crm_intake"."intake_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "workspace_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_kind" VARCHAR(16) NOT NULL CHECK ("entity_kind" IN ('entry', 'source')),
    "command_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL CHECK (char_length("actor_subject") > 0),
    "action" VARCHAR(32) NOT NULL CHECK ("action" IN ('CREATED', 'REJECTED', 'SOURCE_CREATED', 'SOURCE_TOKEN_ROTATED', 'SOURCE_REVOKED')),
    "entity_version" INTEGER NOT NULL CHECK ("entity_version" > 0),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "intake_activities_command_id_key" ON "crm_intake"."intake_activities"("command_id");
CREATE INDEX "intake_activities_entity_created_idx" ON "crm_intake"."intake_activities"("workspace_id", "entity_kind", "entity_id", "created_at", "id");

COMMIT;
