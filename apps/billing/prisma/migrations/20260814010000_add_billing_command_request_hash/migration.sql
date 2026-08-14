-- Existing receipts do not retain their original request payload, so their
-- canonical hash cannot be reconstructed safely. Version 0 is an explicit
-- fail-closed legacy marker; every command written by this application release
-- explicitly uses canonical hash version 1. The version-0 defaults keep an old
-- process safe during a rolling migration without pretending its payload was
-- bound.
ALTER TABLE "billing"."command_receipts"
  ADD COLUMN "request_hash" CHAR(64) NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN "request_hash_version" SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE "billing"."command_receipts"
  ADD CONSTRAINT "command_receipts_request_hash_check"
  CHECK (
    (
      "request_hash_version" = 0
      AND "request_hash" = '0000000000000000000000000000000000000000000000000000000000000000'
    )
    OR (
      "request_hash_version" = 1
      AND "request_hash" ~ '^[0-9a-f]{64}$'
    )
  );
