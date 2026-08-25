BEGIN;

LOCK TABLE "notes", "admin_event_logs" IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE "OperationsCoreOwnership" AS ENUM ('CORE', 'OPERATIONS');

CREATE TABLE "operations_core_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "ownership" "OperationsCoreOwnership" NOT NULL DEFAULT 'CORE',
    "source_writes_enabled" BOOLEAN NOT NULL DEFAULT true,
    "legacy_routes_enabled" BOOLEAN NOT NULL DEFAULT true,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "prepared_revision" TEXT,
    "ownership_revision" TEXT,
    "source_snapshot_sha256" TEXT,
    "source_note_count" BIGINT,
    "source_event_count" BIGINT,
    "fenced_at" TIMESTAMP(3),
    "exported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operations_core_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operations_core_state_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "operations_core_state_generation_check" CHECK ("generation" >= 0),
    CONSTRAINT "operations_core_state_revision_check" CHECK (
        ("prepared_revision" IS NULL OR "prepared_revision" ~ '^[0-9a-f]{40}$')
        AND ("ownership_revision" IS NULL OR "ownership_revision" ~ '^[0-9a-f]{40}$')
    ),
    CONSTRAINT "operations_core_state_snapshot_check" CHECK (
        ("source_snapshot_sha256" IS NULL OR "source_snapshot_sha256" ~ '^[0-9a-f]{64}$')
        AND ("source_note_count" IS NULL OR "source_note_count" >= 0)
        AND ("source_event_count" IS NULL OR "source_event_count" >= 0)
    ),
    CONSTRAINT "operations_core_state_activation_check" CHECK (
        "ownership" = 'CORE'::"OperationsCoreOwnership"
        OR (
            "source_writes_enabled" = false
            AND "legacy_routes_enabled" = false
            AND "prepared_revision" IS NOT NULL
            AND "ownership_revision" = "prepared_revision"
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_note_count" IS NOT NULL
            AND "source_event_count" IS NOT NULL
            AND "fenced_at" IS NOT NULL
            AND "exported_at" IS NOT NULL
            AND "activated_at" IS NOT NULL
        )
    )
);

INSERT INTO "operations_core_state" ("id") VALUES ('singleton');

CREATE FUNCTION "operations_core_state_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."ownership" = 'OPERATIONS'::"OperationsCoreOwnership" THEN
        IF NEW."ownership" <> 'OPERATIONS'::"OperationsCoreOwnership"
            OR NEW."source_writes_enabled"
            OR NEW."legacy_routes_enabled"
            OR NEW."prepared_revision" IS DISTINCT FROM OLD."prepared_revision"
            OR NEW."ownership_revision" IS DISTINCT FROM OLD."ownership_revision"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_note_count" IS DISTINCT FROM OLD."source_note_count"
            OR NEW."source_event_count" IS DISTINCT FROM OLD."source_event_count"
        THEN
            RAISE EXCEPTION 'Operations ownership is forward-only';
        END IF;
    END IF;

    IF OLD."source_writes_enabled" = false AND NEW."source_writes_enabled" = true THEN
        RAISE EXCEPTION 'Operations Core write fence is forward-only';
    END IF;

    IF NEW."ownership" = 'OPERATIONS'::"OperationsCoreOwnership"
        AND OLD."ownership" <> 'OPERATIONS'::"OperationsCoreOwnership"
        AND (
            OLD."source_writes_enabled"
            OR OLD."fenced_at" IS NULL
            OR OLD."exported_at" IS NULL
            OR OLD."source_snapshot_sha256" IS NULL
            OR OLD."source_note_count" IS NULL
            OR OLD."source_event_count" IS NULL
        )
    THEN
        RAISE EXCEPTION 'Operations source must be fenced and exported before activation';
    END IF;

    NEW."updated_at" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "operations_core_state_transition_guard"
BEFORE UPDATE ON "operations_core_state"
FOR EACH ROW EXECUTE FUNCTION "operations_core_state_transition_guard"();

CREATE FUNCTION "operations_core_source_write_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    writes_enabled BOOLEAN;
BEGIN
    SELECT
        "ownership" = 'CORE'::"OperationsCoreOwnership"
        AND "source_writes_enabled"
    INTO writes_enabled
    FROM "operations_core_state"
    WHERE "id" = 'singleton';

    IF writes_enabled IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Operations Core source is write-fenced';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "notes_operations_source_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "notes"
FOR EACH ROW EXECUTE FUNCTION "operations_core_source_write_guard"();

CREATE TRIGGER "notes_operations_source_truncate_guard"
BEFORE TRUNCATE ON "notes"
FOR EACH STATEMENT EXECUTE FUNCTION "operations_core_source_write_guard"();

CREATE TRIGGER "admin_event_logs_operations_source_write_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "admin_event_logs"
FOR EACH ROW EXECUTE FUNCTION "operations_core_source_write_guard"();

CREATE TRIGGER "admin_event_logs_operations_source_truncate_guard"
BEFORE TRUNCATE ON "admin_event_logs"
FOR EACH STATEMENT EXECUTE FUNCTION "operations_core_source_write_guard"();

REVOKE ALL ON TABLE "operations_core_state" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "operations_core_state_transition_guard"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "operations_core_source_write_guard"() FROM PUBLIC;

DO $$
DECLARE
    role_name TEXT;
BEGIN
    FOREACH role_name IN ARRAY ARRAY[
        'winwidget_runtime',
        'winwidget_backup',
        'winwidget_maintenance'
    ] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format(
                'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "operations_core_state" FROM %I',
                role_name
            );
            EXECUTE format(
                'GRANT SELECT ON TABLE "operations_core_state" TO %I',
                role_name
            );
        END IF;
    END LOOP;
END
$$;

COMMIT;
