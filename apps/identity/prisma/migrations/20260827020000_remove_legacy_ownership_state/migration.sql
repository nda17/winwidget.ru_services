ALTER TABLE "identity"."service_identity"
    DROP COLUMN "phase",
    DROP COLUMN "ownership_generation",
    DROP COLUMN "source_fingerprint",
    DROP COLUMN "source_snapshot_sha256",
    DROP COLUMN "source_snapshot_counts",
    DROP COLUMN "source_identity_high_water",
    DROP COLUMN "source_billing_high_water",
    DROP COLUMN "imported_at",
    DROP COLUMN "activated_at",
    ADD CONSTRAINT "service_identity_singleton_check" CHECK (
        "id" = 'singleton' AND "service_name" = 'identity-service'
    );

DROP TYPE "identity"."ServiceDatabasePhase";

CREATE UNIQUE INDEX "service_identity_database_id_key"
ON "identity"."service_identity"("database_id");
