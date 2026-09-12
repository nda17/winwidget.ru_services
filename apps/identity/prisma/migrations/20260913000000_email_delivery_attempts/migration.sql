BEGIN;

ALTER TABLE identity.verification_challenges
  ADD COLUMN email_delivery_managed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN email_resend_available_at TIMESTAMP(3),
  ADD COLUMN delivery_lease_token UUID,
  ADD COLUMN delivery_lease_expires_at TIMESTAMP(3);

CREATE TABLE identity.verification_email_attempts (
  id UUID PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES identity.verification_challenges(id) ON DELETE CASCADE ON UPDATE CASCADE,
  value TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  password_hash TEXT,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN')),
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verification_email_attempts_challenge_id_created_at_idx
  ON identity.verification_email_attempts(challenge_id, created_at);
CREATE INDEX verification_email_attempts_expires_at_id_idx
  ON identity.verification_email_attempts(expires_at, id);

CREATE TABLE identity.email_password_recoveries (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  auth_identity_id TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  identity_verified_at TIMESTAMP(3),
  password_hash TEXT NOT NULL,
  base_password_hash TEXT NOT NULL,
  outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN')),
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TIMESTAMP(3)
);
CREATE INDEX email_password_recoveries_user_id_created_at_idx
  ON identity.email_password_recoveries(user_id, created_at);
CREATE INDEX email_password_recoveries_expires_at_idx
  ON identity.email_password_recoveries(expires_at);

COMMIT;
