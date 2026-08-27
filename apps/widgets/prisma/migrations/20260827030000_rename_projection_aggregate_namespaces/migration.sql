BEGIN;

LOCK TABLE "widgets"."aggregate_versions" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "widgets"."aggregate_versions" AS legacy
		JOIN "widgets"."aggregate_versions" AS current
			ON current."aggregate_id" = legacy."aggregate_id"
			AND current."aggregate_type" = CASE legacy."aggregate_type"
				WHEN 'core.identity.user' THEN 'identity.user'
				WHEN 'core.billing.subscription' THEN 'billing.subscription'
			END
		WHERE legacy."aggregate_type" IN (
			'core.identity.user',
			'core.billing.subscription'
		)
	) THEN
		RAISE EXCEPTION
			'Cannot rename Widgets projection aggregate namespaces because current and retired keys both exist';
	END IF;
END
$$;

UPDATE "widgets"."aggregate_versions"
SET "aggregate_type" = CASE "aggregate_type"
	WHEN 'core.identity.user' THEN 'identity.user'
	WHEN 'core.billing.subscription' THEN 'billing.subscription'
	ELSE "aggregate_type"
END
WHERE "aggregate_type" IN (
	'core.identity.user',
	'core.billing.subscription'
);

ALTER TABLE "widgets"."aggregate_versions"
ADD CONSTRAINT "aggregate_versions_no_core_namespace_check"
CHECK ("aggregate_type" NOT LIKE 'core.%');

COMMIT;
