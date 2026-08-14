ALTER TABLE campaigns.audience_snapshots
    ADD COLUMN billing_snapshot_id UUID,
    ADD COLUMN billing_snapshot_sha256 CHAR(64),
    ADD COLUMN billing_snapshot_as_of TIMESTAMP(3);

ALTER TABLE campaigns.audience_snapshots
    ADD CONSTRAINT audience_snapshots_billing_sha256_check
    CHECK (
        billing_snapshot_sha256 IS NULL
        OR billing_snapshot_sha256 ~ '^[0-9a-f]{64}$'
    );
