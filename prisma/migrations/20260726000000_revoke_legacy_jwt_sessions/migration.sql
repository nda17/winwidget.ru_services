-- Refresh tokens issued before opaque rotation are no longer accepted.
UPDATE "user_sessions"
SET "revoked_at" = CURRENT_TIMESTAMP
WHERE "revoked_at" IS NULL;
