BEGIN;

ALTER TABLE crm_sales.tasks ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE crm_sales.tasks DROP CONSTRAINT tasks_completed_at_check;
ALTER TABLE crm_sales.tasks ADD CONSTRAINT tasks_completed_at_check CHECK (
  (status IN ('OPEN', 'IN_PROGRESS') AND completed_at IS NULL)
  OR (status IN ('COMPLETED', 'CANCELLED') AND completed_at IS NOT NULL)
);

DROP INDEX crm_sales.tasks_one_open_per_deal;
CREATE INDEX tasks_assignee_workday_idx ON crm_sales.tasks
  (workspace_id, assigned_to_subject, status, due_at, id);
CREATE INDEX tasks_active_deal_idx ON crm_sales.tasks (workspace_id, deal_id, due_at, id)
  WHERE deal_id IS NOT NULL AND status IN ('OPEN', 'IN_PROGRESS');

ALTER TABLE crm_sales.deals DROP CONSTRAINT deals_next_task_required_check;
ALTER TABLE crm_sales.deals ADD CONSTRAINT deals_next_task_required_check CHECK (
  (status = 'OPEN' AND archived_at IS NULL) OR next_task_id IS NULL
);

-- Keep the existing deferred trigger names used by legacy command transactions.
-- There may now be zero or several active tasks. A nonempty active set still
-- requires a valid selected next action; zero tasks requires a null pointer.
-- Revalidate BOTH old and new parents on a move, including a move to standalone.
CREATE OR REPLACE FUNCTION crm_sales.check_sales_next_action() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  affected_ids UUID[];
  affected_workspaces UUID[];
  affected RECORD;
  deal_record crm_sales.deals%ROWTYPE;
  active_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'deals' THEN
    affected_ids := ARRAY[NEW.id, OLD.id];
  ELSE
    affected_ids := ARRAY[NEW.deal_id, OLD.deal_id];
  END IF;
  affected_workspaces := ARRAY[NEW.workspace_id, OLD.workspace_id];

  FOR affected IN
    SELECT DISTINCT id, workspace_id
    FROM unnest(affected_ids, affected_workspaces) AS targets(id, workspace_id)
    WHERE id IS NOT NULL AND workspace_id IS NOT NULL
    ORDER BY workspace_id, id
  LOOP
    SELECT * INTO deal_record FROM crm_sales.deals
      WHERE id = affected.id AND workspace_id = affected.workspace_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM crm_sales.pipeline_stages
      WHERE id = deal_record.stage_id AND pipeline_id = deal_record.pipeline_id
        AND workspace_id = deal_record.workspace_id AND state = deal_record.status
    ) THEN
      RAISE EXCEPTION 'Deal status must match its pipeline stage';
    END IF;
    SELECT count(*) INTO active_count FROM crm_sales.tasks
      WHERE deal_id = affected.id AND workspace_id = affected.workspace_id
        AND status IN ('OPEN', 'IN_PROGRESS');
    IF deal_record.status = 'OPEN' AND deal_record.archived_at IS NULL THEN
      IF (active_count = 0 AND deal_record.next_task_id IS NOT NULL)
        OR (active_count > 0 AND NOT EXISTS (
          SELECT 1 FROM crm_sales.tasks
          WHERE id = deal_record.next_task_id AND deal_id = affected.id
            AND workspace_id = affected.workspace_id AND status IN ('OPEN', 'IN_PROGRESS')
        )) THEN
        RAISE EXCEPTION 'Deal next action must match its active tasks';
      END IF;
    ELSIF active_count <> 0 THEN
      RAISE EXCEPTION 'Closed or archived deal cannot retain an active task';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION crm_sales.check_sales_next_action() FROM PUBLIC;

COMMIT;
