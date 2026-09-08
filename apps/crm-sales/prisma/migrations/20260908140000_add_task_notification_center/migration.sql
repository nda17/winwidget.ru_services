BEGIN;
CREATE TABLE crm_sales.task_notifications (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL, task_id uuid NOT NULL,
 recipient_subject varchar(256) NOT NULL,
 recipient_membership_id uuid, assignment_version integer NOT NULL CHECK(assignment_version >= 1),
 kind varchar(16) NOT NULL CHECK(kind IN ('ASSIGNED','DUE')),
 available_at timestamp(3) NOT NULL, read_at timestamp(3), cancelled_at timestamp(3),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT task_notifications_occurrence_key UNIQUE(task_id,assignment_version,kind),
 FOREIGN KEY(task_id,workspace_id) REFERENCES crm_sales.tasks(id,workspace_id) ON DELETE RESTRICT
);
CREATE INDEX task_notifications_recipient_idx ON crm_sales.task_notifications(workspace_id,recipient_subject,available_at,id);
REVOKE ALL ON crm_sales.task_notifications FROM PUBLIC;

-- Pure Sales-owned state in the business transaction, no broker or external channel.
-- DUE is persisted now but visible only after its current available_at deadline.
CREATE FUNCTION crm_sales.record_task_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE instant timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
 IF TG_OP='INSERT' OR NEW.assignment_version IS DISTINCT FROM OLD.assignment_version THEN
   UPDATE crm_sales.task_notifications SET cancelled_at=instant
   WHERE task_id=NEW.id AND cancelled_at IS NULL;
   IF NEW.assignment_version IS NOT NULL AND NEW.status IN ('OPEN','IN_PROGRESS') THEN
     INSERT INTO crm_sales.task_notifications
       (id,workspace_id,task_id,recipient_subject,recipient_membership_id,assignment_version,kind,available_at)
     VALUES
       (gen_random_uuid(),NEW.workspace_id,NEW.id,NEW.assigned_to_subject,NEW.assigned_to_membership_id,NEW.assignment_version,'ASSIGNED',instant),
       (gen_random_uuid(),NEW.workspace_id,NEW.id,NEW.assigned_to_subject,NEW.assigned_to_membership_id,NEW.assignment_version,'DUE',NEW.due_at);
   END IF;
 ELSIF NEW.status NOT IN ('OPEN','IN_PROGRESS') THEN
   UPDATE crm_sales.task_notifications SET cancelled_at=instant
   WHERE task_id=NEW.id AND cancelled_at IS NULL;
 ELSIF NEW.due_at IS DISTINCT FROM OLD.due_at OR OLD.status NOT IN ('OPEN','IN_PROGRESS') THEN
   -- Restore only an existing DUE, never import a historical task or repeat ASSIGNED.
   UPDATE crm_sales.task_notifications
   SET available_at=NEW.due_at,read_at=NULL,cancelled_at=NULL
   WHERE task_id=NEW.id AND assignment_version=NEW.assignment_version AND kind='DUE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_notification_center AFTER INSERT OR UPDATE ON crm_sales.tasks
FOR EACH ROW EXECUTE FUNCTION crm_sales.record_task_notifications();
REVOKE ALL ON FUNCTION crm_sales.record_task_notifications() FROM PUBLIC;
COMMIT;
