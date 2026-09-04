BEGIN;

CREATE TYPE "crm_access"."CrmMemberRole" AS ENUM ('CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST');

CREATE TABLE "crm_access"."crm_workspace_members" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "subject" VARCHAR(256) NOT NULL,
  "membership_id" UUID NOT NULL,
  "role" "crm_access"."CrmMemberRole" NOT NULL,
  "team_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "disabled_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_workspace_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crm_workspace_members_subject_check" CHECK (length("subject") BETWEEN 1 AND 256 AND "subject" = btrim("subject")),
  CONSTRAINT "crm_workspace_members_version_check" CHECK ("version" > 0),
  CONSTRAINT "crm_workspace_members_team_limit_check" CHECK (cardinality("team_ids") <= 1000)
);
CREATE UNIQUE INDEX "crm_workspace_members_workspace_id_subject_key" ON "crm_access"."crm_workspace_members" ("workspace_id", "subject");
CREATE UNIQUE INDEX "crm_workspace_members_workspace_id_membership_id_key" ON "crm_access"."crm_workspace_members" ("workspace_id", "membership_id");
CREATE INDEX "crm_workspace_members_workspace_id_disabled_at_idx" ON "crm_access"."crm_workspace_members" ("workspace_id", "disabled_at");

COMMIT;
