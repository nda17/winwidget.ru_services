-- These detail projections belonged to the retired Core integration. No current
-- service binds either routing key, so non-terminal rows can never be delivered.
DELETE FROM "billing"."outbox_events"
WHERE "exchange" = 'winwidget.events'
  AND "status" IN (
    'PENDING'::"billing"."OutboxStatus",
    'PROCESSING'::"billing"."OutboxStatus"
  )
  AND (
    (
      "event_type" = 'billing.payment.details.changed.v1'
      AND "routing_key" = 'billing.payment.details.changed.v1'
    )
    OR (
      "event_type" = 'billing.subscription.details.changed.v1'
      AND "routing_key" = 'billing.subscription.details.changed.v1'
    )
  );
