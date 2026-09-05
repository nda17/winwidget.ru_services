BEGIN;
CREATE TABLE crm_customers.export_audit (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id UUID NOT NULL,
 actor_subject VARCHAR(256) NOT NULL CHECK (char_length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]'),
 entity VARCHAR(16) NOT NULL CHECK (entity IN ('contacts','companies')),
 format VARCHAR(4) NOT NULL CHECK (format IN ('json','csv')),
 row_count INTEGER NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
 byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 16777216),
 snapshot_at TIMESTAMP(3) NOT NULL,
 prepared_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX export_audit_workspace_prepared_idx ON crm_customers.export_audit(workspace_id, prepared_at, id);
COMMIT;

