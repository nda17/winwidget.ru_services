CREATE UNIQUE INDEX inbox_entries_workspace_id_id_key ON crm_intake.inbox_entries(workspace_id, id);

CREATE TABLE crm_intake.inbound_receipts (
  source_id UUID NOT NULL,
  external_command_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  entry_id UUID NOT NULL,
  audit_command_id UUID NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  received_at TIMESTAMP(3) NOT NULL,
  PRIMARY KEY(source_id, external_command_id),
  UNIQUE(workspace_id, entry_id),
  FOREIGN KEY(workspace_id, source_id) REFERENCES crm_intake.intake_sources(workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(workspace_id, entry_id) REFERENCES crm_intake.inbox_entries(workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE crm_intake.ingestion_rate_buckets (
  bucket_key VARCHAR(80) NOT NULL,
  window_start TIMESTAMP(3) NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0),
  PRIMARY KEY(bucket_key, window_start)
);
