BEGIN;

CREATE TABLE "billing"."crm_commercial_policies" (
  "version" INTEGER NOT NULL,
  "monthly_price_minor" INTEGER NOT NULL,
  "yearly_price_minor" INTEGER NOT NULL,
  "additional_seat_monthly_price_minor" INTEGER NOT NULL,
  "additional_seat_yearly_price_minor" INTEGER NOT NULL,
  "included_seats" INTEGER NOT NULL,
  "trial_seat_limit" INTEGER NOT NULL,
  "trial_days" INTEGER NOT NULL,
  "grace_days" INTEGER NOT NULL,
  "created_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crm_commercial_policies_pkey" PRIMARY KEY ("version"),
  CONSTRAINT "crm_commercial_policies_version_check" CHECK ("version" > 0),
  CONSTRAINT "crm_commercial_policies_prices_check" CHECK (
    "monthly_price_minor" BETWEEN 1 AND 100000000
    AND "yearly_price_minor" BETWEEN 1 AND 100000000
    AND "additional_seat_monthly_price_minor" BETWEEN 1 AND 100000000
    AND "additional_seat_yearly_price_minor" BETWEEN 1 AND 100000000
  ),
  CONSTRAINT "crm_commercial_policies_seats_check" CHECK (
    "included_seats" BETWEEN 2 AND 10000 AND "trial_seat_limit" BETWEEN 2 AND 10000
  ),
  CONSTRAINT "crm_commercial_policies_lifecycle_check" CHECK ("trial_days" = 5 AND "grace_days" = 3),
  CONSTRAINT "crm_commercial_policies_actor_check" CHECK (
    "created_by_user_id" IS NULL OR
    (length("created_by_user_id") BETWEEN 1 AND 256 AND "created_by_user_id" = btrim("created_by_user_id"))
  )
);

INSERT INTO "billing"."crm_commercial_policies" (
  "version", "monthly_price_minor", "yearly_price_minor",
  "additional_seat_monthly_price_minor", "additional_seat_yearly_price_minor",
  "included_seats", "trial_seat_limit", "trial_days", "grace_days"
) VALUES (1, 99000, 990000, 29000, 290000, 2, 5, 5, 3);

CREATE FUNCTION "billing"."reject_crm_commercial_policy_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'WinCRM commercial policy versions are immutable';
END;
$function$;

REVOKE ALL ON FUNCTION "billing"."reject_crm_commercial_policy_mutation"() FROM PUBLIC;

CREATE TRIGGER "crm_commercial_policies_append_only"
BEFORE UPDATE OR DELETE ON "billing"."crm_commercial_policies"
FOR EACH ROW EXECUTE FUNCTION "billing"."reject_crm_commercial_policy_mutation"();

CREATE TRIGGER "crm_commercial_policies_no_truncate"
BEFORE TRUNCATE ON "billing"."crm_commercial_policies"
FOR EACH STATEMENT EXECUTE FUNCTION "billing"."reject_crm_commercial_policy_mutation"();

ALTER TABLE "billing"."crm_entitlements"
  ADD COLUMN "policy_version" INTEGER,
  ADD COLUMN "grace_until" TIMESTAMP(3),
  ADD CONSTRAINT "crm_entitlements_policy_version_fkey"
    FOREIGN KEY ("policy_version") REFERENCES "billing"."crm_commercial_policies"("version")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "crm_entitlements_policy_snapshot_check" CHECK (
    ("policy_version" IS NULL AND "grace_until" IS NULL)
    OR ("policy_version" IS NOT NULL AND "seat_limit" BETWEEN 2 AND 10000
      AND "seat_limit" IS NOT NULL AND "grace_until" IS NOT NULL
      AND "grace_until" = "effective_until" + INTERVAL '3 days')
  );

COMMIT;
