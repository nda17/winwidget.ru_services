CREATE UNIQUE INDEX contacts_workspace_id_id_key ON crm_customers.contacts(workspace_id, id);
CREATE TABLE crm_customers.intake_operation_slots (
  operation_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  workflow_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL CHECK(char_length(actor_subject) > 0),
  payload_hash CHAR(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  state VARCHAR(16) NOT NULL CHECK(state IN ('COMMITTED', 'CANCELLED')),
  contact_id UUID,
  result JSONB,
  committed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, workflow_id),
  FOREIGN KEY(workspace_id, contact_id) REFERENCES crm_customers.contacts(workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK((state = 'COMMITTED' AND contact_id IS NOT NULL AND committed_at IS NOT NULL AND result IS NOT NULL AND jsonb_typeof(result) = 'object' AND result ? 'contactId' AND result->>'contactId' = contact_id::text) OR (state = 'CANCELLED' AND contact_id IS NULL AND committed_at IS NULL AND result IS NULL))
);
CREATE TABLE crm_customers.intake_operation_commands (
  command_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL CHECK(char_length(actor_subject) > 0),
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL CHECK(jsonb_typeof(result) = 'object'),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
