BEGIN;

DO $$
BEGIN
    IF to_regnamespace('crm_intake') IS NULL THEN
        EXECUTE 'CREATE SCHEMA "crm_intake"';
    END IF;
END
$$;

CREATE TABLE "crm_intake"."service_identity" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "service_name" TEXT NOT NULL DEFAULT 'crm-intake-service',
    "database_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_identity_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "service_identity_name_check" CHECK ("service_name" = 'crm-intake-service')
);

CREATE UNIQUE INDEX "service_identity_database_id_key"
ON "crm_intake"."service_identity"("database_id");

INSERT INTO "crm_intake"."service_identity" (
    "id",
    "service_name",
    "database_id",
    "created_at",
    "updated_at"
) VALUES (
    'singleton',
    'crm-intake-service',
    gen_random_uuid(),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

COMMIT;
