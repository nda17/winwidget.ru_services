BEGIN;
-- Live signals contain only the service-owned routing scope, never record data.
-- PostgreSQL delivers NOTIFY after commit and fans it out to every API listener.
-- Missed signals are recovered by authorized HTTP reads after each reconnect.
CREATE FUNCTION crm_intake.notify_live_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_scope text; previous_scope text;
BEGIN
 IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 IF TG_OP <> 'DELETE' THEN current_scope := to_jsonb(NEW)->>TG_ARGV[0]; END IF;
 IF TG_OP <> 'INSERT' THEN previous_scope := to_jsonb(OLD)->>TG_ARGV[0]; END IF;
 IF current_scope IS NOT NULL THEN PERFORM pg_notify('crm_live_changes_v1', current_scope); END IF;
 IF previous_scope IS NOT NULL AND previous_scope IS DISTINCT FROM current_scope THEN
  PERFORM pg_notify('crm_live_changes_v1', previous_scope);
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crm_intake.notify_live_change() FROM PUBLIC;
CREATE TRIGGER inbox_entries_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.inbox_entries
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER intake_sources_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.intake_sources
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER intake_activities_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.intake_activities
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER csv_imports_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.csv_imports
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER acceptances_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.acceptances
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER managed_widget_sources_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.managed_widget_sources
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
CREATE TRIGGER sla_jobs_live_change AFTER INSERT OR UPDATE OR DELETE ON crm_intake.sla_jobs
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');


-- One durable occurrence per NEW insert. Existing entries are not backfilled.
CREATE TABLE crm_intake.inbox_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 entry_id uuid NOT NULL UNIQUE, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id, workspace_id), UNIQUE(workspace_id, entry_id),
 FOREIGN KEY(workspace_id, entry_id) REFERENCES crm_intake.inbox_entries(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX inbox_notifications_workspace_id_created_at_id_idx ON crm_intake.inbox_notifications(workspace_id, created_at, id);
CREATE TABLE crm_intake.inbox_notification_reads (
 notification_id uuid NOT NULL, workspace_id uuid NOT NULL, recipient_subject varchar(256) NOT NULL,
 read_at timestamp(3), PRIMARY KEY(notification_id, recipient_subject),
 FOREIGN KEY(notification_id, workspace_id) REFERENCES crm_intake.inbox_notifications(id, workspace_id) ON DELETE CASCADE
);
REVOKE ALL ON crm_intake.inbox_notifications, crm_intake.inbox_notification_reads FROM PUBLIC;
CREATE FUNCTION crm_intake.record_inbox_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 INSERT INTO crm_intake.inbox_notifications(workspace_id, entry_id) VALUES(NEW.workspace_id, NEW.id);
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION crm_intake.record_inbox_notification() FROM PUBLIC;
CREATE TRIGGER inbox_entries_notification AFTER INSERT ON crm_intake.inbox_entries
FOR EACH ROW EXECUTE FUNCTION crm_intake.record_inbox_notification();
CREATE TRIGGER inbox_notification_reads_live_change AFTER INSERT OR UPDATE ON crm_intake.inbox_notification_reads
FOR EACH ROW EXECUTE FUNCTION crm_intake.notify_live_change('workspace_id');
COMMIT;
