BEGIN;
CREATE TABLE crm_access.crm_employee_profiles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT,
  subject varchar(256) NOT NULL CHECK (length(subject) BETWEEN 1 AND 256 AND subject !~ '[[:space:][:cntrl:]]'),
  first_name varchar(100) NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100 AND first_name !~ '[[:cntrl:]]'),
  last_name varchar(100) NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100 AND last_name !~ '[[:cntrl:]]'),
  middle_name varchar(100) CHECK (length(btrim(middle_name)) BETWEEN 1 AND 100 AND middle_name !~ '[[:cntrl:]]'),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL,
  CONSTRAINT crm_employee_profiles_workspace_id_subject_key UNIQUE(workspace_id, subject)
);
CREATE INDEX crm_employee_profiles_workspace_id_last_name_first_name_id_idx
  ON crm_access.crm_employee_profiles(workspace_id, last_name, first_name, id);
ALTER TABLE crm_access.crm_invitation_intents
  ADD COLUMN first_name varchar(100),
  ADD COLUMN last_name varchar(100),
  ADD COLUMN middle_name varchar(100),
  ADD CONSTRAINT crm_invitation_employee_name_check CHECK (
    (first_name IS NULL AND last_name IS NULL AND middle_name IS NULL) OR
    (first_name IS NOT NULL AND last_name IS NOT NULL
      AND length(btrim(first_name)) BETWEEN 1 AND 100 AND first_name !~ '[[:cntrl:]]'
      AND length(btrim(last_name)) BETWEEN 1 AND 100 AND last_name !~ '[[:cntrl:]]'
      AND (middle_name IS NULL OR (length(btrim(middle_name)) BETWEEN 1 AND 100 AND middle_name !~ '[[:cntrl:]]')))
  );
-- No backfill: existing memberships and task assignments stay intact.
COMMIT;
