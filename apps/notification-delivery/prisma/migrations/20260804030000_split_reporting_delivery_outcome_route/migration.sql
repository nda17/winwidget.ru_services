BEGIN;

ALTER TABLE "notification_delivery"."outbox_events"
	DROP CONSTRAINT "notification_outbox_events_identity_check",
	ADD CONSTRAINT "notification_outbox_events_identity_check" CHECK (
		char_length(btrim("event_type")) BETWEEN 1 AND 255
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND (
			"deduplication_key" IS NULL
			OR char_length(btrim("deduplication_key")) BETWEEN 1 AND 500
		)
		AND jsonb_typeof("headers") = 'object'
		AND (
			(
				"exchange" = 'EVENTS'::"notification_delivery"."NotificationDeliveryExchange"
				AND (
					"routing_key" IN (
						'manual.email',
						'manual.telegram',
						'manual.payment-email',
						'manual.payment-telegram',
						'manual.limit-email',
						'manual.limit-telegram',
						'manual.campaign-email',
						'manual.campaign-telegram',
						'manual.daily-summary-delivery-telegram',
						'manual.subscription-expiry-email',
						'manual.subscription-expiry-telegram'
					)
					OR (
						"routing_key" = 'notification.telegram.destination-unavailable.v1'
						AND "event_type" = 'notification.telegram.destination-unavailable.v1'
					)
					OR (
						"routing_key" = 'notification.delivery.outcome.v1'
						AND "event_type" = "routing_key"
						AND (
							"payload"->>'sourceKind' IN (
								'subscription-expiry-email',
								'subscription-expiry-telegram'
							)
							OR "status"::TEXT = 'PUBLISHED'
						)
					)
					OR (
						"routing_key" = 'reporting.notification.delivery.outcome.v1'
						AND "event_type" = "routing_key"
						AND "payload"->>'sourceKind' =
							'daily-summary-delivery-telegram'
					)
					OR (
						"routing_key" = 'notification.delivery.outcome.v2'
						AND "event_type" = "routing_key"
					)
				)
			)
			OR (
				"exchange" = 'DEAD_LETTER'::"notification_delivery"."NotificationDeliveryExchange"
				AND "routing_key" IN (
					'email.dead-letter',
					'telegram.dead-letter',
					'payment-email.dead-letter',
					'payment-telegram.dead-letter',
					'limit-email.dead-letter',
					'limit-telegram.dead-letter',
					'campaign-email.dead-letter',
					'campaign-telegram.dead-letter',
					'daily-summary-delivery-telegram.dead-letter',
					'subscription-expiry-email.dead-letter',
					'subscription-expiry-telegram.dead-letter'
				)
			)
		)
	);

COMMIT;
