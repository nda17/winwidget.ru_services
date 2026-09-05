BEGIN;
DO $legacy_teams$
BEGIN
  IF EXISTS (SELECT 1 FROM crm_access.crm_workspace_members WHERE cardinality(team_ids) > 0) THEN
    RAISE EXCEPTION 'Explicit owner-local team mapping is required before replacing legacy team_ids';
  END IF;
END
$legacy_teams$;

-- AlterTable
ALTER TABLE "crm_access"."crm_workspace_members" DROP COLUMN "team_ids";

-- CreateTable
CREATE TABLE "crm_access"."crm_teams" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_member_teams" (
    "workspace_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,

    CONSTRAINT "crm_member_teams_pkey" PRIMARY KEY ("member_id","team_id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_invitation_intents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "crm_access"."CrmMemberRole" NOT NULL,
    "team_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "inviter_subject" VARCHAR(256) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'REGISTERING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "identity_version" INTEGER,
    "provisioning_command_id" UUID NOT NULL,
    "revoke_command_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_invitation_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_admissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "intent_id" UUID,
    "source_acceptance_id" UUID,
    "member_id" UUID,
    "expected_member_version" INTEGER,
    "subject" VARCHAR(256) NOT NULL,
    "membership_id" UUID NOT NULL,
    "requested_by_subject" VARCHAR(256) NOT NULL,
    "position" BIGSERIAL NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'WAITING',
    "activated_at" TIMESTAMP(3),
    "cancellation_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_team_command_receipts" (
    "command_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL,
    "command_type" VARCHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_team_command_receipts_pkey" PRIMARY KEY ("command_id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_team_audit" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_subject" VARCHAR(256) NOT NULL,
    "command_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_id" UUID NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_team_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_team_outbox" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "deduplication_key" VARCHAR(256) NOT NULL,
    "exchange" VARCHAR(64) NOT NULL DEFAULT 'winwidget.events',
    "event_type" VARCHAR(100) NOT NULL,
    "routing_key" VARCHAR(150) NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "last_error" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_team_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_access"."crm_team_deliveries" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "consumer" VARCHAR(64) NOT NULL,
    "workspace_id" UUID,
    "payload_hash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PROCESSING',
    "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "retry_attempt" INTEGER NOT NULL DEFAULT 0,
    "manual_retry_cycle" INTEGER NOT NULL DEFAULT 0,
    "delivered_at" TIMESTAMP(3),
    "last_error" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_team_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_teams_workspace_id_archived_at_idx" ON "crm_access"."crm_teams"("workspace_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_teams_id_workspace_id_key" ON "crm_access"."crm_teams"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "crm_member_teams_workspace_id_team_id_idx" ON "crm_access"."crm_member_teams"("workspace_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_invitation_intents_provisioning_command_id_key" ON "crm_access"."crm_invitation_intents"("provisioning_command_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_invitation_intents_revoke_command_id_key" ON "crm_access"."crm_invitation_intents"("revoke_command_id");

-- CreateIndex
CREATE INDEX "crm_invitation_intents_workspace_id_status_created_at_idx" ON "crm_access"."crm_invitation_intents"("workspace_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_invitation_intents_id_workspace_id_key" ON "crm_access"."crm_invitation_intents"("id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_admissions_intent_id_key" ON "crm_access"."crm_admissions"("intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_admissions_source_acceptance_id_key" ON "crm_access"."crm_admissions"("source_acceptance_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_admissions_position_key" ON "crm_access"."crm_admissions"("position");

-- CreateIndex
CREATE INDEX "crm_admissions_workspace_id_status_position_idx" ON "crm_access"."crm_admissions"("workspace_id", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "crm_team_audit_command_id_key" ON "crm_access"."crm_team_audit"("command_id");

-- CreateIndex
CREATE INDEX "crm_team_audit_workspace_id_created_at_idx" ON "crm_access"."crm_team_audit"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_team_outbox_deduplication_key_key" ON "crm_access"."crm_team_outbox"("deduplication_key");

-- CreateIndex
CREATE INDEX "crm_team_outbox_status_available_at_created_at_idx" ON "crm_access"."crm_team_outbox"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "crm_team_deliveries_workspace_id_status_updated_at_idx" ON "crm_access"."crm_team_deliveries"("workspace_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_team_deliveries_event_id_consumer_key" ON "crm_access"."crm_team_deliveries"("event_id", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "crm_workspace_members_id_workspace_id_key" ON "crm_access"."crm_workspace_members"("id", "workspace_id");

-- AddForeignKey
ALTER TABLE "crm_access"."crm_member_teams" ADD CONSTRAINT "crm_member_teams_member_id_workspace_id_fkey" FOREIGN KEY ("member_id", "workspace_id") REFERENCES "crm_access"."crm_workspace_members"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_access"."crm_member_teams" ADD CONSTRAINT "crm_member_teams_team_id_workspace_id_fkey" FOREIGN KEY ("team_id", "workspace_id") REFERENCES "crm_access"."crm_teams"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE crm_access.crm_workspace_members ADD CONSTRAINT crm_workspace_members_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT;
ALTER TABLE crm_access.crm_teams
  ADD CONSTRAINT crm_teams_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_teams_name_check CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT crm_teams_version_check CHECK (version > 0);
CREATE UNIQUE INDEX crm_teams_active_name_key ON crm_access.crm_teams(workspace_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE crm_access.crm_invitation_intents ALTER COLUMN team_ids SET NOT NULL;
ALTER TABLE crm_access.crm_invitation_intents
  ADD CONSTRAINT crm_invitation_intents_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_invitation_intents_version_check CHECK (version > 0 AND (identity_version IS NULL OR identity_version > 0)),
  ADD CONSTRAINT crm_invitation_intents_email_check CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  ADD CONSTRAINT crm_invitation_intents_status_check CHECK (status IN ('REGISTERING', 'INVITED', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  ADD CONSTRAINT crm_invitation_intents_teams_check CHECK (cardinality(team_ids) <= 1000),
  ADD CONSTRAINT crm_invitation_intents_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days'),
  ADD CONSTRAINT crm_invitation_intents_revoke_check CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoke_command_id IS NOT NULL));
CREATE UNIQUE INDEX crm_invitation_intents_active_email_key ON crm_access.crm_invitation_intents(workspace_id, email) WHERE status IN ('REGISTERING','INVITED');

ALTER TABLE crm_access.crm_admissions
  ADD CONSTRAINT crm_admissions_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_admissions_intent_workspace_fkey FOREIGN KEY (intent_id, workspace_id) REFERENCES crm_access.crm_invitation_intents(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_admissions_member_workspace_fkey FOREIGN KEY (member_id, workspace_id) REFERENCES crm_access.crm_workspace_members(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_admissions_status_check CHECK (status IN ('WAITING', 'ACTIVE', 'CANCELLED')),
  ADD CONSTRAINT crm_admissions_activation_check CHECK ((status = 'ACTIVE') = (activated_at IS NOT NULL)),
  ADD CONSTRAINT crm_admissions_origin_check CHECK (
    (intent_id IS NOT NULL AND source_acceptance_id IS NOT NULL AND expected_member_version IS NULL)
    OR (intent_id IS NULL AND source_acceptance_id IS NULL AND member_id IS NOT NULL AND expected_member_version IS NOT NULL AND expected_member_version > 0)
  );
CREATE UNIQUE INDEX crm_admissions_waiting_subject_key ON crm_access.crm_admissions(workspace_id, subject) WHERE status = 'WAITING';

ALTER TABLE crm_access.crm_team_outbox
  ADD CONSTRAINT crm_team_outbox_status_check CHECK (status IN ('PENDING','PROCESSING','PUBLISHED')),
  ADD CONSTRAINT crm_team_outbox_exchange_check CHECK (exchange IN ('winwidget.events','winwidget.retry','winwidget.dead-letter','winwidget.manual-retry')),
  ADD CONSTRAINT crm_team_outbox_attempts_check CHECK (attempts >= 0);
ALTER TABLE crm_access.crm_team_deliveries
  ADD CONSTRAINT crm_team_deliveries_status_check CHECK (status IN ('PROCESSING','RETRY_SCHEDULED','DELIVERED','DEAD_LETTERED')),
  ADD CONSTRAINT crm_team_deliveries_attempts_check CHECK (retry_attempt >= 0 AND manual_retry_cycle >= 0);

CREATE FUNCTION crm_access.reject_team_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $history$
BEGIN
  RAISE EXCEPTION 'WinCRM team audit and command receipts are append-only';
END
$history$;
CREATE TRIGGER crm_team_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON crm_access.crm_team_audit FOR EACH STATEMENT EXECUTE FUNCTION crm_access.reject_team_history_mutation();
CREATE TRIGGER crm_team_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON crm_access.crm_team_command_receipts FOR EACH STATEMENT EXECUTE FUNCTION crm_access.reject_team_history_mutation();

COMMIT;
