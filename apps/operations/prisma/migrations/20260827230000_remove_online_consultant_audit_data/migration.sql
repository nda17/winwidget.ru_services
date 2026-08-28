BEGIN;

-- The production migration role intentionally has no database TEMP privilege.
-- Use a transaction-scoped staging table in the service-owned schema instead.
CREATE TABLE "operations"."retired_online_consultant_audit_events" (
    "event_id" UUID PRIMARY KEY
);

INSERT INTO "operations"."retired_online_consultant_audit_events" ("event_id")
SELECT log."id"::UUID
FROM "operations"."admin_event_logs" AS log
WHERE log."section" = 'WIDGETS'
    AND (
        log."entity_label" IN ('ONLINE_CONSULTANT', 'Онлайн-консультант')
        OR log."metadata" ->> 'widgetType' = 'ONLINE_CONSULTANT'
    )
    AND log."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT ("event_id") DO NOTHING;

INSERT INTO "operations"."retired_online_consultant_audit_events" ("event_id")
SELECT receipt."event_id"
FROM "operations"."audit_event_receipts" AS receipt
WHERE receipt."dead_letter_source" = 'widgets'
    AND receipt."dead_letter_payload" #>> '{payload,target,widgetType}' = 'ONLINE_CONSULTANT'
ON CONFLICT ("event_id") DO NOTHING;

INSERT INTO "operations"."retired_online_consultant_audit_events" ("event_id")
SELECT event."aggregate_id"::UUID
FROM "operations"."outbox_events" AS event
WHERE event."aggregate_type" = 'operations.admin-audit-retry'
    AND event."payload" #>> '{payload,target,widgetType}' = 'ONLINE_CONSULTANT'
    AND event."aggregate_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT ("event_id") DO NOTHING;

DELETE FROM "operations"."outbox_events" AS event
WHERE event."aggregate_type" = 'operations.admin-audit-retry'
    AND (
        event."payload" #>> '{payload,target,widgetType}' = 'ONLINE_CONSULTANT'
        OR event."aggregate_id" IN (
            SELECT retired."event_id"::TEXT
            FROM "operations"."retired_online_consultant_audit_events" AS retired
        )
    );

DELETE FROM "operations"."audit_event_receipts" AS receipt
WHERE receipt."event_id" IN (
    SELECT retired."event_id"
    FROM "operations"."retired_online_consultant_audit_events" AS retired
);

DELETE FROM "operations"."admin_event_logs" AS log
WHERE (
        log."section" = 'WIDGETS'
        AND (
            log."entity_label" IN ('ONLINE_CONSULTANT', 'Онлайн-консультант')
            OR log."metadata" ->> 'widgetType' = 'ONLINE_CONSULTANT'
        )
    )
    OR (
        log."section" = 'MESSAGING'
        AND log."entity_type" = 'operations_audit_failure'
        AND log."entity_id" IN (
            SELECT retired."event_id"::TEXT
            FROM "operations"."retired_online_consultant_audit_events" AS retired
        )
    );

DROP TABLE "operations"."retired_online_consultant_audit_events";

COMMIT;
