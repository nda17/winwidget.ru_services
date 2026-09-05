BEGIN;

ALTER TABLE crm_sales.deals ADD CONSTRAINT deals_id_workspace_id_contact_id_key UNIQUE (id, workspace_id, contact_id);

CREATE TABLE crm_sales.intake_operation_slots (
  operation_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  workflow_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL CHECK (actor_subject ~ '^[^[:space:][:cntrl:]]{1,256}$'),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  state VARCHAR(16) NOT NULL CHECK (state IN ('COMMITTED', 'CANCELLED')),
  contact_id UUID,
  deal_id UUID,
  first_task_id UUID,
  committed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT intake_operation_slots_workspace_id_workflow_id_key UNIQUE (workspace_id, workflow_id),
  CONSTRAINT intake_operation_slots_committed_check CHECK (
    (state = 'COMMITTED' AND contact_id IS NOT NULL AND deal_id IS NOT NULL AND first_task_id IS NOT NULL AND committed_at IS NOT NULL)
    OR (state = 'CANCELLED' AND contact_id IS NULL AND deal_id IS NULL AND first_task_id IS NULL AND committed_at IS NULL)
  ),
  CONSTRAINT intake_operation_slots_deal_id_workspace_id_contact_id_fkey FOREIGN KEY (deal_id, workspace_id, contact_id)
    REFERENCES crm_sales.deals(id, workspace_id, contact_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT intake_operation_slots_first_task_id_deal_id_workspace_id_fkey FOREIGN KEY (first_task_id, deal_id, workspace_id)
    REFERENCES crm_sales.tasks(id, deal_id, workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE crm_sales.intake_operation_commands (
  command_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL CHECK (actor_subject ~ '^[^[:space:][:cntrl:]]{1,256}$'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION crm_sales.reject_intake_proof_mutation() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Intake operation proofs are append-only' USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION crm_sales.reject_intake_proof_mutation() FROM PUBLIC;
CREATE TRIGGER intake_operation_slots_append_only BEFORE UPDATE OR DELETE ON crm_sales.intake_operation_slots
  FOR EACH ROW EXECUTE FUNCTION crm_sales.reject_intake_proof_mutation();
CREATE TRIGGER intake_operation_slots_no_truncate BEFORE TRUNCATE ON crm_sales.intake_operation_slots
  FOR EACH STATEMENT EXECUTE FUNCTION crm_sales.reject_intake_proof_mutation();
CREATE TRIGGER intake_operation_commands_append_only BEFORE UPDATE OR DELETE ON crm_sales.intake_operation_commands
  FOR EACH ROW EXECUTE FUNCTION crm_sales.reject_intake_proof_mutation();
CREATE TRIGGER intake_operation_commands_no_truncate BEFORE TRUNCATE ON crm_sales.intake_operation_commands
  FOR EACH STATEMENT EXECUTE FUNCTION crm_sales.reject_intake_proof_mutation();

COMMIT;
