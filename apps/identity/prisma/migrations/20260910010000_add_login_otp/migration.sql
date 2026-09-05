BEGIN;

CREATE TABLE identity.login_otp_challenges (
  id UUID PRIMARY KEY,
  purpose VARCHAR(32) NOT NULL DEFAULT 'LOGIN_FALLBACK' CHECK (purpose = 'LOGIN_FALLBACK'),
  channel VARCHAR(8) NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  user_id TEXT REFERENCES identity.users(id) ON DELETE CASCADE,
  auth_identity_id TEXT,
  identity_verified_at TIMESTAMP(3),
  destination_hash CHAR(64) NOT NULL CHECK (destination_hash ~ '^[a-f0-9]{64}$'),
  browser_token_hash CHAR(64) NOT NULL CHECK (browser_token_hash ~ '^[a-f0-9]{64}$'),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT login_otp_challenges_subject_check CHECK (
    (user_id IS NULL AND auth_identity_id IS NULL AND identity_verified_at IS NULL)
    OR (user_id IS NOT NULL AND auth_identity_id IS NOT NULL AND identity_verified_at IS NOT NULL)
  ),
  CONSTRAINT login_otp_challenges_expiry_check CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'
  )
);
CREATE INDEX login_otp_challenges_expires_at_id_idx ON identity.login_otp_challenges(expires_at, id);
CREATE INDEX login_otp_challenges_user_id_idx ON identity.login_otp_challenges(user_id);

CREATE TABLE identity.login_otp_rate_limits (
  key CHAR(64) PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX login_otp_rate_limits_expires_at_key_idx ON identity.login_otp_rate_limits(expires_at, key);

COMMIT;
