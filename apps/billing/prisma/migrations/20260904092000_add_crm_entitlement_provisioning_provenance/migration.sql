BEGIN;

ALTER TABLE "billing"."crm_entitlements"
  ADD COLUMN "provisioning_command_id" UUID,
  ADD COLUMN "provisioning_command_type" VARCHAR(64);

LOCK TABLE "billing"."command_receipts" IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "billing"."command_receipts" AS receipt
    WHERE receipt."command_type" = 'ACTIVATE_WINCRM_TRIAL'
      AND receipt."result"->'activated' = 'true'::jsonb
      AND (
        receipt."request_hash_version" = 1
        AND receipt."command_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND receipt."command_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'
        AND jsonb_typeof(receipt."result") = 'object'
        AND receipt."result"->'schemaVersion' = '1'::jsonb
        AND receipt."result"->>'productCode' = 'WINCRM'
        AND receipt."result"->>'status' = 'ACTIVE'
        AND jsonb_typeof(receipt."result"->'entitlement') = 'object'
        AND receipt."result"->'entitlement'->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND receipt."result"->'entitlement'->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND receipt."result"->'entitlement'->>'planCode' = 'TRIAL'
        AND EXISTS (
          SELECT 1
          FROM "billing"."crm_entitlements" AS entitlement
          WHERE lower(entitlement."id"::text) = lower(receipt."result"->'entitlement'->>'id')
            AND lower(entitlement."workspace_id"::text) = lower(receipt."result"->'entitlement'->>'workspaceId')
        )
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION
      'Cannot backfill WinCRM provisioning provenance from an invalid accepted command receipt';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    WITH "accepted_provisioning_receipts" AS (
      SELECT
        (receipt."result"->'entitlement'->>'id')::uuid AS "entitlement_id",
        (receipt."result"->'entitlement'->>'workspaceId')::uuid AS "workspace_id",
        receipt."command_id"::uuid AS "provisioning_command_id"
      FROM "billing"."command_receipts" AS receipt
      WHERE receipt."command_type" = 'ACTIVATE_WINCRM_TRIAL'
        AND receipt."result"->'activated' = 'true'::jsonb
    )
    SELECT 1
    FROM (
      SELECT "entitlement_id"
      FROM "accepted_provisioning_receipts"
      GROUP BY "entitlement_id"
      HAVING count(*) > 1

      UNION ALL

      SELECT "workspace_id"
      FROM "accepted_provisioning_receipts"
      GROUP BY "workspace_id"
      HAVING count(*) > 1

      UNION ALL

      SELECT "provisioning_command_id"
      FROM "accepted_provisioning_receipts"
      GROUP BY "provisioning_command_id"
      HAVING count(*) > 1
    ) AS duplicates
  ) THEN
    RAISE EXCEPTION
      'Every WinCRM entitlement must have exactly one accepted provisioning command receipt';
  END IF;

  IF EXISTS (
    WITH "accepted_provisioning_receipts" AS (
      SELECT
        (receipt."result"->'entitlement'->>'id')::uuid AS "entitlement_id",
        (receipt."result"->'entitlement'->>'workspaceId')::uuid AS "workspace_id"
      FROM "billing"."command_receipts" AS receipt
      WHERE receipt."command_type" = 'ACTIVATE_WINCRM_TRIAL'
        AND receipt."result"->'activated' = 'true'::jsonb
    )
    SELECT 1
    FROM "billing"."crm_entitlements" AS entitlement
    FULL JOIN "accepted_provisioning_receipts" AS receipt
      ON receipt."entitlement_id" = entitlement."id"
      AND receipt."workspace_id" = entitlement."workspace_id"
    WHERE entitlement."id" IS NULL
      OR receipt."entitlement_id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Every WinCRM entitlement must have exactly one accepted provisioning command receipt';
  END IF;
END
$$;

UPDATE "billing"."crm_entitlements" AS entitlement
SET
  "provisioning_command_id" = receipt."provisioning_command_id",
  "provisioning_command_type" = receipt."provisioning_command_type"
FROM (
  SELECT
    (source."result"->'entitlement'->>'id')::uuid AS "entitlement_id",
    (source."result"->'entitlement'->>'workspaceId')::uuid AS "workspace_id",
    source."command_id"::uuid AS "provisioning_command_id",
    source."command_type" AS "provisioning_command_type"
  FROM "billing"."command_receipts" AS source
  WHERE source."command_type" = 'ACTIVATE_WINCRM_TRIAL'
    AND source."result"->'activated' = 'true'::jsonb
) AS receipt
WHERE entitlement."id" = receipt."entitlement_id"
  AND entitlement."workspace_id" = receipt."workspace_id";

ALTER TABLE "billing"."crm_entitlements"
  ALTER COLUMN "provisioning_command_id" SET NOT NULL,
  ALTER COLUMN "provisioning_command_type" SET NOT NULL,
  ADD CONSTRAINT "crm_entitlements_provisioning_command_type_check"
    CHECK (
      "provisioning_command_type" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    );

CREATE UNIQUE INDEX "crm_entitlements_provisioning_command_id_key"
  ON "billing"."crm_entitlements"("provisioning_command_id");

COMMIT;
