-- Forward-only Campaigns extraction contract migration.
--
-- This migration must remain blocked during routine `prisma migrate deploy`.
-- The production-destructive Campaigns finalize job is the only supported
-- caller and must provide every custom PostgreSQL setting validated below.

BEGIN;

DO $campaigns_contract_guard$
DECLARE
	cutover_approval TEXT :=
		current_setting('winwidget.campaigns_contract_cutover', true);
	forward_boundary TEXT :=
		current_setting('winwidget.campaigns_forward_boundary', true);
	source_manifest TEXT :=
		current_setting('winwidget.campaigns_source_manifest_sha256', true);
	telegram_audit_decision TEXT :=
		current_setting('winwidget.campaigns_telegram_audit_decision', true);
	telegram_audit_reference TEXT :=
		current_setting('winwidget.campaigns_telegram_audit_reference', true);
BEGIN
	IF cutover_approval IS DISTINCT FROM 'production-destructive-approved' THEN
		RAISE EXCEPTION
			'Campaigns contract migration is blocked outside production-destructive finalize'
			USING ERRCODE = '55000';
	END IF;
	IF forward_boundary IS DISTINCT FROM 'forward-only' THEN
		RAISE EXCEPTION
			'Campaigns contract migration requires the forward-only boundary'
			USING ERRCODE = '55000';
	END IF;
	IF source_manifest IS NULL OR source_manifest !~ '^[0-9a-f]{64}$' THEN
		RAISE EXCEPTION
			'Campaigns contract migration requires the verified source manifest'
			USING ERRCODE = '55000';
	END IF;
	IF telegram_audit_decision IS DISTINCT FROM 'completed' OR
		telegram_audit_reference IS NULL OR
		char_length(btrim(telegram_audit_reference)) < 3 THEN
		RAISE EXCEPTION
			'Campaigns contract migration requires a documented Telegram-channel audit decision'
			USING ERRCODE = '55000';
	END IF;
	IF to_regclass('public.mailing_campaigns') IS NULL OR
		to_regclass('public.mailing_deliveries') IS NULL OR
		to_regclass('public.messaging_rate_limits') IS NULL THEN
		RAISE EXCEPTION
			'Campaigns legacy source tables are missing or partially removed'
			USING ERRCODE = '55000';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "mailing_campaigns"
		WHERE "status" IN (
			'QUEUED'::"MailingCampaignStatus",
			'RUNNING'::"MailingCampaignStatus"
		)
	) OR EXISTS (
		SELECT 1
		FROM "mailing_deliveries"
		WHERE "status" IN (
			'PENDING'::"MailingDeliveryStatus",
			'PROCESSING'::"MailingDeliveryStatus"
		)
	) THEN
		RAISE EXCEPTION
			'Campaigns legacy source still contains active work'
			USING ERRCODE = '55000';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "integration_delivery_receipts"
		WHERE "integration" IN ('mailing-email', 'mailing-telegram')
			AND "status" IN (
				'PROCESSING'::"IntegrationDeliveryReceiptStatus",
				'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus"
			)
	) OR EXISTS (
		SELECT 1
		FROM "outbox_events"
		WHERE "event_type" IN (
				'mailing.delivery.requested.v1',
				'mailing.delivery.email.v1',
				'mailing.delivery.telegram.v1'
			)
			AND "status" IN (
				'PENDING'::"OutboxEventStatus",
				'PUBLISHING'::"OutboxEventStatus",
				'FAILED'::"OutboxEventStatus"
			)
	) THEN
		RAISE EXCEPTION
			'Campaigns legacy messaging state is not quiescent'
			USING ERRCODE = '55000';
	END IF;
END
$campaigns_contract_guard$;

DELETE FROM "integration_delivery_failures"
WHERE "integration" IN ('mailing-email', 'mailing-telegram');
DELETE FROM "integration_delivery_receipts"
WHERE "integration" IN ('mailing-email', 'mailing-telegram');
DELETE FROM "integration_credential_snapshots"
WHERE "integration" IN ('mailing-email', 'mailing-telegram');
DELETE FROM "outbox_events"
WHERE "event_type" IN (
		'mailing.delivery.requested.v1',
		'mailing.delivery.email.v1',
		'mailing.delivery.telegram.v1'
	)
	OR "routing_key" IN (
		'mailing.delivery.requested.v1',
		'mailing.delivery.email.v1',
		'mailing.delivery.telegram.v1'
	);

DROP TABLE "mailing_deliveries";
DROP TABLE "mailing_campaigns";
DROP TABLE "messaging_rate_limits";
DROP TYPE "MailingDeliveryStatus";
DROP TYPE "MailingDeliveryChannel";
DROP TYPE "MailingCampaignStatus";

COMMIT;
