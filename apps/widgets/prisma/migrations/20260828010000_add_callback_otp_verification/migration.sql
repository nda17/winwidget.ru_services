BEGIN;

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "widgets"."callbacks"
		WHERE "config" IS NULL
			OR jsonb_typeof("config") <> 'object'
			OR ("draft_config" IS NOT NULL AND jsonb_typeof("draft_config") <> 'object')
	) THEN
		RAISE EXCEPTION 'Callback config must be a JSON object before OTP migration';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM "widgets"."widget_config_revisions"
		WHERE "widget_type" = 'CALLBACK'
			AND (
				"config" IS NULL
				OR jsonb_typeof("config") <> 'object'
			)
	) THEN
		RAISE EXCEPTION 'Callback config revision must be a JSON object before OTP migration';
	END IF;
END
$$;

UPDATE "widgets"."callbacks"
SET
	"config" = jsonb_set(
		jsonb_set("config", '{verificationMode}', '"OFF"'::jsonb, true),
		'{launcherEnabled}',
		'true'::jsonb,
		true
	),
	"draft_config" = CASE
		WHEN "draft_config" IS NULL THEN NULL
		ELSE jsonb_set(
			jsonb_set("draft_config", '{verificationMode}', '"OFF"'::jsonb, true),
			'{launcherEnabled}',
			'true'::jsonb,
			true
		)
	END,
	"updated_at" = NOW();

UPDATE "widgets"."widget_config_revisions"
SET "config" = jsonb_set(
	jsonb_set("config", '{verificationMode}', '"OFF"'::jsonb, true),
	'{launcherEnabled}',
	'true'::jsonb,
	true
)
WHERE "widget_type" = 'CALLBACK';

ALTER TABLE "widgets"."callbacks"
	ADD CONSTRAINT "callbacks_config_verification_contract_check" CHECK (
		COALESCE(
			jsonb_typeof("config") = 'object'
			AND jsonb_typeof("config" -> 'verificationMode') = 'string'
			AND "config" ->> 'verificationMode' IN ('OFF', 'SMS', 'EMAIL')
			AND jsonb_typeof("config" -> 'launcherEnabled') = 'boolean'
			AND (
				"draft_config" IS NULL
				OR COALESCE(
					jsonb_typeof("draft_config") = 'object'
					AND jsonb_typeof("draft_config" -> 'verificationMode') = 'string'
					AND "draft_config" ->> 'verificationMode' IN ('OFF', 'SMS', 'EMAIL')
					AND jsonb_typeof("draft_config" -> 'launcherEnabled') = 'boolean',
					false
				)
			),
			false
		)
	);

ALTER TABLE "widgets"."widget_config_revisions"
	ADD CONSTRAINT "widget_config_revisions_callback_verification_check" CHECK (
		"widget_type" <> 'CALLBACK'
		OR COALESCE(
			jsonb_typeof("config") = 'object'
			AND jsonb_typeof("config" -> 'verificationMode') = 'string'
			AND "config" ->> 'verificationMode' IN ('OFF', 'SMS', 'EMAIL')
			AND jsonb_typeof("config" -> 'launcherEnabled') = 'boolean',
			false
		)
	);

CREATE TYPE "widgets"."CallbackVerificationMode" AS ENUM ('OFF', 'SMS', 'EMAIL');
CREATE TYPE "widgets"."CallbackOtpChannel" AS ENUM ('SMS', 'EMAIL');

