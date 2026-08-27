BEGIN;

ALTER TABLE "support"."service_identity"
    DROP CONSTRAINT IF EXISTS "service_identity_generation_check",
    DROP CONSTRAINT IF EXISTS "service_identity_source_check";

DO $support_identity_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "support"."service_identity"
        WHERE "id" = 'singleton'
            AND "service_name" = 'support-service'
            AND "database_id" IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Support database identity marker is invalid';
    END IF;
END
$support_identity_check$;

ALTER TABLE "support"."service_identity"
    DROP COLUMN "phase",
    DROP COLUMN "ownership_generation",
    DROP COLUMN "source_database_system_id",
    DROP COLUMN "source_revision",
    DROP COLUMN "ownership_revision",
    DROP COLUMN "source_fingerprint",
    DROP COLUMN "source_snapshot_sha256",
    DROP COLUMN "source_snapshot_counts",
    DROP COLUMN "source_high_watermark",
    DROP COLUMN "imported_at",
    DROP COLUMN "activated_at";

DROP TYPE "support"."ServiceDatabasePhase";

CREATE FUNCTION "support"."enforce_service_identity_integrity"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, support
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Support service identity cannot be deleted';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."service_name" IS DISTINCT FROM OLD."service_name"
        OR NEW."database_id" IS DISTINCT FROM OLD."database_id"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
        OR NEW."updated_at" < OLD."updated_at" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Support database identity marker is immutable';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION "support"."enforce_service_identity_integrity"() FROM PUBLIC;

CREATE TRIGGER "service_identity_integrity_guard"
BEFORE UPDATE OR DELETE ON "support"."service_identity"
FOR EACH ROW
EXECUTE FUNCTION "support"."enforce_service_identity_integrity"();

COMMIT;
