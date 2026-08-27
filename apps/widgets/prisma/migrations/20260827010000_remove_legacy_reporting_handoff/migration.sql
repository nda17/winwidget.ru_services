ALTER TABLE "widgets"."service_identity"
DROP CONSTRAINT "service_identity_singleton_check";

ALTER TABLE "widgets"."service_identity"
DROP COLUMN "ownership_generation",
DROP COLUMN "source_database_fingerprint",
DROP COLUMN "source_exported_at",
DROP COLUMN "source_snapshot_sha256",
DROP COLUMN "source_snapshot_counts",
DROP COLUMN "source_reporting_high_water",
DROP COLUMN "handoff_started_at",
DROP COLUMN "ownership_activated_at";

ALTER TABLE "widgets"."service_identity"
ADD CONSTRAINT "service_identity_singleton_check"
CHECK ("id" = 'widgets-service');
