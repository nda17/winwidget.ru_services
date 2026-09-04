BEGIN;

CREATE TYPE "crm_sales"."SalesTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

ALTER TABLE "crm_sales"."pipeline_stages"
  ADD CONSTRAINT "pipeline_stages_id_pipeline_id_workspace_id_key" UNIQUE ("id", "pipeline_id", "workspace_id");

CREATE TABLE "crm_sales"."deals" (
  "id" UUID PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "title" VARCHAR(200) NOT NULL CHECK (length(btrim("title")) > 0),
  "currency" CHAR(3) NOT NULL DEFAULT 'RUB' CHECK ("currency" = 'RUB'),
  "amount_minor" INTEGER NOT NULL CHECK ("amount_minor" >= 0),
  "pipeline_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "status" "crm_sales"."CrmPipelineStageState" NOT NULL DEFAULT 'OPEN',
  "contact_id" UUID NOT NULL,
  "contact_name" VARCHAR(200) NOT NULL,
  "assigned_to_subject" VARCHAR(256) NOT NULL CHECK (length(btrim("assigned_to_subject")) > 0),
  "team_id" UUID,
  "next_task_id" UUID,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deals_id_workspace_id_key" UNIQUE ("id", "workspace_id"),
  CONSTRAINT "deals_pipeline_id_workspace_id_fkey" FOREIGN KEY ("pipeline_id", "workspace_id") REFERENCES "crm_sales"."pipelines"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "deals_stage_id_pipeline_id_workspace_id_fkey" FOREIGN KEY ("stage_id", "pipeline_id", "workspace_id") REFERENCES "crm_sales"."pipeline_stages"("id", "pipeline_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "deals_next_task_required_check" CHECK (
    ("status" = 'OPEN' AND "archived_at" IS NULL AND "next_task_id" IS NOT NULL)
    OR (("status" <> 'OPEN' OR "archived_at" IS NOT NULL) AND "next_task_id" IS NULL)
  )
);
CREATE INDEX "deals_workspace_id_archived_at_created_at_idx" ON "crm_sales"."deals"("workspace_id", "archived_at", "created_at");
CREATE INDEX "deals_workspace_id_assigned_to_subject_created_at_idx" ON "crm_sales"."deals"("workspace_id", "assigned_to_subject", "created_at");
CREATE INDEX "deals_workspace_id_team_id_created_at_idx" ON "crm_sales"."deals"("workspace_id", "team_id", "created_at");

CREATE TABLE "crm_sales"."tasks" (
  "id" UUID PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "deal_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "title" VARCHAR(200) NOT NULL CHECK (length(btrim("title")) > 0),
  "due_at" TIMESTAMP(3) NOT NULL,
  "status" "crm_sales"."SalesTaskStatus" NOT NULL DEFAULT 'OPEN',
  "assigned_to_subject" VARCHAR(256) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tasks_id_deal_id_workspace_id_key" UNIQUE ("id", "deal_id", "workspace_id"),
  CONSTRAINT "tasks_deal_id_workspace_id_fkey" FOREIGN KEY ("deal_id", "workspace_id") REFERENCES "crm_sales"."deals"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tasks_completed_at_check" CHECK (("status" = 'OPEN' AND "completed_at" IS NULL) OR ("status" <> 'OPEN' AND "completed_at" IS NOT NULL))
);
CREATE INDEX "tasks_workspace_id_status_due_at_idx" ON "crm_sales"."tasks"("workspace_id", "status", "due_at");
CREATE UNIQUE INDEX "tasks_one_open_per_deal" ON "crm_sales"."tasks"("workspace_id", "deal_id") WHERE "status" = 'OPEN';
ALTER TABLE "crm_sales"."deals" ADD CONSTRAINT "deals_next_task_fkey"
  FOREIGN KEY ("next_task_id", "id", "workspace_id") REFERENCES "crm_sales"."tasks"("id", "deal_id", "workspace_id") DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "crm_sales"."deal_timeline" (
  "id" UUID PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "deal_id" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL CHECK ("kind" IN ('CREATED', 'TRANSITIONED', 'TASK_COMPLETED', 'ARCHIVED')),
  "actor_subject" VARCHAR(256) NOT NULL,
  "outcome" VARCHAR(4000) NOT NULL,
  "from_stage_id" UUID,
  "to_stage_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deal_timeline_deal_id_workspace_id_fkey" FOREIGN KEY ("deal_id", "workspace_id") REFERENCES "crm_sales"."deals"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "deal_timeline_workspace_id_deal_id_created_at_idx" ON "crm_sales"."deal_timeline"("workspace_id", "deal_id", "created_at");

CREATE TABLE "crm_sales"."command_receipts" (
  "command_id" UUID PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "actor_subject" VARCHAR(256) NOT NULL,
  "command_type" VARCHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  "deal_id" UUID NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "command_receipts_deal_fkey" FOREIGN KEY ("deal_id", "workspace_id") REFERENCES "crm_sales"."deals"("id", "workspace_id") ON DELETE RESTRICT
);

CREATE FUNCTION "crm_sales"."check_sales_next_action"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  affected_id UUID;
  affected_workspace UUID;
  deal_record "crm_sales"."deals"%ROWTYPE;
  active_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'deals' THEN
    affected_id := COALESCE(NEW.id, OLD.id);
  ELSE
    affected_id := COALESCE(NEW.deal_id, OLD.deal_id);
  END IF;
  affected_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);
  SELECT * INTO deal_record FROM "crm_sales"."deals" WHERE id = affected_id AND workspace_id = affected_workspace;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM "crm_sales"."pipeline_stages" WHERE id = deal_record.stage_id AND state = deal_record.status) THEN
    RAISE EXCEPTION 'Deal status must match its pipeline stage';
  END IF;
  SELECT count(*) INTO active_count FROM "crm_sales"."tasks" WHERE deal_id = affected_id AND workspace_id = affected_workspace AND status = 'OPEN';
  IF deal_record.status = 'OPEN' AND deal_record.archived_at IS NULL THEN
    IF active_count <> 1 OR NOT EXISTS (SELECT 1 FROM "crm_sales"."tasks" WHERE id = deal_record.next_task_id AND deal_id = affected_id AND workspace_id = affected_workspace AND status = 'OPEN') THEN
      RAISE EXCEPTION 'Open deal requires exactly one current next action';
    END IF;
  ELSIF active_count <> 0 THEN
    RAISE EXCEPTION 'Closed or archived deal cannot retain an open task';
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION "crm_sales"."check_sales_next_action"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "deals_next_action_integrity" AFTER INSERT OR UPDATE ON "crm_sales"."deals" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crm_sales"."check_sales_next_action"();
CREATE CONSTRAINT TRIGGER "tasks_next_action_integrity" AFTER INSERT OR UPDATE OR DELETE ON "crm_sales"."tasks" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "crm_sales"."check_sales_next_action"();

COMMIT;
