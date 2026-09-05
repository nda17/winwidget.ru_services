CREATE TABLE crm_intake.acceptances (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL CHECK(char_length(actor_subject)>0),
  status VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','RETRY_WAIT','BLOCKED','FAILED','RECOVERING','CANCELLED','COMPLETED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
  mode VARCHAR(16) NOT NULL DEFAULT 'EXECUTE' CHECK(mode IN ('EXECUTE','RECOVER')),
  contact_operation_id UUID NOT NULL UNIQUE,
  sales_operation_id UUID NOT NULL UNIQUE,
  contact_command_id UUID NOT NULL UNIQUE,
  sales_command_id UUID NOT NULL UNIQUE,
  contact_payload JSONB NOT NULL CHECK(jsonb_typeof(contact_payload)='object'),
  sales_payload JSONB NOT NULL CHECK(jsonb_typeof(sales_payload)='object'),
  contact_payload_hash CHAR(64) NOT NULL CHECK(contact_payload_hash ~ '^[a-f0-9]{64}$'),
  sales_payload_hash CHAR(64) NOT NULL CHECK(sales_payload_hash ~ '^[a-f0-9]{64}$'),
  contact_proof JSONB,
  sales_proof JSONB,
  contact_id UUID,
  deal_id UUID,
  first_task_id UUID,
  recovery_subject VARCHAR(256),
  recovery_contact_command_id UUID,
  recovery_sales_command_id UUID,
  last_error_code VARCHAR(64),
  retry_at TIMESTAMP(3),
  completed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(workspace_id, entry_id) REFERENCES crm_intake.inbox_entries(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK(status <> 'COMPLETED' OR (contact_id IS NOT NULL AND deal_id IS NOT NULL AND first_task_id IS NOT NULL AND contact_proof IS NOT NULL AND sales_proof IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK(mode <> 'RECOVER' OR (recovery_subject IS NOT NULL AND recovery_contact_command_id IS NOT NULL AND recovery_sales_command_id IS NOT NULL))
);
CREATE INDEX acceptances_workspace_id_entry_id_created_at_idx ON crm_intake.acceptances(workspace_id,entry_id,created_at);
CREATE UNIQUE INDEX acceptances_active_entry_key ON crm_intake.acceptances(workspace_id,entry_id) WHERE status <> 'CANCELLED';

CREATE TABLE crm_intake.acceptance_outbox (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  deduplication_key VARCHAR(256) NOT NULL UNIQUE,
  route VARCHAR(16) NOT NULL DEFAULT 'MAIN' CHECK(route IN ('MAIN','RETRY_1','RETRY_2','RETRY_3','DLQ')),
  payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHING','PUBLISHED')),
  available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_until TIMESTAMP(3),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt>=0),
  last_error_code VARCHAR(64),
  published_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((status='PUBLISHING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PUBLISHING' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX acceptance_outbox_status_available_at_id_idx ON crm_intake.acceptance_outbox(status,available_at,id);
CREATE TABLE crm_intake.acceptance_receipts (
  event_id UUID NOT NULL,
  consumer VARCHAR(80) NOT NULL,
  workspace_id UUID NOT NULL,
  workflow_id UUID NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  status VARCHAR(24) NOT NULL CHECK(status IN ('PROCESSING','DELIVERED','RETRY_SCHEDULED','DEAD_LETTERED')),
  lease_token UUID,
  lease_until TIMESTAMP(3),
  retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt>=0),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id,consumer),
  CHECK((status='PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL))
);
ALTER TABLE crm_intake.intake_activities DROP CONSTRAINT intake_activities_action_check;
ALTER TABLE crm_intake.intake_activities ADD CONSTRAINT intake_activities_action_check CHECK(action IN ('CREATED','REJECTED','SOURCE_CREATED','SOURCE_TOKEN_ROTATED','SOURCE_REVOKED','ACCEPTANCE_REQUESTED','ACCEPTANCE_RETRIED','ACCEPTANCE_RECOVERY_REQUESTED','ACCEPTANCE_CANCELLED','ACCEPTED'));
