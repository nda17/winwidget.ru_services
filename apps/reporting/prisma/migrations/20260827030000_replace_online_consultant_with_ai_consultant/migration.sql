BEGIN;

-- The production migration role intentionally has no database TEMP privilege.
-- Use transaction-scoped staging tables in the service-owned schema instead.
CREATE TABLE "reporting"."retired_online_consultant_reporting_aggregates" (
    "aggregate_id" TEXT PRIMARY KEY
);

INSERT INTO "reporting"."retired_online_consultant_reporting_aggregates" ("aggregate_id")
SELECT candidate."aggregate_id"
FROM (
    SELECT receipt."aggregate_id"
    FROM "reporting"."projection_receipts" AS receipt
    WHERE receipt."aggregate_id" LIKE 'onlineConsultant:%'

    UNION

    SELECT projection."source_aggregate_id"
    FROM "reporting"."widget_projections" AS projection
    WHERE projection."widget_type" = 'onlineConsultant'

    UNION

    SELECT fact."source_aggregate_id"
    FROM "reporting"."lead_facts" AS fact
    WHERE fact."widget_type" = 'onlineConsultant'

    UNION

    SELECT failure."payload" ->> 'aggregateId'
    FROM "reporting"."consumer_failures" AS failure
    WHERE pg_catalog.jsonb_typeof(failure."payload") = 'object'
        AND failure."payload" ->> 'aggregateId' LIKE 'onlineConsultant:%'

    UNION

    SELECT event."payload" ->> 'aggregateId'
    FROM "reporting"."outbox_events" AS event
    WHERE pg_catalog.jsonb_typeof(event."payload") = 'object'
        AND event."payload" ->> 'aggregateId' LIKE 'onlineConsultant:%'
) AS candidate
WHERE candidate."aggregate_id" LIKE 'onlineConsultant:%'
ON CONFLICT ("aggregate_id") DO NOTHING;

CREATE TABLE "reporting"."retired_online_consultant_reporting_events" (
    "event_id" UUID PRIMARY KEY
);

INSERT INTO "reporting"."retired_online_consultant_reporting_events" ("event_id")
SELECT candidate."event_id"
FROM (
    SELECT receipt."event_id"
    FROM "reporting"."projection_receipts" AS receipt
    WHERE receipt."aggregate_id" IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    )

    UNION

    SELECT failure."event_id"
    FROM "reporting"."consumer_failures" AS failure
    WHERE failure."payload" ->> 'aggregateId' IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    )

    UNION

    SELECT event."message_id"
    FROM "reporting"."outbox_events" AS event
    WHERE event."payload" ->> 'aggregateId' IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    )
) AS candidate
ON CONFLICT ("event_id") DO NOTHING;

DELETE FROM "reporting"."outbox_events" AS event
WHERE (
        event."exchange" IN (
            'RETRY'::"reporting"."ReportingOutboxExchange",
            'MANUAL_RETRY'::"reporting"."ReportingOutboxExchange",
            'DEAD_LETTER'::"reporting"."ReportingOutboxExchange"
        )
        AND event."message_id" IN (
            SELECT retired."event_id"
            FROM "reporting"."retired_online_consultant_reporting_events" AS retired
        )
    )
    OR (
        event."event_type" = 'admin.audit.event.v1'
        AND event."payload" #>> '{target,eventId}' IN (
            SELECT retired."event_id"::TEXT
            FROM "reporting"."retired_online_consultant_reporting_events" AS retired
        )
    );

DELETE FROM "reporting"."consumer_failures" AS failure
WHERE failure."event_id" IN (
    SELECT retired."event_id"
    FROM "reporting"."retired_online_consultant_reporting_events" AS retired
);

DELETE FROM "reporting"."consumer_receipts" AS receipt
WHERE receipt."event_id" IN (
    SELECT retired."event_id"
    FROM "reporting"."retired_online_consultant_reporting_events" AS retired
);

DELETE FROM "reporting"."projection_receipts"
WHERE "aggregate_id" IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    )
    OR "event_id" IN (
        SELECT retired."event_id"
        FROM "reporting"."retired_online_consultant_reporting_events" AS retired
    );

DELETE FROM "reporting"."lead_facts"
WHERE "widget_type" = 'onlineConsultant'
    OR "source_aggregate_id" IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    );

DELETE FROM "reporting"."widget_projections"
WHERE "widget_type" = 'onlineConsultant'
    OR "source_aggregate_id" IN (
        SELECT retired."aggregate_id"
        FROM "reporting"."retired_online_consultant_reporting_aggregates" AS retired
    );

DROP TABLE "reporting"."retired_online_consultant_reporting_events";
DROP TABLE "reporting"."retired_online_consultant_reporting_aggregates";

ALTER TABLE "reporting"."widget_projections"
    DROP CONSTRAINT "widgets_state_check",
    ADD CONSTRAINT "widgets_state_check" CHECK (
        (
            "tombstoned"
            AND "widget_type" IN (
                'wheel', 'quiz', 'callback', 'countdownTimer',
                'stopOffer', 'aiConsultant', 'calculator'
            )
        )
        OR (
            NOT "tombstoned"
            AND "widget_type" IN (
                'wheel', 'quiz', 'callback', 'countdownTimer',
                'stopOffer', 'aiConsultant', 'calculator'
            )
            AND char_length(btrim("user_id")) BETWEEN 1 AND 255
            AND "is_active" IS NOT NULL
            AND "has_install_domain" IS NOT NULL
            AND "source_created_at" IS NOT NULL
        )
    );

ALTER TABLE "reporting"."lead_facts"
    DROP CONSTRAINT "lead_facts_state_check",
    ADD CONSTRAINT "lead_facts_state_check" CHECK (
        (
            "tombstoned"
            AND "widget_type" IN (
                'wheel', 'quiz', 'callback', 'countdownTimer',
                'stopOffer', 'calculator'
            )
        )
        OR (
            NOT "tombstoned"
            AND "widget_type" IN (
                'wheel', 'quiz', 'callback', 'countdownTimer',
                'stopOffer', 'calculator'
            )
            AND char_length(btrim("widget_id")) BETWEEN 1 AND 255
            AND "source_created_at" IS NOT NULL
        )
    );

COMMIT;
