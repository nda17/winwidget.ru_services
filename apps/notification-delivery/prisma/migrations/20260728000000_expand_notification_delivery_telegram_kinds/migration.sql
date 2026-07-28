BEGIN;

ALTER TABLE "notification_delivery"."delivery_receipts"
	DROP CONSTRAINT "delivery_receipts_identity_check",
	ADD CONSTRAINT "delivery_receipts_identity_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "consumer" IN (
			'email',
			'telegram',
			'payment-email',
			'payment-telegram',
			'limit-email',
			'limit-telegram'
		)
	);
ALTER TABLE "notification_delivery"."delivery_failures"
	DROP CONSTRAINT "delivery_failures_classification_check",
	ADD CONSTRAINT "delivery_failures_classification_check" CHECK (
		char_length(btrim("consumer")) BETWEEN 1 AND 100
		AND "consumer" IN (
			'email',
			'telegram',
			'payment-email',
			'payment-telegram',
			'limit-email',
			'limit-telegram'
		)
		AND char_length(btrim("routing_key")) BETWEEN 1 AND 255
		AND char_length(btrim("normalized_code")) BETWEEN 1 AND 255
		AND char_length(btrim("safe_reason")) BETWEEN 1 AND 2000
		AND "classification_version" > 0
		AND ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
		AND jsonb_typeof("headers") = 'object'
	);

ALTER TABLE "notification_delivery"."control_actions"
	DROP CONSTRAINT "control_actions_identity_check",
	ADD CONSTRAINT "control_actions_identity_check" CHECK (
		char_length(btrim("kind")) BETWEEN 1 AND 100
		AND "kind" IN (
			'email',
			'telegram',
			'payment-email',
			'payment-telegram',
			'limit-email',
			'limit-telegram'
		)
		AND char_length(btrim("actor_id")) BETWEEN 1 AND 255
	);

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
						'manual.limit-telegram'
					)
					OR (
						"routing_key" = 'notification.telegram.destination-unavailable.v1'
						AND "event_type" = 'notification.telegram.destination-unavailable.v1'
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
					'limit-telegram.dead-letter'
				)
			)
		)
	);

COMMIT;
