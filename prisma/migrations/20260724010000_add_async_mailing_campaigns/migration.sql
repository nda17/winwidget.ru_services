CREATE TYPE "MailingCampaignStatus" AS ENUM (
	'QUEUED',
	'RUNNING',
	'COMPLETED',
	'PARTIAL_FAILED',
	'CANCELLED'
);

CREATE TYPE "MailingDeliveryChannel" AS ENUM ('EMAIL', 'TELEGRAM');

CREATE TYPE "MailingDeliveryStatus" AS ENUM (
	'PENDING',
	'PROCESSING',
	'SENT',
	'FAILED',
	'CANCELLED'
);

CREATE TABLE "mailing_campaigns" (
	"id" UUID NOT NULL,
	"admin_id" TEXT NOT NULL,
	"subject" TEXT NOT NULL,
	"message" TEXT NOT NULL,
	"audience" TEXT NOT NULL,
	"requested_channel" TEXT NOT NULL,
	"status" "MailingCampaignStatus" NOT NULL DEFAULT 'QUEUED',
	"recipient_count" INTEGER NOT NULL DEFAULT 0,
	"sent_count" INTEGER NOT NULL DEFAULT 0,
	"failed_count" INTEGER NOT NULL DEFAULT 0,
	"cancelled_count" INTEGER NOT NULL DEFAULT 0,
	"email_recipient_count" INTEGER NOT NULL DEFAULT 0,
	"telegram_recipient_count" INTEGER NOT NULL DEFAULT 0,
	"started_at" TIMESTAMP(3),
	"completed_at" TIMESTAMP(3),
	"cancel_requested_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "mailing_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mailing_deliveries" (
	"id" UUID NOT NULL,
	"campaign_id" UUID NOT NULL,
	"channel" "MailingDeliveryChannel" NOT NULL,
	"recipient" TEXT NOT NULL,
	"status" "MailingDeliveryStatus" NOT NULL DEFAULT 'PENDING',
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"last_error" TEXT,
	"sent_at" TIMESTAMP(3),
	"cancelled_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "mailing_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailing_deliveries_campaign_channel_recipient_unique"
	ON "mailing_deliveries"("campaign_id", "channel", "recipient");
CREATE INDEX "mailing_campaigns_status_created_idx"
	ON "mailing_campaigns"("status", "created_at");
CREATE INDEX "mailing_campaigns_admin_created_idx"
	ON "mailing_campaigns"("admin_id", "created_at");
CREATE INDEX "mailing_deliveries_campaign_status_idx"
	ON "mailing_deliveries"("campaign_id", "status");
CREATE INDEX "mailing_deliveries_status_updated_idx"
	ON "mailing_deliveries"("status", "updated_at");

ALTER TABLE "mailing_campaigns"
	ADD CONSTRAINT "mailing_campaigns_admin_id_fkey"
	FOREIGN KEY ("admin_id") REFERENCES "User"("id")
	ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "mailing_deliveries"
	ADD CONSTRAINT "mailing_deliveries_campaign_id_fkey"
	FOREIGN KEY ("campaign_id") REFERENCES "mailing_campaigns"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;
