BEGIN;

ALTER TABLE crm_intake.inbox_entries DROP CONSTRAINT inbox_entries_origin_check;
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_origin_check CHECK (origin IN ('MANUAL', 'API', 'CSV'));
ALTER TABLE crm_intake.inbox_entries DROP CONSTRAINT inbox_entries_origin_source_check;
ALTER TABLE crm_intake.inbox_entries ADD CONSTRAINT inbox_entries_origin_source_check CHECK (
    (origin IN ('MANUAL', 'CSV') AND source_id IS NULL) OR (origin = 'API' AND source_id IS NOT NULL)
);
ALTER TABLE crm_intake.intake_commands DROP CONSTRAINT intake_commands_entity_kind_check;
ALTER TABLE crm_intake.intake_commands ADD CONSTRAINT intake_commands_entity_kind_check CHECK (entity_kind IN ('entry', 'source', 'import'));

CREATE TABLE crm_intake.csv_imports (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    created_by_subject VARCHAR(256) NOT NULL CHECK (char_length(created_by_subject) BETWEEN 1 AND 256 AND created_by_subject !~ '[[:space:][:cntrl:]]'),
    team_id UUID,
    label VARCHAR(200) NOT NULL CHECK (char_length(btrim(label)) > 0 AND label !~ '[/\\[:cntrl:]]' AND label NOT IN ('.', '..')),
    row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 250),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT csv_imports_command_fkey FOREIGN KEY (id) REFERENCES crm_intake.intake_commands(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT csv_imports_workspace_id_id_key UNIQUE (workspace_id, id)
);
CREATE INDEX csv_imports_workspace_id_created_by_subject_created_at_idx ON crm_intake.csv_imports(workspace_id, created_by_subject, created_at);
CREATE INDEX csv_imports_workspace_id_team_id_created_at_idx ON crm_intake.csv_imports(workspace_id, team_id, created_at);

CREATE TABLE crm_intake.csv_import_rows (
    import_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    row_number SMALLINT NOT NULL CHECK (row_number BETWEEN 1 AND 250),
    entry_id UUID NOT NULL,
    audit_command_id UUID NOT NULL UNIQUE,
    PRIMARY KEY (import_id, row_number),
    UNIQUE (workspace_id, entry_id),
    CONSTRAINT csv_import_rows_import_fkey FOREIGN KEY (workspace_id, import_id) REFERENCES crm_intake.csv_imports(workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT csv_import_rows_entry_fkey FOREIGN KEY (workspace_id, entry_id) REFERENCES crm_intake.inbox_entries(workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT csv_import_rows_audit_fkey FOREIGN KEY (audit_command_id) REFERENCES crm_intake.intake_activities(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- A completed immutable receipt proves every bounded row and its own creation audit.
-- Deferred checks permit bulk writes, but neither incomplete batches nor later rows.
CREATE FUNCTION crm_intake.check_csv_import_integrity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    batch_id UUID;
    batch crm_intake.csv_imports%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'csv_imports' THEN batch_id := NEW.id;
    ELSE batch_id := NEW.import_id; END IF;
    SELECT * INTO STRICT batch FROM crm_intake.csv_imports WHERE id = batch_id;
    IF (SELECT count(*) FROM crm_intake.csv_import_rows WHERE import_id = batch_id) <> batch.row_count
       OR EXISTS (
           SELECT 1 FROM crm_intake.csv_import_rows r
           JOIN crm_intake.inbox_entries e ON e.workspace_id = r.workspace_id AND e.id = r.entry_id
           JOIN crm_intake.intake_activities a ON a.command_id = r.audit_command_id
           WHERE r.import_id = batch_id AND (
               r.row_number > batch.row_count OR e.origin <> 'CSV' OR e.source_id IS NOT NULL
               OR e.created_by_subject <> batch.created_by_subject OR e.team_id IS DISTINCT FROM batch.team_id
               OR a.workspace_id <> batch.workspace_id OR a.entity_id <> e.id OR a.entity_kind <> 'entry'
               OR a.actor_subject <> batch.created_by_subject OR a.action <> 'CREATED' OR a.entity_version <> 1
           )
       ) OR NOT EXISTS (
           SELECT 1 FROM crm_intake.intake_commands c WHERE c.command_id = batch_id
           AND c.workspace_id = batch.workspace_id AND c.entity_id = batch_id
           AND c.entity_kind = 'import' AND c.actor_subject = batch.created_by_subject
       ) THEN
        RAISE EXCEPTION 'Invalid CSV import proof' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER csv_imports_integrity_check AFTER INSERT ON crm_intake.csv_imports
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.check_csv_import_integrity();
CREATE CONSTRAINT TRIGGER csv_import_rows_integrity_check AFTER INSERT ON crm_intake.csv_import_rows
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_intake.check_csv_import_integrity();

COMMIT;
