ALTER TABLE "crm_customers"."contacts"
  ADD COLUMN "time_zone" VARCHAR(100),
  ADD COLUMN "preferred_call_start" VARCHAR(5),
  ADD COLUMN "preferred_call_end" VARCHAR(5),
  ADD CONSTRAINT "contacts_preferred_call_window_check" CHECK (
    ("preferred_call_start" IS NULL AND "preferred_call_end" IS NULL)
    OR (
      "time_zone" IS NOT NULL
      AND "preferred_call_start" IS NOT NULL
      AND "preferred_call_end" IS NOT NULL
      AND "preferred_call_start" ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
      AND "preferred_call_end" ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
      AND "preferred_call_start" <> "preferred_call_end"
    )
  );
