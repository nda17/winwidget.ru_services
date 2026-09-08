-- Additive, service-owned series. Existing tasks and assignments are untouched.
BEGIN;
CREATE TABLE crm_sales.task_series (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  creator_subject VARCHAR(256) NOT NULL,
  creator_membership_id UUID,
  title VARCHAR(200) NOT NULL CHECK (length(trim(title)) > 0),
  deal_id UUID,
  team_id UUID,
  assigned_to_subject VARCHAR(256) NOT NULL,
  assigned_to_membership_id UUID,
  frequency VARCHAR(8) NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  start_date CHAR(10) NOT NULL CHECK (start_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'),
  local_time CHAR(5) NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone VARCHAR(100) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  next_run_at TIMESTAMP(3) NOT NULL,
  next_check_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  blocked_reason VARCHAR(32),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT task_series_id_workspace_id_key UNIQUE (id, workspace_id),
  CONSTRAINT task_series_deal_fkey FOREIGN KEY (deal_id, workspace_id) REFERENCES crm_sales.deals(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT task_series_creator_subject_check CHECK (length(creator_subject) BETWEEN 1 AND 256 AND creator_subject !~ '[[:space:][:cntrl:]]'),
  CONSTRAINT task_series_assignee_subject_check CHECK (length(assigned_to_subject) BETWEEN 1 AND 256 AND assigned_to_subject !~ '[[:space:][:cntrl:]]'),
  CONSTRAINT task_series_blocked_reason_check CHECK (blocked_reason IS NULL OR blocked_reason IN ('READ_ONLY', 'CREATOR_REVOKED', 'ASSIGNEE_REVOKED', 'SCOPE_CHANGED', 'DEAL_CLOSED'))
);
CREATE INDEX task_series_list_idx ON crm_sales.task_series(workspace_id, status, created_at, id);
CREATE INDEX task_series_schedule_idx ON crm_sales.task_series(status, next_run_at, next_check_at, id);
CREATE FUNCTION crm_sales.guard_task_series_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.workspace_id, NEW.creator_subject, NEW.creator_membership_id, NEW.deal_id, NEW.team_id, NEW.frequency, NEW.start_date)
      IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.creator_subject, OLD.creator_membership_id, OLD.deal_id, OLD.team_id, OLD.frequency, OLD.start_date)
      OR NEW.next_index < OLD.next_index
      OR (OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED') THEN
    RAISE EXCEPTION 'Task series identity, calendar and consumed periods are immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION crm_sales.guard_task_series_identity() FROM PUBLIC;
CREATE TRIGGER task_series_identity_guard BEFORE UPDATE ON crm_sales.task_series FOR EACH ROW EXECUTE FUNCTION crm_sales.guard_task_series_identity();

CREATE TABLE crm_sales.task_series_commands (
  command_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  series_id UUID NOT NULL,
  before JSONB,
  result JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_series_commands_series_id_workspace_id_fkey FOREIGN KEY (series_id, workspace_id) REFERENCES crm_sales.task_series(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX task_series_commands_history_idx ON crm_sales.task_series_commands(workspace_id, series_id, created_at);

CREATE TABLE crm_sales.task_series_occurrences (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  series_id UUID NOT NULL,
  period_index INTEGER NOT NULL CHECK (period_index >= 0),
  series_version INTEGER NOT NULL CHECK (series_version >= 1),
  task_id UUID NOT NULL UNIQUE,
  due_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_series_period_key UNIQUE (series_id, period_index),
  CONSTRAINT task_series_occurrences_task_id_workspace_id_key UNIQUE (task_id, workspace_id),
  CONSTRAINT task_series_occurrences_series_id_workspace_id_fkey FOREIGN KEY (series_id, workspace_id) REFERENCES crm_sales.task_series(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT task_series_occurrences_task_id_workspace_id_fkey FOREIGN KEY (task_id, workspace_id) REFERENCES crm_sales.tasks(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TRIGGER task_series_commands_append_only BEFORE UPDATE OR DELETE ON crm_sales.task_series_commands FOR EACH ROW EXECUTE FUNCTION crm_sales.reject_reminder_command_mutation();
CREATE TRIGGER task_series_commands_no_truncate BEFORE TRUNCATE ON crm_sales.task_series_commands FOR EACH STATEMENT EXECUTE FUNCTION crm_sales.reject_reminder_command_mutation();
CREATE TRIGGER task_series_occurrences_append_only BEFORE UPDATE OR DELETE ON crm_sales.task_series_occurrences FOR EACH ROW EXECUTE FUNCTION crm_sales.reject_reminder_command_mutation();
CREATE TRIGGER task_series_occurrences_no_truncate BEFORE TRUNCATE ON crm_sales.task_series_occurrences FOR EACH STATEMENT EXECUTE FUNCTION crm_sales.reject_reminder_command_mutation();
REVOKE ALL ON crm_sales.task_series, crm_sales.task_series_commands, crm_sales.task_series_occurrences FROM PUBLIC;
COMMIT;
