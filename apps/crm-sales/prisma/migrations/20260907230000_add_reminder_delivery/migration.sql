BEGIN;
CREATE TABLE crm_sales.reminder_jobs (
 id uuid PRIMARY KEY, period_key varchar(160) NOT NULL UNIQUE,
 workspace_id uuid, task_id uuid, cursor uuid,
 status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','COMPLETED')),
 available_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token uuid, lease_expires_at timestamp(3), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at timestamp(3)
);
CREATE INDEX reminder_jobs_status_available_at_idx ON crm_sales.reminder_jobs(status,available_at);
CREATE TABLE crm_sales.reminder_deliveries (
 id uuid PRIMARY KEY, deduplication_key char(64) NOT NULL UNIQUE CHECK(deduplication_key ~ '^[a-f0-9]{64}$'),
 workspace_id uuid NOT NULL, task_id uuid NOT NULL, rule_id uuid NOT NULL,
 task_version integer NOT NULL CHECK(task_version>=1), rule_version integer NOT NULL CHECK(rule_version>=1),
 occurrence_index integer NOT NULL CHECK(occurrence_index BETWEEN 0 AND 999),
 recipient_subject varchar(256) NOT NULL CHECK(recipient_subject ~ '^[^[:space:][:cntrl:]]{1,256}$'),
 recipient_membership_id uuid, channel varchar(16) NOT NULL CHECK(channel IN ('EMAIL','TELEGRAM')),
 nominal_at timestamp(3) NOT NULL, status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CANCELLED')),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(task_id,workspace_id) REFERENCES crm_sales.tasks(id,workspace_id) ON DELETE RESTRICT,
 FOREIGN KEY(rule_id,workspace_id) REFERENCES crm_sales.reminder_rules(id,workspace_id) ON DELETE RESTRICT
);
CREATE INDEX reminder_deliveries_workspace_id_task_id_status_idx ON crm_sales.reminder_deliveries(workspace_id,task_id,status);
CREATE INDEX reminder_deliveries_workspace_id_rule_id_status_idx ON crm_sales.reminder_deliveries(workspace_id,rule_id,status);
CREATE TABLE crm_sales.reminder_outbox (
 id uuid PRIMARY KEY, message_id uuid NOT NULL, event_type varchar(120) NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 available_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','PUBLISHED')),
 lease_token uuid, lease_expires_at timestamp(3), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at timestamp(3)
);
CREATE INDEX reminder_outbox_status_available_at_created_at_idx ON crm_sales.reminder_outbox(status,available_at,created_at);
CREATE TABLE crm_sales.reminder_runtime (
 id varchar(32) PRIMARY KEY CHECK(id='reminders'), revision varchar(64) NOT NULL,
 ready boolean NOT NULL, last_seen_at timestamp(3) NOT NULL
);

-- Invoker rights only. Every task/rule mutation invalidates existing generation
-- and commits its own wake-up Outbox atomically, including old v1 task writers.
CREATE FUNCTION crm_sales.wake_task_reminders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_id uuid := gen_random_uuid(); event_id uuid := gen_random_uuid();
 period text; target_task uuid; instant timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC');
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
   target_task := NEW.id;
   IF TG_OP='UPDATE' THEN
     UPDATE crm_sales.reminder_deliveries SET status='CANCELLED'
     WHERE workspace_id=NEW.workspace_id AND task_id=NEW.id AND status='PENDING';
   END IF;
   period := 'task:'||NEW.id::text||':'||NEW.version::text||':'||event_id::text;
 ELSE
   UPDATE crm_sales.reminder_deliveries SET status='CANCELLED'
   WHERE workspace_id=NEW.workspace_id AND rule_id=NEW.id AND status='PENDING';
   period := 'rule:'||NEW.id::text||':'||NEW.version::text||':'||event_id::text;
 END IF;
 -- Disabled-only workspaces must not start background work before activation.
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
CREATE TRIGGER tasks_reminder_wake AFTER INSERT OR UPDATE OF version,due_at,status,assigned_to_subject,assigned_to_membership_id,team_id ON crm_sales.tasks
FOR EACH ROW EXECUTE FUNCTION crm_sales.wake_task_reminders();
CREATE TRIGGER rules_reminder_wake AFTER INSERT OR UPDATE OF version,configuration,archived_at ON crm_sales.reminder_rules
FOR EACH ROW EXECUTE FUNCTION crm_sales.wake_task_reminders();
REVOKE ALL ON FUNCTION crm_sales.wake_task_reminders() FROM PUBLIC;
REVOKE ALL ON crm_sales.reminder_jobs,crm_sales.reminder_deliveries,crm_sales.reminder_outbox,crm_sales.reminder_runtime FROM PUBLIC;
COMMIT;
