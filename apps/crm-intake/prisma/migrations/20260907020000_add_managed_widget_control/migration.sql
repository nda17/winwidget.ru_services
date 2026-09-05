BEGIN;
ALTER TABLE crm_intake.intake_commands DROP CONSTRAINT intake_commands_entity_kind_check;
ALTER TABLE crm_intake.intake_commands ADD CONSTRAINT intake_commands_entity_kind_check CHECK(entity_kind IN ('entry','source','import','widget-source'));
ALTER TABLE crm_intake.intake_activities DROP CONSTRAINT intake_activities_entity_kind_check;
ALTER TABLE crm_intake.intake_activities ADD CONSTRAINT intake_activities_entity_kind_check CHECK(entity_kind IN ('entry','source','widget-source'));
ALTER TABLE crm_intake.intake_activities DROP CONSTRAINT intake_activities_action_check;
ALTER TABLE crm_intake.intake_activities ADD CONSTRAINT intake_activities_action_check CHECK(action IN ('CREATED','REJECTED','SOURCE_CREATED','SOURCE_TOKEN_ROTATED','SOURCE_REVOKED','ACCEPTANCE_REQUESTED','ACCEPTANCE_RETRIED','ACCEPTANCE_RECOVERY_REQUESTED','ACCEPTANCE_CANCELLED','ACCEPTED','WIDGET_SOURCE_CREATED','WIDGET_SOURCE_CONFIGURED','WIDGET_SOURCE_RETRY_QUEUED'));

CREATE TABLE crm_intake.managed_widget_sources (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL,
 name VARCHAR(200) NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 200 AND name=btrim(name)),
 owner_subject VARCHAR(256) NOT NULL CHECK(char_length(owner_subject) BETWEEN 1 AND 256 AND owner_subject !~ '[[:space:][:cntrl:]]'),
 widget_type VARCHAR(16) NOT NULL CHECK(widget_type IN ('WHEEL','QUIZ','CALLBACK','TIMER','STOP_OFFER','CALCULATOR')),
 widget_id VARCHAR(255) NOT NULL CHECK(char_length(widget_id)>0 AND widget_id !~ '[[:space:][:cntrl:]]'),
 connector_id UUID NOT NULL UNIQUE,
 created_by_subject VARCHAR(256) NOT NULL CHECK(char_length(created_by_subject) BETWEEN 1 AND 256 AND created_by_subject !~ '[[:space:][:cntrl:]]'),
 team_id UUID, version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483646),
 control_version INTEGER NOT NULL DEFAULT 1 CHECK(control_version=version),
 generation INTEGER NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND control_version),
 enabled BOOLEAN NOT NULL DEFAULT true, current_command_id UUID NOT NULL,
 applied_control_version INTEGER, applied_generation INTEGER,
 sync_state VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(sync_state IN ('PENDING','SYNCED','BLOCKED','ERROR')),
 last_error_code VARCHAR(64) CHECK(last_error_code IS NULL OR last_error_code IN ('DELEGATION_REVOKED','OWNER_CHANGED','SUBSCRIPTION_REQUIRED','WIDGET_UNAVAILABLE','ALREADY_CONNECTED','CONTROL_CONFLICT','DEPENDENCY_UNAVAILABLE','INVALID_RESPONSE')), synced_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(id,workspace_id),
 CHECK(((applied_control_version IS NULL AND applied_generation IS NULL AND synced_at IS NULL) OR (applied_control_version BETWEEN 1 AND control_version AND applied_generation BETWEEN 1 AND generation AND synced_at IS NOT NULL)) IS TRUE),
 CHECK((sync_state<>'SYNCED' OR (applied_control_version=control_version AND applied_generation=generation AND last_error_code IS NULL)) IS TRUE)
);
CREATE INDEX managed_widget_sources_workspace_id_created_at_id_idx ON crm_intake.managed_widget_sources(workspace_id,created_at,id);
CREATE UNIQUE INDEX managed_widget_sources_enabled_widget_key ON crm_intake.managed_widget_sources(owner_subject,widget_type,widget_id) WHERE enabled;

