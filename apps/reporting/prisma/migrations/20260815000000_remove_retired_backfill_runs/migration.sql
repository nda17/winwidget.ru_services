BEGIN;
SET LOCAL lock_timeout = '30s';

LOCK TABLE reporting."heartbeats" IN ACCESS EXCLUSIVE MODE;

DELETE FROM reporting."heartbeats" WHERE "role" = 'backfill';

ALTER TABLE reporting."heartbeats"
    DROP CONSTRAINT "heartbeats_identity_check";
ALTER TABLE reporting."heartbeats"
    ADD CONSTRAINT "heartbeats_identity_check" CHECK (
        "role" IN ('all', 'api', 'worker', 'publisher', 'scheduler')
        AND char_length(btrim("instance_id")) BETWEEN 1 AND 255
        AND jsonb_typeof("metadata") = 'object'
    );

DROP TABLE IF EXISTS reporting."backfill_runs";
DROP TYPE IF EXISTS reporting."ReportingBackfillStatus";

COMMIT;
