BEGIN;

CREATE TYPE "operations"."OperationsDatabasePhase" AS ENUM (
    'EMPTY',
    'IMPORTED',
    'ACTIVE'
);

CREATE TABLE "operations"."operations_ownership_state" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "phase" "operations"."OperationsDatabasePhase" NOT NULL DEFAULT 'EMPTY',
    "source_revision" TEXT,
    "source_snapshot_sha256" TEXT,
    "source_note_count" BIGINT,
    "source_event_count" BIGINT,
    "imported_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operations_ownership_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operations_ownership_state_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "operations_ownership_state_revision_check" CHECK (
        "source_revision" IS NULL OR "source_revision" ~ '^[0-9a-f]{40}$'
    ),
    CONSTRAINT "operations_ownership_state_snapshot_check" CHECK (
        "source_snapshot_sha256" IS NULL OR "source_snapshot_sha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "operations_ownership_state_counts_check" CHECK (
        ("source_note_count" IS NULL OR "source_note_count" >= 0)
        AND ("source_event_count" IS NULL OR "source_event_count" >= 0)
    ),
    CONSTRAINT "operations_ownership_state_phase_check" CHECK (
        (
            "phase" = 'EMPTY'::"operations"."OperationsDatabasePhase"
            AND "source_revision" IS NULL
            AND "source_snapshot_sha256" IS NULL
            AND "source_note_count" IS NULL
            AND "source_event_count" IS NULL
            AND "imported_at" IS NULL
            AND "activated_at" IS NULL
        )
        OR (
            "phase" = 'IMPORTED'::"operations"."OperationsDatabasePhase"
            AND "source_revision" IS NOT NULL
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_note_count" IS NOT NULL
            AND "source_event_count" IS NOT NULL
            AND "imported_at" IS NOT NULL
            AND "activated_at" IS NULL
        )
        OR (
            "phase" = 'ACTIVE'::"operations"."OperationsDatabasePhase"
            AND "source_revision" IS NOT NULL
            AND "source_snapshot_sha256" IS NOT NULL
            AND "source_note_count" IS NOT NULL
            AND "source_event_count" IS NOT NULL
            AND "imported_at" IS NOT NULL
            AND "activated_at" IS NOT NULL
        )
    )
);

CREATE UNIQUE INDEX "operations_ownership_state_source_snapshot_sha256_key"
ON "operations"."operations_ownership_state"("source_snapshot_sha256");

INSERT INTO "operations"."operations_ownership_state" ("id")
VALUES ('singleton');

CREATE FUNCTION "operations"."operations_ownership_transition_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."phase" = 'EMPTY'::"operations"."OperationsDatabasePhase"
        AND NEW."phase" NOT IN (
            'EMPTY'::"operations"."OperationsDatabasePhase",
            'IMPORTED'::"operations"."OperationsDatabasePhase"
        )
    THEN
        RAISE EXCEPTION 'Operations ownership must be imported before activation';
    END IF;

    IF OLD."phase" = 'IMPORTED'::"operations"."OperationsDatabasePhase"
        AND (
            NEW."phase" NOT IN (
                'IMPORTED'::"operations"."OperationsDatabasePhase",
                'ACTIVE'::"operations"."OperationsDatabasePhase"
            )
            OR NEW."source_revision" IS DISTINCT FROM OLD."source_revision"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_note_count" IS DISTINCT FROM OLD."source_note_count"
            OR NEW."source_event_count" IS DISTINCT FROM OLD."source_event_count"
            OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
        )
    THEN
        RAISE EXCEPTION 'Operations imported snapshot is immutable';
    END IF;

    IF OLD."phase" = 'ACTIVE'::"operations"."OperationsDatabasePhase" THEN
        IF NEW."phase" <> 'ACTIVE'::"operations"."OperationsDatabasePhase"
            OR NEW."source_revision" IS DISTINCT FROM OLD."source_revision"
            OR NEW."source_snapshot_sha256" IS DISTINCT FROM OLD."source_snapshot_sha256"
            OR NEW."source_note_count" IS DISTINCT FROM OLD."source_note_count"
            OR NEW."source_event_count" IS DISTINCT FROM OLD."source_event_count"
            OR NEW."imported_at" IS DISTINCT FROM OLD."imported_at"
            OR NEW."activated_at" IS DISTINCT FROM OLD."activated_at"
        THEN
            RAISE EXCEPTION 'Operations ownership is forward-only';
        END IF;
    END IF;

    NEW."updated_at" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "operations_ownership_transition_guard"
BEFORE UPDATE ON "operations"."operations_ownership_state"
FOR EACH ROW EXECUTE FUNCTION "operations"."operations_ownership_transition_guard"();

REVOKE ALL ON TABLE "operations"."operations_ownership_state" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "operations"."operations_ownership_transition_guard"() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'winwidget_operations_runtime'
    ) THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
        ON TABLE "operations"."operations_ownership_state"
        FROM "winwidget_operations_runtime";
        GRANT SELECT ON TABLE "operations"."operations_ownership_state"
        TO "winwidget_operations_runtime";
    END IF;
END
$$;

COMMIT;
