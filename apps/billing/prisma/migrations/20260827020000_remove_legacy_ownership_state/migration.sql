DROP TRIGGER "billing_ownership_forward_only"
ON "billing"."billing_ownership_marker";

DROP FUNCTION "billing"."enforce_ownership_forward_only"();

DROP TABLE "billing"."billing_ownership_marker";

DROP TYPE "billing"."BillingOwnershipPhase";

DROP TRIGGER "billing_service_identity_forward_only"
ON "billing"."service_identity";

DROP FUNCTION "billing"."enforce_service_identity"();

ALTER TABLE "billing"."service_identity"
    DROP CONSTRAINT "service_identity_generation_check",
    DROP CONSTRAINT "service_identity_high_water_check",
    DROP COLUMN "phase",
    DROP COLUMN "ownership_generation",
    DROP COLUMN "source_fingerprint",
    DROP COLUMN "source_snapshot",
    DROP COLUMN "source_high_watermark",
    DROP COLUMN "imported_at",
    DROP COLUMN "activated_at";

DROP TYPE "billing"."ServiceDatabasePhase";

CREATE UNIQUE INDEX "service_identity_database_id_key"
ON "billing"."service_identity"("database_id");
