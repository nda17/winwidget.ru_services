BEGIN;

-- Legacy rows retain their exact assignments. Their historic membership is
-- unknown; it must never be invented or backfilled from today's directory.
ALTER TABLE crm_sales.tasks
  ADD COLUMN assigned_to_membership_id UUID,
  ADD COLUMN team_id UUID;
ALTER TABLE crm_sales.tasks ADD CONSTRAINT tasks_id_workspace_id_key UNIQUE (id, workspace_id);
CREATE INDEX tasks_team_workday_idx ON crm_sales.tasks (workspace_id, team_id, status, due_at, id);

CREATE TABLE crm_sales.task_command_receipts (
  command_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_subject VARCHAR(256) NOT NULL,
  command_type VARCHAR(32) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  task_id UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_command_receipts_task_id_workspace_id_fkey FOREIGN KEY (task_id, workspace_id)
    REFERENCES crm_sales.tasks(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE crm_sales.task_timeline (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  task_id UUID NOT NULL,
  command_id UUID NOT NULL UNIQUE,
  actor_subject VARCHAR(256) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  before JSONB,
  after JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT task_timeline_task_id_workspace_id_fkey FOREIGN KEY (task_id, workspace_id)
    REFERENCES crm_sales.tasks(id, workspace_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX task_timeline_workspace_id_task_id_created_at_id_idx
  ON crm_sales.task_timeline(workspace_id, task_id, created_at, id);

REVOKE ALL ON crm_sales.task_command_receipts, crm_sales.task_timeline FROM PUBLIC;
COMMIT;
