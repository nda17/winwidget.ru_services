BEGIN;

-- Additive CRM-owned setting: absence preserves the existing unbranded UI.
-- Clearing retains the versioned row, preventing stale version-zero commands.
CREATE TABLE crm_access.crm_workspace_branding (
  workspace_id UUID PRIMARY KEY REFERENCES crm_access.crm_workspace_access(workspace_id) ON DELETE RESTRICT,
  display_name VARCHAR(40),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT crm_workspace_branding_display_name_check CHECK (
    display_name IS NULL OR (
      char_length(display_name) BETWEEN 1 AND 40
      AND display_name = btrim(display_name)
      AND display_name = normalize(display_name, NFC)
      AND display_name !~ '[[:cntrl:]<>]'
      AND display_name !~ U&'[\2028\2029]'
    )
  )
);

COMMIT;
