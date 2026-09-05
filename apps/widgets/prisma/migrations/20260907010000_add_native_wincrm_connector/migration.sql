CREATE TABLE widgets.wincrm_connectors (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  source_id UUID NOT NULL UNIQUE,
  owner_subject VARCHAR(256) NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 256 AND owner_subject !~ '[[:space:][:cntrl:]]'),
  widget_type VARCHAR(16) NOT NULL CHECK (widget_type IN ('WHEEL','QUIZ','CALLBACK','TIMER','STOP_OFFER','CALCULATOR')),
  widget_id VARCHAR(255) NOT NULL CHECK (length(widget_id) BETWEEN 1 AND 255 AND widget_id !~ '[[:space:][:cntrl:]]'),
  control_version INTEGER NOT NULL CHECK (control_version > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  enabled BOOLEAN NOT NULL,
  enabled_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT wincrm_connectors_owner_binding_key UNIQUE (id,workspace_id,source_id,owner_subject),
  CONSTRAINT wincrm_connectors_full_binding_key UNIQUE (id,workspace_id,source_id,owner_subject,widget_type,widget_id),
  CHECK ((enabled AND enabled_at IS NOT NULL) OR (NOT enabled AND enabled_at IS NULL))
);
CREATE UNIQUE INDEX wincrm_connectors_one_active_widget ON widgets.wincrm_connectors(widget_type,widget_id) WHERE enabled;
CREATE INDEX wincrm_connectors_owner_subject_widget_type_widget_id_idx ON widgets.wincrm_connectors(owner_subject,widget_type,widget_id);

CREATE TABLE widgets.wincrm_connector_commands (
  command_id UUID PRIMARY KEY,
  connector_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  source_id UUID NOT NULL,
  owner_subject VARCHAR(256) NOT NULL,
  caller VARCHAR(32) NOT NULL DEFAULT 'crm-intake' CHECK (caller = 'crm-intake'),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 16384),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(connector_id,workspace_id,source_id,owner_subject) REFERENCES widgets.wincrm_connectors(id,workspace_id,source_id,owner_subject) ON DELETE RESTRICT
);
CREATE INDEX wincrm_connector_commands_connector_id_created_at_idx ON widgets.wincrm_connector_commands(connector_id,created_at);

CREATE TABLE widgets.wincrm_transfer_intents (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  connector_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  source_id UUID NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  widget_type VARCHAR(16) NOT NULL CHECK (widget_type IN ('WHEEL','QUIZ','CALLBACK','TIMER','STOP_OFFER','CALCULATOR')),
  widget_id VARCHAR(255) NOT NULL,
  lead_id VARCHAR(255) NOT NULL,
  owner_subject VARCHAR(256) NOT NULL,
  original_subscription_id VARCHAR(255),
  original_subscription_version VARCHAR(19) CHECK (original_subscription_version ~ '^(0|[1-9][0-9]*)$' AND original_subscription_version::numeric <= 9223372036854775807),
  original_period_starts_at TIMESTAMP(3),
  original_deadline TIMESTAMP(3),
  lead_created_at TIMESTAMP(3) NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('READY','SKIPPED')),
  reason VARCHAR(64),
  payload JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(connector_id,generation,widget_type,lead_id),
  FOREIGN KEY(connector_id,workspace_id,source_id,owner_subject,widget_type,widget_id) REFERENCES widgets.wincrm_connectors(id,workspace_id,source_id,owner_subject,widget_type,widget_id) ON DELETE RESTRICT,
  CHECK (
    (state='READY' AND reason IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object'
      AND original_subscription_id IS NOT NULL AND original_subscription_version IS NOT NULL
      AND original_period_starts_at IS NOT NULL AND original_deadline IS NOT NULL
      AND original_period_starts_at <= lead_created_at AND lead_created_at < original_deadline)
    OR (state='SKIPPED' AND payload IS NULL AND reason IS NOT NULL AND reason IN
      ('PAYLOAD_TOO_LARGE','PAYLOAD_SHAPE_UNSUPPORTED','TEXT_UNSUPPORTED','SOURCE_PERIOD_INELIGIBLE','SOURCE_PERIOD_INVALID','BEFORE_ACTIVATION'))
  ),
  CHECK (payload IS NULL OR octet_length(payload::text) <= 524288)
);
CREATE INDEX wincrm_transfer_intents_workspace_id_source_id_created_at_id_idx ON widgets.wincrm_transfer_intents(workspace_id,source_id,created_at,id);

CREATE FUNCTION widgets.guard_wincrm_connector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.workspace_id,NEW.source_id,NEW.owner_subject,NEW.widget_type,NEW.widget_id,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.source_id,OLD.owner_subject,OLD.widget_type,OLD.widget_id,OLD.created_at)
      OR NEW.control_version <= OLD.control_version OR NEW.generation < OLD.generation
      OR (NEW.enabled AND NOT OLD.enabled AND NEW.generation <= OLD.generation) THEN
    RAISE EXCEPTION 'WinCRM connector binding and versions are immutable or monotonic';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION widgets.guard_wincrm_connector_update() FROM PUBLIC;
CREATE TRIGGER wincrm_connector_update_guard BEFORE UPDATE ON widgets.wincrm_connectors FOR EACH ROW EXECUTE FUNCTION widgets.guard_wincrm_connector_update();

CREATE FUNCTION widgets.reject_wincrm_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WinCRM connector evidence is immutable';
END;
$$;
REVOKE ALL ON FUNCTION widgets.reject_wincrm_evidence_mutation() FROM PUBLIC;
CREATE TRIGGER wincrm_commands_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON widgets.wincrm_connector_commands FOR EACH STATEMENT EXECUTE FUNCTION widgets.reject_wincrm_evidence_mutation();
CREATE TRIGGER wincrm_transfers_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON widgets.wincrm_transfer_intents FOR EACH STATEMENT EXECUTE FUNCTION widgets.reject_wincrm_evidence_mutation();
CREATE TRIGGER wincrm_connectors_no_delete BEFORE DELETE OR TRUNCATE ON widgets.wincrm_connectors FOR EACH STATEMENT EXECUTE FUNCTION widgets.reject_wincrm_evidence_mutation();