CREATE TABLE crm_intake.widget_control_jobs (
 command_id UUID PRIMARY KEY, workspace_id UUID NOT NULL, source_id UUID NOT NULL,
 connector_id UUID NOT NULL, owner_subject VARCHAR(256) NOT NULL,
 actor_subject VARCHAR(256) NOT NULL, requested_by_subject VARCHAR(256) NOT NULL,
 widget_type VARCHAR(16) NOT NULL, widget_id VARCHAR(255) NOT NULL,
 control_version INTEGER NOT NULL CHECK(control_version BETWEEN 1 AND 2147483646),
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND control_version),
 enabled BOOLEAN NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','APPLIED','SUPERSEDED','BLOCKED','ERROR')),
 lease_token UUID, lease_until TIMESTAMP(3), active_event_id UUID NOT NULL,
 response JSONB, last_error_code VARCHAR(64), completed_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 UNIQUE(source_id,control_version), UNIQUE(command_id,workspace_id,source_id),
 CONSTRAINT widget_control_jobs_source_fkey FOREIGN KEY(source_id,workspace_id) REFERENCES crm_intake.managed_widget_sources(id,workspace_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT widget_control_jobs_command_fkey FOREIGN KEY(command_id) REFERENCES crm_intake.intake_commands(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL)),
 CHECK((status='APPLIED' AND response IS NOT NULL AND completed_at IS NOT NULL) OR (status<>'APPLIED' AND response IS NULL)),
 CHECK(status<>'APPLIED' OR (response->>'schemaVersion'='1' AND response->'connector'->>'id'=connector_id::text AND response->'connector'->>'workspaceId'=workspace_id::text AND response->'connector'->>'sourceId'=source_id::text AND response->'connector'->>'ownerSubject'=owner_subject AND response->'connector'->>'widgetType'=widget_type AND response->'connector'->>'widgetId'=widget_id AND response->'connector'->>'controlVersion'=control_version::text AND response->'connector'->>'generation'=generation::text AND response->'connector'->>'enabled'=enabled::text) IS TRUE)
);
ALTER TABLE crm_intake.managed_widget_sources ADD CONSTRAINT managed_widget_sources_current_job_fkey FOREIGN KEY(current_command_id,workspace_id,id) REFERENCES crm_intake.widget_control_jobs(command_id,workspace_id,source_id) ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE crm_intake.widget_control_receipts (
 event_id UUID NOT NULL, consumer VARCHAR(80) NOT NULL CHECK(consumer='crm-intake.widget-control.v1'),
 workspace_id UUID NOT NULL, source_id UUID NOT NULL, command_id UUID NOT NULL,
 payload_hash CHAR(64) NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 status VARCHAR(24) NOT NULL CHECK(status IN ('PROCESSING','DELIVERED','FAILED')),
 lease_token UUID, lease_until TIMESTAMP(3),
 retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt BETWEEN 0 AND 3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL,
 PRIMARY KEY(event_id,consumer),
 FOREIGN KEY(command_id,workspace_id,source_id) REFERENCES crm_intake.widget_control_jobs(command_id,workspace_id,source_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CHECK((status='PROCESSING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PROCESSING' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE TABLE crm_intake.widget_control_outbox (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID NOT NULL,
 deduplication_key VARCHAR(256) NOT NULL UNIQUE,
 route VARCHAR(16) NOT NULL DEFAULT 'MAIN' CHECK(route IN ('MAIN','RETRY_1','RETRY_2','RETRY_3','DLQ')),
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PUBLISHING','PUBLISHED')),
 available_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token UUID, lease_until TIMESTAMP(3), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK(retry_attempt BETWEEN 0 AND 3),
 last_error_code VARCHAR(64), published_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='PUBLISHING' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status<>'PUBLISHING' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX widget_control_outbox_status_available_at_id_idx ON crm_intake.widget_control_outbox(status,available_at,id);

CREATE FUNCTION crm_intake.widget_control_immutable() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_TABLE_NAME='managed_widget_sources' THEN
  IF (NEW.id,NEW.workspace_id,NEW.owner_subject,NEW.widget_type,NEW.widget_id,NEW.connector_id,NEW.created_by_subject,NEW.team_id,NEW.name,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.owner_subject,OLD.widget_type,OLD.widget_id,OLD.connector_id,OLD.created_by_subject,OLD.team_id,OLD.name,OLD.created_at) THEN RAISE EXCEPTION 'Managed source binding is immutable'; END IF;
  IF NEW.control_version<OLD.control_version OR NEW.generation<OLD.generation OR (NOT OLD.enabled AND NEW.enabled AND NEW.generation<=OLD.generation) OR (OLD.applied_control_version IS NOT NULL AND (NEW.applied_control_version IS NULL OR NEW.applied_control_version<OLD.applied_control_version)) THEN RAISE EXCEPTION 'Managed source control must be monotonic'; END IF;
 ELSIF TG_TABLE_NAME='widget_control_jobs' THEN
  IF (NEW.command_id,NEW.workspace_id,NEW.source_id,NEW.connector_id,NEW.owner_subject,NEW.actor_subject,NEW.requested_by_subject,NEW.widget_type,NEW.widget_id,NEW.control_version,NEW.generation,NEW.enabled,NEW.created_at) IS DISTINCT FROM (OLD.command_id,OLD.workspace_id,OLD.source_id,OLD.connector_id,OLD.owner_subject,OLD.actor_subject,OLD.requested_by_subject,OLD.widget_type,OLD.widget_id,OLD.control_version,OLD.generation,OLD.enabled,OLD.created_at) THEN RAISE EXCEPTION 'Control command binding is immutable'; END IF;
  IF OLD.status IN ('APPLIED','SUPERSEDED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Completed control proof is immutable'; END IF;
 ELSIF TG_TABLE_NAME='widget_control_receipts' THEN
  IF (NEW.event_id,NEW.consumer,NEW.workspace_id,NEW.source_id,NEW.command_id,NEW.payload_hash,NEW.created_at) IS DISTINCT FROM (OLD.event_id,OLD.consumer,OLD.workspace_id,OLD.source_id,OLD.command_id,OLD.payload_hash,OLD.created_at) THEN RAISE EXCEPTION 'Control receipt binding is immutable'; END IF;
  IF OLD.status='DELIVERED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Delivered receipt is immutable'; END IF;
 ELSIF TG_TABLE_NAME='widget_control_outbox' THEN
  IF (NEW.id,NEW.event_id,NEW.deduplication_key,NEW.route,NEW.payload,NEW.retry_attempt,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.event_id,OLD.deduplication_key,OLD.route,OLD.payload,OLD.retry_attempt,OLD.created_at) THEN RAISE EXCEPTION 'Control event binding is immutable'; END IF;
 END IF;
 RETURN NEW;
END;
$body$;
CREATE TRIGGER managed_widget_sources_immutable BEFORE UPDATE ON crm_intake.managed_widget_sources FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_immutable();
CREATE TRIGGER widget_control_jobs_immutable BEFORE UPDATE ON crm_intake.widget_control_jobs FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_immutable();
CREATE TRIGGER widget_control_receipts_immutable BEFORE UPDATE ON crm_intake.widget_control_receipts FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_immutable();
CREATE TRIGGER widget_control_outbox_immutable BEFORE UPDATE ON crm_intake.widget_control_outbox FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_immutable();

CREATE FUNCTION crm_intake.widget_control_integrity() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE source_row crm_intake.managed_widget_sources%ROWTYPE; job crm_intake.widget_control_jobs%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='managed_widget_sources' THEN
  SELECT * INTO source_row FROM crm_intake.managed_widget_sources WHERE id=NEW.id;
  SELECT * INTO job FROM crm_intake.widget_control_jobs WHERE command_id=source_row.current_command_id;
  IF NOT FOUND OR (job.control_version,job.generation,job.enabled) IS DISTINCT FROM (source_row.control_version,source_row.generation,source_row.enabled) OR (source_row.sync_state='SYNCED' AND job.status<>'APPLIED') THEN RAISE EXCEPTION 'Current source control proof is missing'; END IF;
 ELSE
  SELECT * INTO job FROM crm_intake.widget_control_jobs WHERE command_id=NEW.command_id;
  SELECT * INTO source_row FROM crm_intake.managed_widget_sources WHERE id=job.source_id;
  IF NOT FOUND OR (job.workspace_id,job.connector_id,job.owner_subject,job.actor_subject,job.widget_type,job.widget_id) IS DISTINCT FROM (source_row.workspace_id,source_row.connector_id,source_row.owner_subject,source_row.created_by_subject,source_row.widget_type,source_row.widget_id) THEN RAISE EXCEPTION 'Control source binding mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM crm_intake.intake_commands WHERE command_id=job.command_id AND workspace_id=job.workspace_id AND entity_id=job.source_id AND entity_kind='widget-source' AND actor_subject=job.requested_by_subject) THEN RAISE EXCEPTION 'Control public command proof missing'; END IF;
 END IF;
 RETURN NULL;
END;
$body$;
CREATE CONSTRAINT TRIGGER managed_widget_sources_integrity AFTER INSERT OR UPDATE ON crm_intake.managed_widget_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_integrity();
CREATE CONSTRAINT TRIGGER widget_control_jobs_integrity AFTER INSERT OR UPDATE ON crm_intake.widget_control_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.widget_control_integrity();
REVOKE ALL ON FUNCTION crm_intake.widget_control_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_intake.widget_control_integrity() FROM PUBLIC;
COMMIT;
