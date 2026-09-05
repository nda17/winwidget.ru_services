BEGIN;
ALTER TABLE crm_intake.inbox_entries ALTER COLUMN name DROP NOT NULL;
ALTER TABLE crm_intake.inbox_entries ADD COLUMN widget_source_id UUID;
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_widget_source_fkey FOREIGN KEY(workspace_id,widget_source_id) REFERENCES crm_intake.managed_widget_sources(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE crm_intake.inbox_entries DROP CONSTRAINT inbox_entries_origin_check;
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_origin_check CHECK(origin IN ('MANUAL','API','CSV','WIDGET'));
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_widget_name_check CHECK(name IS NOT NULL OR origin='WIDGET');
ALTER TABLE crm_intake.inbox_entries DROP CONSTRAINT inbox_entries_origin_source_check;
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_origin_source_check CHECK(
 (origin IN ('MANUAL','CSV') AND source_id IS NULL AND widget_source_id IS NULL) OR
 (origin='API' AND source_id IS NOT NULL AND widget_source_id IS NULL) OR
 (origin='WIDGET' AND source_id IS NULL AND widget_source_id IS NOT NULL));
CREATE INDEX inbox_entries_workspace_id_widget_source_id_idx ON crm_intake.inbox_entries(workspace_id,widget_source_id);
ALTER TABLE crm_intake.intake_commands DROP CONSTRAINT intake_commands_entity_kind_check;
ALTER TABLE crm_intake.intake_commands ADD CONSTRAINT intake_commands_entity_kind_check CHECK(entity_kind IN ('entry','source','import','widget-source','widget-transfer'));
ALTER TABLE crm_intake.intake_activities DROP CONSTRAINT intake_activities_entity_kind_check;
ALTER TABLE crm_intake.intake_activities ADD CONSTRAINT intake_activities_entity_kind_check CHECK(entity_kind IN ('entry','source','widget-source','widget-transfer'));
ALTER TABLE crm_intake.intake_activities DROP CONSTRAINT intake_activities_action_check;
ALTER TABLE crm_intake.intake_activities ADD CONSTRAINT intake_activities_action_check CHECK(action IN ('CREATED','REJECTED','SOURCE_CREATED','SOURCE_TOKEN_ROTATED','SOURCE_REVOKED','ACCEPTANCE_REQUESTED','ACCEPTANCE_RETRIED','ACCEPTANCE_RECOVERY_REQUESTED','ACCEPTANCE_CANCELLED','ACCEPTED','WIDGET_SOURCE_CREATED','WIDGET_SOURCE_CONFIGURED','WIDGET_SOURCE_RETRY_QUEUED','WIDGET_TRANSFER_RETRY_QUEUED'));

CREATE TABLE crm_intake.widget_transfer_receipts (
 event_id UUID NOT NULL, consumer VARCHAR(80) NOT NULL CHECK(consumer='crm-intake.widget-transfer.v1'),
 transfer_id UUID NOT NULL, workspace_id UUID NOT NULL, source_id UUID NOT NULL, connector_id UUID NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0), actor_subject VARCHAR(256) NOT NULL, owner_subject VARCHAR(256) NOT NULL, team_id UUID,
 event JSONB NOT NULL CHECK(jsonb_typeof(event)='object'), payload_hash CHAR(64) NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'), original_deadline TIMESTAMP(3),
 status VARCHAR(24) NOT NULL CHECK(status IN ('PROCESSING','RETRY_PENDING','BLOCKED','ERROR','DELIVERED','SKIPPED')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), retry_generation INTEGER NOT NULL DEFAULT 0 CHECK(retry_generation>=0), retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt BETWEEN 0 AND 3),
 lease_token UUID, lease_until TIMESTAMP(3), entry_id UUID UNIQUE, audit_command_id UUID UNIQUE, last_error_code VARCHAR(64),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL, completed_at TIMESTAMP(3),
 PRIMARY KEY(event_id,consumer), UNIQUE(transfer_id,consumer),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_intake.managed_widget_sources(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT widget_transfer_receipts_entry_fkey FOREIGN KEY(workspace_id,entry_id) REFERENCES crm_intake.inbox_entries(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK((status='DELIVERED' AND entry_id IS NOT NULL AND audit_command_id IS NOT NULL AND completed_at IS NOT NULL AND last_error_code IS NULL) OR (status<>'DELIVERED' AND entry_id IS NULL AND audit_command_id IS NULL)),
 CHECK((status IN ('DELIVERED','SKIPPED') AND completed_at IS NOT NULL) OR (status NOT IN ('DELIVERED','SKIPPED') AND completed_at IS NULL)),
 CHECK((event->>'schemaVersion'='1' AND event->>'eventType'='widgets.wincrm.lead-transfer.requested.v1' AND event->>'eventId'=event_id::text AND event->>'transferId'=transfer_id::text AND event->>'workspaceId'=workspace_id::text AND event->>'sourceId'=source_id::text AND event->>'connectorId'=connector_id::text AND event->>'generation'=generation::text) IS TRUE)
);
CREATE INDEX widget_transfer_receipts_source_created_idx ON crm_intake.widget_transfer_receipts(workspace_id,source_id,created_at,transfer_id);
CREATE TABLE crm_intake.widget_entry_snapshots (
 entry_id UUID PRIMARY KEY, workspace_id UUID NOT NULL, source_id UUID NOT NULL, transfer_id UUID NOT NULL UNIQUE, event_id UUID NOT NULL UNIQUE,
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'), payload_hash CHAR(64) NOT NULL CHECK(payload_hash~'^[a-f0-9]{64}$'), byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 262144), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(workspace_id,entry_id),
 FOREIGN KEY(workspace_id,entry_id) REFERENCES crm_intake.inbox_entries(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_intake.managed_widget_sources(workspace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK((payload->>'schemaVersion'='1' AND jsonb_typeof(payload->'widget')='object' AND jsonb_typeof(payload->'lead')='object' AND jsonb_typeof(payload->'details')='object') IS TRUE)
);
CREATE TABLE crm_intake.widget_transfer_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID NOT NULL, deduplication_key VARCHAR(256) NOT NULL UNIQUE,
 route VARCHAR(16) NOT NULL DEFAULT 'MAIN' CHECK(route IN ('MAIN','DLQ')), payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHING','PUBLISHED')), available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token UUID, lease_until TIMESTAMP(3), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt BETWEEN 0 AND 3), retry_generation INTEGER NOT NULL DEFAULT 0 CHECK(retry_generation>=0), last_error_code VARCHAR(64), published_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='PUBLISHING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PUBLISHING' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX widget_transfer_outbox_status_available_at_id_idx ON crm_intake.widget_transfer_outbox(status,available_at,id);

CREATE FUNCTION crm_intake.widget_transfer_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_TABLE_NAME='widget_transfer_receipts' THEN
  IF (NEW.event_id,NEW.consumer,NEW.transfer_id,NEW.workspace_id,NEW.source_id,NEW.connector_id,NEW.generation,NEW.actor_subject,NEW.owner_subject,NEW.team_id,NEW.event,NEW.payload_hash,NEW.original_deadline,NEW.created_at) IS DISTINCT FROM (OLD.event_id,OLD.consumer,OLD.transfer_id,OLD.workspace_id,OLD.source_id,OLD.connector_id,OLD.generation,OLD.actor_subject,OLD.owner_subject,OLD.team_id,OLD.event,OLD.payload_hash,OLD.original_deadline,OLD.created_at) THEN RAISE EXCEPTION 'Transfer binding is immutable'; END IF;
  IF OLD.status IN ('DELIVERED','SKIPPED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Transfer terminal proof is immutable'; END IF;
  IF NEW.version<=OLD.version OR NEW.retry_generation<OLD.retry_generation THEN RAISE EXCEPTION 'Transfer version must increase'; END IF;
 ELSIF TG_TABLE_NAME='widget_entry_snapshots' THEN
  RAISE EXCEPTION 'Widget snapshot is immutable';
 ELSIF TG_TABLE_NAME='inbox_entries' THEN
  IF OLD.origin='WIDGET' AND (NEW.id,NEW.workspace_id,NEW.origin,NEW.widget_source_id,NEW.source_id,NEW.name,NEW.phone,NEW.email,NEW.message,NEW.title,NEW.created_by_subject,NEW.team_id,NEW.received_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.origin,OLD.widget_source_id,OLD.source_id,OLD.name,OLD.phone,OLD.email,OLD.message,OLD.title,OLD.created_by_subject,OLD.team_id,OLD.received_at) THEN RAISE EXCEPTION 'Received widget projection is immutable'; END IF;
 ELSIF TG_TABLE_NAME='widget_transfer_outbox' THEN
  IF (NEW.id,NEW.event_id,NEW.deduplication_key,NEW.route,NEW.payload,NEW.retry_attempt,NEW.retry_generation,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.deduplication_key,OLD.route,OLD.payload,OLD.retry_attempt,OLD.retry_generation,OLD.created_at) THEN RAISE EXCEPTION 'Transfer event is immutable'; END IF;
 END IF;
 RETURN NEW;
END;
$body$;
CREATE TRIGGER widget_transfer_receipts_immutable BEFORE UPDATE ON crm_intake.widget_transfer_receipts FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_immutable();
CREATE TRIGGER widget_entry_snapshots_immutable BEFORE UPDATE ON crm_intake.widget_entry_snapshots FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_immutable();
CREATE TRIGGER widget_transfer_outbox_immutable BEFORE UPDATE ON crm_intake.widget_transfer_outbox FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_immutable();
CREATE TRIGGER inbox_widget_projection_immutable BEFORE UPDATE ON crm_intake.inbox_entries FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_immutable();

CREATE FUNCTION crm_intake.widget_transfer_integrity() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE receipt crm_intake.widget_transfer_receipts%ROWTYPE; source crm_intake.managed_widget_sources%ROWTYPE; entry crm_intake.inbox_entries%ROWTYPE; snapshot crm_intake.widget_entry_snapshots%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='widget_transfer_receipts' THEN
  SELECT * INTO receipt FROM crm_intake.widget_transfer_receipts WHERE event_id=NEW.event_id AND consumer=NEW.consumer;
  SELECT * INTO source FROM crm_intake.managed_widget_sources WHERE id=receipt.source_id;
  IF NOT FOUND OR (receipt.workspace_id,receipt.connector_id,receipt.actor_subject,receipt.owner_subject,receipt.team_id) IS DISTINCT FROM (source.workspace_id,source.connector_id,source.created_by_subject,source.owner_subject,source.team_id) THEN RAISE EXCEPTION 'Transfer source binding mismatch'; END IF;
  IF receipt.status<>'DELIVERED' THEN RETURN NULL; END IF;
  SELECT * INTO entry FROM crm_intake.inbox_entries WHERE id=receipt.entry_id;
 ELSE
  IF TG_TABLE_NAME='inbox_entries' THEN SELECT * INTO entry FROM crm_intake.inbox_entries WHERE id=NEW.id;
  ELSE SELECT * INTO entry FROM crm_intake.inbox_entries WHERE id=NEW.entry_id; END IF;
  IF entry.origin IS DISTINCT FROM 'WIDGET' THEN RAISE EXCEPTION 'Widget snapshot requires native Inbox entry'; END IF;
  SELECT * INTO receipt FROM crm_intake.widget_transfer_receipts WHERE entry_id=entry.id;
 END IF;
 SELECT * INTO snapshot FROM crm_intake.widget_entry_snapshots WHERE entry_id=entry.id;
 SELECT * INTO source FROM crm_intake.managed_widget_sources WHERE id=receipt.source_id;
 IF entry.id IS NULL OR entry.origin<>'WIDGET' OR receipt.status IS DISTINCT FROM 'DELIVERED' OR snapshot.entry_id IS NULL OR
 (entry.workspace_id,entry.widget_source_id,entry.created_by_subject,entry.team_id) IS DISTINCT FROM (receipt.workspace_id,receipt.source_id,receipt.actor_subject,receipt.team_id) OR
 (snapshot.workspace_id,snapshot.source_id,snapshot.transfer_id,snapshot.event_id) IS DISTINCT FROM (receipt.workspace_id,receipt.source_id,receipt.transfer_id,receipt.event_id) THEN RAISE EXCEPTION 'Widget entry proof mismatch'; END IF;
 IF (snapshot.payload->'widget'->>'id'=source.widget_id AND snapshot.payload->'widget'->>'type'=source.widget_type AND snapshot.payload->'details'->>'type'=source.widget_type AND snapshot.payload->'lead'->>'createdAt'=receipt.event->>'occurredAt') IS NOT TRUE THEN RAISE EXCEPTION 'Widget payload source binding mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_intake.intake_activities WHERE command_id=receipt.audit_command_id AND workspace_id=entry.workspace_id AND entity_id=entry.id AND entity_kind='entry' AND action='CREATED' AND actor_subject=entry.created_by_subject AND entity_version=1) THEN RAISE EXCEPTION 'Widget entry audit proof missing'; END IF;
 RETURN NULL;
END;
$body$;
CREATE CONSTRAINT TRIGGER widget_transfer_receipts_integrity AFTER INSERT OR UPDATE ON crm_intake.widget_transfer_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_integrity();
CREATE CONSTRAINT TRIGGER widget_entry_snapshots_integrity AFTER INSERT OR UPDATE ON crm_intake.widget_entry_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_transfer_integrity();
CREATE CONSTRAINT TRIGGER inbox_widget_integrity AFTER INSERT OR UPDATE ON crm_intake.inbox_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.origin='WIDGET') EXECUTE FUNCTION crm_intake.widget_transfer_integrity();
REVOKE ALL ON FUNCTION crm_intake.widget_transfer_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_intake.widget_transfer_immutable() FROM PUBLIC;
COMMIT;
