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
			'limit-telegram',
			'campaign-email',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram',
			'wincrm-invitation-email',
			'wincrm-task-reminder-email',
			'wincrm-task-reminder-telegram',
			'support-team-email',
			'support-team-telegram',
			'support-client-email',
			'wincrm-intake-sla-email',
			'wincrm-intake-sla-telegram'
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
			'limit-telegram',
			'campaign-email',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram',
			'wincrm-invitation-email',
			'wincrm-task-reminder-email',
			'wincrm-task-reminder-telegram',
			'support-team-email',
			'support-team-telegram',
			'support-client-email',
			'wincrm-intake-sla-email',
			'wincrm-intake-sla-telegram'
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
			'limit-telegram',
			'campaign-email',
			'campaign-telegram',
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram',
			'wincrm-invitation-email',
			'wincrm-task-reminder-email',
			'wincrm-task-reminder-telegram',
			'support-team-email',
			'support-team-telegram',
			'support-client-email',
			'wincrm-intake-sla-email',
			'wincrm-intake-sla-telegram'
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
			"routing_key" NOT IN ('manual.wincrm-invitation-email', 'wincrm-invitation-email.dead-letter')
			OR "event_type" = 'notification.wincrm.invitation.email.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.wincrm-task-reminder-email', 'wincrm-task-reminder-email.dead-letter')
			OR "event_type" = 'notification.wincrm.task-reminder.email.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.wincrm-task-reminder-telegram', 'wincrm-task-reminder-telegram.dead-letter')
			OR "event_type" = 'notification.wincrm.task-reminder.telegram.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.support-team-email', 'support-team-email.dead-letter')
			OR "event_type" = 'notification.support.team.email.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.support-team-telegram', 'support-team-telegram.dead-letter')
			OR "event_type" = 'notification.support.team.telegram.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.support-client-email', 'support-client-email.dead-letter')
			OR "event_type" = 'notification.support.client.email.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.wincrm-intake-sla-email', 'wincrm-intake-sla-email.dead-letter')
			OR "event_type" = 'notification.wincrm.intake-sla.email.requested.v1'
		)
		AND (
			"routing_key" NOT IN ('manual.wincrm-intake-sla-telegram', 'wincrm-intake-sla-telegram.dead-letter')
			OR "event_type" = 'notification.wincrm.intake-sla.telegram.requested.v1'
		)
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
						'manual.subscription-expiry-telegram',
						'manual.wincrm-invitation-email',
						'manual.wincrm-task-reminder-email',
						'manual.wincrm-task-reminder-telegram',
						'manual.support-team-email',
						'manual.support-team-telegram',
						'manual.support-client-email',
						'manual.wincrm-intake-sla-email',
						'manual.wincrm-intake-sla-telegram'
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
						"routing_key" = 'support.notification.delivery.outcome.v1'
						AND "event_type" = "routing_key"
						AND "payload"->>'sourceKind' IN ('support-team-email', 'support-team-telegram', 'support-client-email')
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
					'subscription-expiry-telegram.dead-letter',
					'wincrm-invitation-email.dead-letter',
					'wincrm-task-reminder-email.dead-letter',
					'wincrm-task-reminder-telegram.dead-letter',
					'support-team-email.dead-letter',
					'support-team-telegram.dead-letter',
					'support-client-email.dead-letter',
					'wincrm-intake-sla-email.dead-letter',
					'wincrm-intake-sla-telegram.dead-letter'
				)
			)
		)
	);

COMMIT;
