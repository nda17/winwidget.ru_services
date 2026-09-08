BEGIN;
-- Null on historical rows: enabling a rule never imports assignment history.
ALTER TABLE crm_sales.tasks
 ADD COLUMN assignment_version integer CHECK(assignment_version >= 1),
 ADD COLUMN assignment_at timestamp(3),
 ADD CONSTRAINT tasks_assignment_clock_pair CHECK((assignment_version IS NULL) = (assignment_at IS NULL));
ALTER TABLE crm_sales.reminder_deliveries
 ADD COLUMN assignment_version integer CHECK(assignment_version >= 1);

-- Invoker rights, including legacy task writers and recurring task generation.
-- Unrelated edits cannot manufacture another assignment or replay an old one.
CREATE FUNCTION crm_sales.track_task_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   NEW.assignment_version := 1;
   NEW.assignment_at := clock_timestamp() AT TIME ZONE 'UTC';
 ELSIF NEW.assigned_to_subject IS DISTINCT FROM OLD.assigned_to_subject
    OR NEW.assigned_to_membership_id IS DISTINCT FROM OLD.assigned_to_membership_id THEN
   NEW.assignment_version := coalesce(OLD.assignment_version,0) + 1;
   NEW.assignment_at := clock_timestamp() AT TIME ZONE 'UTC';
 ELSE
   NEW.assignment_version := OLD.assignment_version;
   NEW.assignment_at := OLD.assignment_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tasks_assignment_clock BEFORE INSERT OR UPDATE ON crm_sales.tasks
FOR EACH ROW EXECUTE FUNCTION crm_sales.track_task_assignment();
REVOKE ALL ON FUNCTION crm_sales.track_task_assignment() FROM PUBLIC;

-- Preserve the existing transactional wake and legacy due-reminder cancellation.
-- Assignment notices survive title/deadline edits but not reassignment/completion.
CREATE OR REPLACE FUNCTION crm_sales.wake_task_reminders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_id uuid := gen_random_uuid(); event_id uuid := gen_random_uuid();
 period text; target_task uuid; instant timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC');
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
   target_task := NEW.id;
   IF TG_OP='UPDATE' THEN
     UPDATE crm_sales.reminder_deliveries SET status='CANCELLED'
     WHERE workspace_id=NEW.workspace_id AND task_id=NEW.id AND status='PENDING'
       AND (assignment_version IS NULL
         OR assignment_version IS DISTINCT FROM NEW.assignment_version
         OR NEW.status NOT IN ('OPEN','IN_PROGRESS'));
   END IF;
   period := 'task:'||NEW.id::text||':'||NEW.version::text||':'||event_id::text;
 ELSE
   UPDATE crm_sales.reminder_deliveries SET status='CANCELLED'
   WHERE workspace_id=NEW.workspace_id AND rule_id=NEW.id AND status='PENDING';
   period := 'rule:'||NEW.id::text||':'||NEW.version::text||':'||event_id::text;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM crm_sales.reminder_rules WHERE workspace_id=NEW.workspace_id
   AND archived_at IS NULL AND configuration->>'enabled'='true') THEN RETURN NEW; END IF;
 INSERT INTO crm_sales.reminder_jobs(id,period_key,workspace_id,task_id)
 VALUES(job_id,period,NEW.workspace_id,target_task);
 INSERT INTO crm_sales.reminder_outbox(id,message_id,event_type,payload)
 VALUES(event_id,event_id,'crm.sales.reminder.tick.v1',jsonb_build_object(
   'schemaVersion',1,'eventId',event_id,'eventType','crm.sales.reminder.tick.v1',
   'occurredAt',to_char(instant,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'jobId',job_id));
 RETURN NEW;
END $$;
COMMIT;
