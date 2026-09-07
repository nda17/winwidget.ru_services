BEGIN;

-- Optional manual/provider-confirmed requisites; no backfill, duplicate merge,
-- new owner, new enum or change to the existing company/customer ACL boundary.
ALTER TABLE "crm_customers"."companies"
    ADD COLUMN "legal_name" VARCHAR(2000),
    ADD COLUMN "kpp" VARCHAR(9),
    ADD COLUMN "ogrn" VARCHAR(15),
    ADD COLUMN "legal_address" VARCHAR(2000),
    ADD COLUMN "entity_type" VARCHAR(16),
    ADD CONSTRAINT "companies_kpp_format_check"
        CHECK ("kpp" IS NULL OR "kpp" ~ '^[0-9]{9}$'),
    ADD CONSTRAINT "companies_ogrn_format_check"
        CHECK ("ogrn" IS NULL OR "ogrn" ~ '^([0-9]{13}|[0-9]{15})$'),
    ADD CONSTRAINT "companies_entity_type_check"
        CHECK ("entity_type" IS NULL OR "entity_type" IN ('LEGAL', 'INDIVIDUAL'));

COMMIT;
