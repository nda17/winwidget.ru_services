-- Remove only notification-delivery state that can be linked through retained
-- payloads to the retired online-consultant lead source.

BEGIN;

CREATE TEMPORARY TABLE "retired_online_consultant_delivery_events" (
    "event_id" UUID PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO "retired_online_consultant_delivery_events" ("event_id")
SELECT candidate."event_id"
FROM (
    SELECT failure."event_id"
    FROM "notification_delivery"."delivery_failures" AS failure
    WHERE pg_catalog.jsonb_typeof(failure."payload") = 'object'
        AND failure."payload" ->> 'source' = 'online-consultant'

    UNION

    SELECT event."message_id"
    FROM "notification_delivery"."outbox_events" AS event
    WHERE pg_catalog.jsonb_typeof(event."payload") = 'object'
        AND event."payload" ->> 'source' = 'online-consultant'

    UNION

    SELECT action."event_id"
    FROM "notification_delivery"."control_actions" AS action
    JOIN "notification_delivery"."delivery_failures" AS failure
        ON failure."id" = action."failure_id"
    WHERE pg_catalog.jsonb_typeof(failure."payload") = 'object'
        AND failure."payload" ->> 'source' = 'online-consultant'
) AS candidate
ON CONFLICT ("event_id") DO NOTHING;

-- Capture service-owned outcome events while their source references remain.
INSERT INTO "retired_online_consultant_delivery_events" ("event_id")
SELECT event."message_id"
FROM "notification_delivery"."outbox_events" AS event
WHERE event."payload" ->> 'sourceEventId' IN (
        SELECT retired."event_id"::TEXT
        FROM "retired_online_consultant_delivery_events" AS retired
    )
    OR event."headers" ->> 'x-causation-id' IN (
        SELECT retired."event_id"::TEXT
        FROM "retired_online_consultant_delivery_events" AS retired
    )
ON CONFLICT ("event_id") DO NOTHING;

DELETE FROM "notification_delivery"."outbox_events" AS event
WHERE event."message_id" IN (
        SELECT retired."event_id"
        FROM "retired_online_consultant_delivery_events" AS retired
    )
    OR event."payload" ->> 'source' = 'online-consultant'
    OR event."payload" ->> 'sourceEventId' IN (
        SELECT retired."event_id"::TEXT
        FROM "retired_online_consultant_delivery_events" AS retired
    )
    OR event."headers" ->> 'x-causation-id' IN (
        SELECT retired."event_id"::TEXT
        FROM "retired_online_consultant_delivery_events" AS retired
    );

-- control_actions has an ON DELETE RESTRICT relation to delivery_failures.
DELETE FROM "notification_delivery"."control_actions" AS action
WHERE action."event_id" IN (
        SELECT retired."event_id"
        FROM "retired_online_consultant_delivery_events" AS retired
    )
    OR action."failure_id" IN (
        SELECT failure."id"
        FROM "notification_delivery"."delivery_failures" AS failure
        WHERE failure."event_id" IN (
            SELECT retired."event_id"
            FROM "retired_online_consultant_delivery_events" AS retired
        )
    );

DELETE FROM "notification_delivery"."delivery_failures" AS failure
WHERE failure."event_id" IN (
    SELECT retired."event_id"
    FROM "retired_online_consultant_delivery_events" AS retired
);

DELETE FROM "notification_delivery"."delivery_receipts" AS receipt
WHERE receipt."event_id" IN (
    SELECT retired."event_id"
    FROM "retired_online_consultant_delivery_events" AS retired
);

-- A DELIVERED receipt has no source payload. If its event has no retained
-- failure, outbox or control-action reference, this database cannot prove that
-- it belonged to online-consultant. Such receipts intentionally remain instead
-- of using a broad consumer- or date-based delete.

COMMIT;
