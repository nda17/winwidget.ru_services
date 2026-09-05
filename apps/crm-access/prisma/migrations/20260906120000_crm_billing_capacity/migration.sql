BEGIN;
CREATE TABLE crm_access.crm_billing_capacity (
  workspace_id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 2147483646),
  admission_ceiling integer CHECK (admission_ceiling BETWEEN 2 AND 10000),
  pending_operation_id uuid,
  pending_target_seats integer CHECK (pending_target_seats BETWEEN 2 AND 10000),
  latest_committed_operation_id uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CHECK ((pending_operation_id IS NULL) = (pending_target_seats IS NULL))
);
CREATE TABLE crm_access.crm_billing_operations (
  command_id uuid PRIMARY KEY REFERENCES crm_access.crm_team_command_receipts(command_id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  actor_subject varchar(256) NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 256 AND actor_subject !~ '[[:space:][:cntrl:]]'),
  command_type varchar(64) NOT NULL CHECK (command_type IN ('WINCRM_CHECKOUT','WINCRM_SEAT_CHANGE','WINCRM_DISABLE_RENEWAL','WINCRM_CONFIRM_RENEWAL','WINCRM_VERIFY_ORDER','WINCRM_NOT_STARTED')),
  request_hash char(64), request jsonb,
  fence_revision integer CHECK (fence_revision BETWEEN 1 AND 2147483646),
  target_seats integer CHECK (target_seats BETWEEN 2 AND 10000),
  state varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','COMMITTED','CANCELLED','NOT_STARTED')),
  release_fence boolean NOT NULL DEFAULT false,
  billing_version varchar(20) CHECK (billing_version ~ '^(0|[1-9][0-9]*)$'),
  hold_until timestamp(3), proof jsonb, next_check_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT crm_billing_operations_command_id_workspace_id_key UNIQUE(command_id,workspace_id),
  CHECK ((fence_revision IS NULL) = (target_seats IS NULL)),
  CHECK ((command_type IN ('WINCRM_CHECKOUT','WINCRM_SEAT_CHANGE')) = (fence_revision IS NOT NULL)),
  CHECK ((state = 'NOT_STARTED' AND command_type = 'WINCRM_NOT_STARTED' AND request_hash IS NULL AND request IS NULL AND proof IS NULL AND release_fence)
     OR (state <> 'NOT_STARTED' AND command_type <> 'WINCRM_NOT_STARTED' AND request_hash IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$' AND request IS NOT NULL AND jsonb_typeof(request) = 'object')),
  CHECK (NOT release_fence OR state IN ('COMMITTED','CANCELLED','NOT_STARTED')),
  CHECK (hold_until IS NULL OR (state = 'COMMITTED' AND NOT release_fence))
);
CREATE INDEX crm_billing_operations_workspace_id_state_created_at_idx ON crm_access.crm_billing_operations(workspace_id,state,created_at);
CREATE INDEX crm_billing_operations_release_fence_next_check_at_command_id_idx ON crm_access.crm_billing_operations(release_fence,next_check_at,command_id);
ALTER TABLE crm_access.crm_billing_capacity
 ADD CONSTRAINT crm_billing_capacity_pending_fk FOREIGN KEY(pending_operation_id,workspace_id) REFERENCES crm_access.crm_billing_operations(command_id,workspace_id) ON DELETE RESTRICT,
 ADD CONSTRAINT crm_billing_capacity_committed_fk FOREIGN KEY(latest_committed_operation_id,workspace_id) REFERENCES crm_access.crm_billing_operations(command_id,workspace_id) ON DELETE RESTRICT;
CREATE FUNCTION crm_access.guard_billing_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NOT EXISTS (SELECT 1 FROM crm_access.crm_team_command_receipts r WHERE r.command_id=NEW.command_id AND r.workspace_id=NEW.workspace_id AND r.actor_subject=NEW.actor_subject AND r.command_type=NEW.command_type AND r.request_hash=COALESCE(NEW.request_hash,repeat('0',64))) THEN
   RAISE EXCEPTION 'CRM billing receipt binding is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'CRM billing operation is retained' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.command_id,NEW.workspace_id,NEW.actor_subject,NEW.command_type,NEW.request_hash,NEW.request,NEW.fence_revision,NEW.target_seats,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.command_id,OLD.workspace_id,OLD.actor_subject,OLD.command_type,OLD.request_hash,OLD.request,OLD.fence_revision,OLD.target_seats,OLD.created_at)
  OR (OLD.state <> 'PENDING' AND NEW.state <> OLD.state)
  OR (OLD.release_fence AND NOT NEW.release_fence)
  OR (OLD.billing_version IS NOT NULL AND (NEW.billing_version IS NULL OR NEW.billing_version::numeric < OLD.billing_version::numeric))
 THEN RAISE EXCEPTION 'CRM billing operation binding is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_billing_operations_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_access.crm_billing_operations FOR EACH ROW EXECUTE FUNCTION crm_access.guard_billing_operation();
CREATE FUNCTION crm_access.guard_billing_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'CRM billing capacity is retained' USING ERRCODE='23514'; END IF;
 IF NEW.workspace_id <> OLD.workspace_id OR NEW.created_at <> OLD.created_at OR NEW.revision < OLD.revision THEN
  RAISE EXCEPTION 'CRM billing capacity binding is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.pending_operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_access.crm_billing_operations o WHERE o.command_id=NEW.pending_operation_id AND o.workspace_id=NEW.workspace_id AND o.fence_revision=NEW.revision AND o.target_seats=NEW.pending_target_seats AND NOT o.release_fence AND o.state IN ('PENDING','COMMITTED')) THEN
  RAISE EXCEPTION 'CRM pending capacity binding is invalid' USING ERRCODE='23514';
 END IF;
 IF NEW.latest_committed_operation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_access.crm_billing_operations o WHERE o.command_id=NEW.latest_committed_operation_id AND o.workspace_id=NEW.workspace_id AND o.state='COMMITTED' AND o.target_seats IS NOT NULL) THEN
  RAISE EXCEPTION 'CRM committed capacity binding is invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_billing_capacity_guard BEFORE UPDATE OR DELETE ON crm_access.crm_billing_capacity FOR EACH ROW EXECUTE FUNCTION crm_access.guard_billing_capacity();
COMMIT;