CREATE TABLE "widgets"."callback_otp_challenges" (
	"id" UUID NOT NULL,
	"callback_id" TEXT NOT NULL,
	"owner_id" TEXT NOT NULL,
	"published_version" INTEGER NOT NULL,
	"channel" "widgets"."CallbackOtpChannel" NOT NULL,
	"destination_hash" CHAR(64) NOT NULL,
	"ip_hash" CHAR(64) NOT NULL,
	"code_hash" CHAR(64) NOT NULL,
	"attempts" INTEGER NOT NULL DEFAULT 0,
	"expires_at" TIMESTAMP(3) NOT NULL,
	"resend_available_at" TIMESTAMP(3) NOT NULL,
	"sent_at" TIMESTAMP(3),
	"failed_at" TIMESTAMP(3),
	"revoked_at" TIMESTAMP(3),
	"consumed_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "callback_otp_challenges_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "callback_otp_challenges_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5),
	CONSTRAINT "callback_otp_challenges_version_check" CHECK ("published_version" >= 1),
	CONSTRAINT "callback_otp_challenges_hashes_check" CHECK (
		"destination_hash" ~ '^[0-9a-f]{64}$'
		AND "ip_hash" ~ '^[0-9a-f]{64}$'
		AND "code_hash" ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT "callback_otp_challenges_window_check" CHECK (
		"expires_at" > "created_at"
		AND "resend_available_at" > "created_at"
	),
	CONSTRAINT "callback_otp_challenges_delivery_check" CHECK (
		NOT ("sent_at" IS NOT NULL AND "failed_at" IS NOT NULL)
	),
	CONSTRAINT "callback_otp_challenges_consumed_check" CHECK (
		"consumed_at" IS NULL
		OR (
			"sent_at" IS NOT NULL
			AND "failed_at" IS NULL
			AND "revoked_at" IS NULL
			AND "attempts" < 5
		)
	)
);

CREATE TABLE "widgets"."callback_otp_rate_buckets" (
	"id" UUID NOT NULL,
	"scope" VARCHAR(40) NOT NULL,
	"subject_hash" CHAR(64) NOT NULL,
	"count" INTEGER NOT NULL,
	"window_started_at" TIMESTAMP(3) NOT NULL,
	"window_ends_at" TIMESTAMP(3) NOT NULL,
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "callback_otp_rate_buckets_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "callback_otp_rate_buckets_scope_check" CHECK (
		"scope" IN (
			'DESTINATION_RESEND',
			'DESTINATION_HOUR',
			'DESTINATION_DAY',
			'IP_TEN_MINUTES',
			'IP_DAY',
			'WIDGET_DAY',
			'OWNER_DAY',
			'GLOBAL_SMS_DAY',
			'GLOBAL_EMAIL_DAY'
		)
	),
	CONSTRAINT "callback_otp_rate_buckets_count_check" CHECK ("count" > 0),
	CONSTRAINT "callback_otp_rate_buckets_window_check" CHECK ("window_ends_at" > "window_started_at"),
	CONSTRAINT "callback_otp_rate_buckets_subject_check" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "widgets"."callback_leads"
	ADD COLUMN "verification_mode" "widgets"."CallbackVerificationMode" NOT NULL DEFAULT 'OFF',
	ADD COLUMN "verification_challenge_id" UUID;

ALTER TABLE "widgets"."callback_leads"
	ADD CONSTRAINT "callback_leads_verification_contract_check" CHECK (
		(
			"verification_mode" = 'OFF'
			AND "verification_challenge_id" IS NULL
		)
		OR (
			"verification_mode" IN ('SMS', 'EMAIL')
			AND "verification_challenge_id" IS NOT NULL
		)
	);

CREATE UNIQUE INDEX "callback_leads_verification_challenge_unique"
	ON "widgets"."callback_leads"("verification_challenge_id");
CREATE UNIQUE INDEX "callback_otp_rate_buckets_scope_subject_unique"
	ON "widgets"."callback_otp_rate_buckets"("scope", "subject_hash");
CREATE INDEX "callback_otp_challenges_destination_idx"
	ON "widgets"."callback_otp_challenges"("callback_id", "channel", "destination_hash", "created_at");
CREATE INDEX "callback_otp_challenges_expiry_idx"
	ON "widgets"."callback_otp_challenges"("expires_at", "id");
CREATE INDEX "callback_otp_challenges_owner_idx"
	ON "widgets"."callback_otp_challenges"("owner_id", "created_at");
CREATE INDEX "callback_otp_rate_buckets_expiry_idx"
	ON "widgets"."callback_otp_rate_buckets"("window_ends_at", "id");

ALTER TABLE "widgets"."callback_otp_challenges"
	ADD CONSTRAINT "callback_otp_challenges_callback_id_fkey"
	FOREIGN KEY ("callback_id") REFERENCES "widgets"."callbacks"("id")
	ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "widgets"."callback_leads"
	ADD CONSTRAINT "callback_leads_verification_challenge_id_fkey"
	FOREIGN KEY ("verification_challenge_id") REFERENCES "widgets"."callback_otp_challenges"("id")
	ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT;
