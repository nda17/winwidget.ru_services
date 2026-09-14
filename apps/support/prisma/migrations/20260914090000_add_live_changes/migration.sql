BEGIN;
-- Live signals contain only the service-owned routing scope, never record data.
-- PostgreSQL delivers NOTIFY after commit and fans it out to every API listener.
-- Missed signals are recovered by authorized HTTP reads after each reconnect.
CREATE FUNCTION support.notify_live_change() RETURNS trigger
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
REVOKE ALL ON FUNCTION support.notify_live_change() FROM PUBLIC;
CREATE TRIGGER web_conversations_live_change AFTER INSERT OR UPDATE OR DELETE ON support.web_conversations
FOR EACH ROW EXECUTE FUNCTION support.notify_live_change('author_subject');


CREATE FUNCTION support.notify_live_read() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE recipient text;
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.through_sequence = NEW.through_sequence THEN RETURN NULL; END IF;
 SELECT author_subject INTO recipient FROM support.web_conversations WHERE id = NEW.conversation_id;
 IF recipient IS NOT NULL THEN PERFORM pg_notify('crm_live_changes_v1', recipient); END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION support.notify_live_read() FROM PUBLIC;
CREATE TRIGGER web_read_states_live_change AFTER INSERT OR UPDATE ON support.web_read_states
FOR EACH ROW EXECUTE FUNCTION support.notify_live_read();
COMMIT;
