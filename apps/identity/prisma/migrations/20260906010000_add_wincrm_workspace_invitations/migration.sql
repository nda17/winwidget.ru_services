BEGIN;

ALTER TABLE identity.workspace_members
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN created_by_product VARCHAR(32),
  ADD COLUMN created_by_invitation_id UUID,
  ADD CONSTRAINT workspace_members_version_check CHECK (version > 0),
  ADD CONSTRAINT workspace_members_product_origin_check CHECK (
    (created_by_product IS NULL AND created_by_invitation_id IS NULL)
    OR (created_by_product IS NOT NULL AND created_by_product = 'WINCRM' AND created_by_invitation_id IS NOT NULL AND role = 'MEMBER')
  );

CREATE UNIQUE INDEX workspace_members_created_by_invitation_id_key
  ON identity.workspace_members(created_by_invitation_id);

CREATE TABLE identity.workspace_invitations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES identity.workspaces(id) ON DELETE RESTRICT,
  product_code VARCHAR(32) NOT NULL DEFAULT 'WINCRM' CHECK (product_code = 'WINCRM'),
  inviter_subject VARCHAR(256) NOT NULL,
  email VARCHAR(254) NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
	 notification_event_id UUID UNIQUE,
  expires_at TIMESTAMP(3) NOT NULL,
  accepted_at TIMESTAMP(3),
  accepted_subject VARCHAR(256),
  acceptance_id UUID UNIQUE,
  accepted_membership_id UUID REFERENCES identity.workspace_members(id) ON DELETE RESTRICT,
  email_verified_at TIMESTAMP(3),
  revoked_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT workspace_invitations_acceptance_check CHECK (
    (accepted_at IS NULL AND accepted_subject IS NULL AND acceptance_id IS NULL AND accepted_membership_id IS NULL AND email_verified_at IS NULL AND status <> 'ACCEPTED')
    OR (accepted_at IS NOT NULL AND accepted_subject IS NOT NULL AND acceptance_id IS NOT NULL AND accepted_membership_id IS NOT NULL AND email_verified_at IS NOT NULL AND status IN ('ACCEPTED', 'REVOKED'))
  ),
  CONSTRAINT workspace_invitations_revoke_check CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CONSTRAINT workspace_invitations_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '7 days')
);
CREATE INDEX workspace_invitations_workspace_id_status_created_at_idx ON identity.workspace_invitations(workspace_id, status, created_at);
ALTER TABLE identity.workspace_members ADD CONSTRAINT workspace_members_created_by_invitation_id_fkey
  FOREIGN KEY (created_by_invitation_id) REFERENCES identity.workspace_invitations(id) ON DELETE RESTRICT;

COMMIT;
