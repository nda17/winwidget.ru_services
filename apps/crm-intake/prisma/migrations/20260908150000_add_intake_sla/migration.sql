-- Additive Intake-owned foundation. Disabled unless an explicit rule and runtime gate exist.
CREATE TABLE crm_intake.sla_rules (
 workspace_id UUID PRIMARY KEY,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object' AND config ? 'enabled' AND config->'enabled' = to_jsonb(enabled)),
 owner_binding JSONB NOT NULL CHECK (jsonb_typeof(owner_binding) = 'object' AND owner_binding ?& ARRAY['subject','membershipId']),
 effective_at TIMESTAMP(3) NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE crm_intake.sla_commands (
 command_id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL,
 actor_subject VARCHAR(256) NOT NULL CHECK (length(actor_subject) > 0),
 action VARCHAR(24) NOT NULL CHECK (action IN ('RULE_SAVED','JOB_RETRIED')),
 entity_id UUID NOT NULL,
 request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 response JSONB NOT NULL,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX sla_commands_workspace_id_created_at_command_id_idx ON crm_intake.sla_commands(workspace_id,created_at,command_id);
CREATE TABLE crm_intake.sla_jobs (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES crm_intake.sla_rules(workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 entry_id UUID NOT NULL,
 rule_version INTEGER NOT NULL CHECK (rule_version > 0),
 generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
 recipient_cursor UUID,
 active_event_id UUID NOT NULL UNIQUE,
 due_at TIMESTAMP(3) NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','BREACHED','CANCELLED','DEAD')),
 breached_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,entry_id,rule_version),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,entry_id) REFERENCES crm_intake.inbox_entries(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK (status <> 'BREACHED' OR breached_at IS NOT NULL)
);
CREATE INDEX sla_jobs_workspace_id_status_due_at_id_idx ON crm_intake.sla_jobs(workspace_id,status,due_at,id);
CREATE TABLE crm_intake.sla_notifications (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL,
 job_id UUID NOT NULL,
 recipient_subject VARCHAR(256) NOT NULL CHECK (length(recipient_subject) > 0),
 recipient_membership_id UUID,
 channel VARCHAR(16) NOT NULL CHECK (channel IN ('EMAIL','TELEGRAM')),
 deduplication_key CHAR(64) NOT NULL UNIQUE CHECK (deduplication_key ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(workspace_id,job_id) REFERENCES crm_intake.sla_jobs(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX sla_notifications_workspace_id_job_id_idx ON crm_intake.sla_notifications(workspace_id,job_id);
CREATE TABLE crm_intake.sla_receipts (
 event_id UUID NOT NULL,
 consumer VARCHAR(64) NOT NULL,
 workspace_id UUID NOT NULL,
 job_id UUID NOT NULL,
 payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 status VARCHAR(24) NOT NULL CHECK (status IN ('PROCESSING','DELIVERED','RETRY_SCHEDULED','DEAD_LETTERED')),
 lease_token UUID,
 lease_until TIMESTAMP(3),
 retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(event_id,consumer),
 CHECK ((status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK (status = 'PROCESSING' OR (lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX sla_receipts_status_lease_until_idx ON crm_intake.sla_receipts(status,lease_until);
CREATE TABLE crm_intake.sla_outbox (
 id UUID PRIMARY KEY,
 event_id UUID NOT NULL,
 deduplication_key VARCHAR(256) NOT NULL UNIQUE,
 route VARCHAR(16) NOT NULL DEFAULT 'MAIN' CHECK (route IN ('MAIN','DLQ','ND_EMAIL','ND_TELEGRAM')),
 payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PUBLISHING','PUBLISHED')),
 available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token UUID,
 lease_until TIMESTAMP(3),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt BETWEEN 0 AND 3),
 last_error_code VARCHAR(64),
 published_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((status = 'PUBLISHING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK (status = 'PUBLISHING' OR (lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX sla_outbox_status_available_at_id_idx ON crm_intake.sla_outbox(status,available_at,id);

-- Covers manual/API/CSV/Widgets and every acceptance path without changing their ownership or visibility.
CREATE FUNCTION crm_intake.cancel_entry_sla() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status <> 'NEW' OR EXISTS (
  SELECT 1 FROM crm_intake.acceptances a WHERE a.workspace_id=NEW.workspace_id AND a.entry_id=NEW.id
 ) THEN
  UPDATE crm_intake.sla_jobs SET status = 'CANCELLED', updated_at = clock_timestamp() AT TIME ZONE 'UTC'
   WHERE workspace_id = NEW.workspace_id AND entry_id = NEW.id AND status <> 'CANCELLED';
 END IF;
 RETURN NEW;
END $$;
-- Acceptance commits its request and increments entry.version while status is still NEW.
CREATE TRIGGER inbox_entries_cancel_sla AFTER UPDATE OF status,version ON crm_intake.inbox_entries
 FOR EACH ROW EXECUTE FUNCTION crm_intake.cancel_entry_sla();

CREATE FUNCTION crm_intake.sla_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'sla_jobs' THEN
 IF
  ROW(NEW.id,NEW.workspace_id,NEW.entry_id,NEW.rule_version,NEW.due_at,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.entry_id,OLD.rule_version,OLD.due_at,OLD.created_at) THEN
  RAISE EXCEPTION 'immutable SLA job binding';
 END IF;
 ELSIF TG_TABLE_NAME = 'sla_receipts' THEN
 IF
  ROW(NEW.event_id,NEW.consumer,NEW.workspace_id,NEW.job_id,NEW.payload_hash,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.event_id,OLD.consumer,OLD.workspace_id,OLD.job_id,OLD.payload_hash,OLD.created_at) THEN
  RAISE EXCEPTION 'immutable SLA receipt binding';
 END IF;
 ELSIF TG_TABLE_NAME = 'sla_outbox' THEN
 IF
  ROW(NEW.id,NEW.event_id,NEW.deduplication_key,NEW.route,NEW.payload,NEW.retry_attempt,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.event_id,OLD.deduplication_key,OLD.route,OLD.payload,OLD.retry_attempt,OLD.created_at) THEN
  RAISE EXCEPTION 'immutable SLA Outbox binding';
 END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sla_jobs_immutable BEFORE UPDATE ON crm_intake.sla_jobs FOR EACH ROW EXECUTE FUNCTION crm_intake.sla_immutable();
CREATE TRIGGER sla_receipts_immutable BEFORE UPDATE ON crm_intake.sla_receipts FOR EACH ROW EXECUTE FUNCTION crm_intake.sla_immutable();
CREATE TRIGGER sla_outbox_immutable BEFORE UPDATE ON crm_intake.sla_outbox FOR EACH ROW EXECUTE FUNCTION crm_intake.sla_immutable();
