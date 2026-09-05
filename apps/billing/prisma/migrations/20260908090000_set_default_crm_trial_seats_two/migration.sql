BEGIN;

-- Use the same fence as DEV policy publication. Never edit an immutable
-- revision or override a policy that an administrator has already published.
SELECT pg_advisory_xact_lock(
  hashtextextended('billing-wincrm-commercial-policy', 0)
);

INSERT INTO "billing"."crm_commercial_policies" (
  "version", "monthly_price_minor", "yearly_price_minor",
  "additional_seat_monthly_price_minor", "additional_seat_yearly_price_minor",
  "included_seats", "trial_seat_limit", "trial_days", "grace_days"
)
SELECT
  2, "seed"."monthly_price_minor", "seed"."yearly_price_minor",
  "seed"."additional_seat_monthly_price_minor", "seed"."additional_seat_yearly_price_minor",
  "seed"."included_seats", 2, "seed"."trial_days", "seed"."grace_days"
FROM "billing"."crm_commercial_policies" AS "seed"
WHERE "seed"."version" = 1
  AND "seed"."created_by_user_id" IS NULL
  AND "seed"."monthly_price_minor" = 99000
  AND "seed"."yearly_price_minor" = 990000
  AND "seed"."additional_seat_monthly_price_minor" = 29000
  AND "seed"."additional_seat_yearly_price_minor" = 290000
  AND "seed"."included_seats" = 2
  AND "seed"."trial_seat_limit" = 5
  AND "seed"."trial_days" = 5
  AND "seed"."grace_days" = 3
  AND NOT EXISTS (
    SELECT 1 FROM "billing"."crm_commercial_policies"
    WHERE "version" <> 1
  );

-- Existing entitlements keep their original policy version, seat limit and dates.
COMMIT;
