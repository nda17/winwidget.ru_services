DROP TABLE "operations"."operations_control_plane_bootstrap_state";

DROP TRIGGER "operations_ownership_transition_guard"
ON "operations"."operations_ownership_state";

DROP FUNCTION "operations"."operations_ownership_transition_guard"();

DROP TABLE "operations"."operations_ownership_state";

DROP TYPE "operations"."OperationsDatabasePhase";

CREATE TABLE "operations"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'operations-service',
    "database_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_identity_singleton_check" CHECK (
        "id" = 'singleton' AND "service_name" = 'operations-service'
    )
);

CREATE UNIQUE INDEX "service_identity_database_id_key"
ON "operations"."service_identity"("database_id");

INSERT INTO "operations"."service_identity" (
    "id", "service_name", "database_id", "updated_at"
) VALUES (
    'singleton', 'operations-service', gen_random_uuid(), CURRENT_TIMESTAMP
);

REVOKE ALL ON TABLE "operations"."service_identity" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'winwidget_operations_runtime'
    ) THEN
        GRANT SELECT ON TABLE "operations"."service_identity"
        TO "winwidget_operations_runtime";
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname = 'winwidget_operations_backup'
    ) THEN
        GRANT SELECT ON TABLE "operations"."service_identity"
        TO "winwidget_operations_backup";
    END IF;
END
$$;
