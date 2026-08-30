BEGIN;

CREATE TYPE "widgets"."AiConsentReceiptStatus" AS ENUM ('PENDING', 'VERIFIED');

CREATE TABLE "widgets"."ai_consent_receipts" (
	"id" UUID NOT NULL,
	"acceptance_id" UUID NOT NULL,
	"widget_id" TEXT NOT NULL,
	"widget_public_key" CHAR(12) NOT NULL,
	"owner_scope" CHAR(43) NOT NULL,
	"configured_site_hostname" VARCHAR(253) NOT NULL,
	"request_hostname" VARCHAR(253) NOT NULL,
	"published_version" INTEGER NOT NULL,
	"session_scope" CHAR(43) NOT NULL,
	"source_scope" CHAR(43) NOT NULL,
	"document_version" VARCHAR(64) NOT NULL,
	"document_hash" CHAR(64) NOT NULL,
	"statement_text" TEXT NOT NULL,
	"privacy_url" VARCHAR(500) NOT NULL,
	"proof_expires_at" TIMESTAMP(3) NOT NULL,
	"accepted_at" TIMESTAMP(3) NOT NULL,
	"status" "widgets"."AiConsentReceiptStatus" NOT NULL DEFAULT 'PENDING',
	"verified_at" TIMESTAMP(3),
	"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updated_at" TIMESTAMP(3) NOT NULL,
	CONSTRAINT "ai_consent_receipts_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "ai_consent_receipts_widget_contract_check" CHECK (
		length(btrim("widget_id")) > 0
		AND "widget_public_key" ~ '^[A-Za-z0-9_-]{12}$'
		AND "published_version" >= 1
	),
	CONSTRAINT "ai_consent_receipts_scope_contract_check" CHECK (
		"owner_scope" ~ '^[A-Za-z0-9_-]{43}$'
		AND "session_scope" ~ '^[A-Za-z0-9_-]{43}$'
		AND "source_scope" ~ '^[A-Za-z0-9_-]{43}$'
	),
	CONSTRAINT "ai_consent_receipts_site_contract_check" CHECK (
		length(btrim("configured_site_hostname")) > 0
		AND length(btrim("request_hostname")) > 0
	),
	CONSTRAINT "ai_consent_receipts_document_contract_check" CHECK (
		length(btrim("document_version")) > 0
		AND "document_hash" ~ '^[0-9a-f]{64}$'
		AND length(btrim("statement_text")) > 0
		AND length(btrim("privacy_url")) > 0
	),
	CONSTRAINT "ai_consent_receipts_proof_window_check" CHECK (
		"proof_expires_at" > "accepted_at"
		AND "proof_expires_at" <= "accepted_at" + INTERVAL '15 minutes'
	),
	CONSTRAINT "ai_consent_receipts_status_contract_check" CHECK (
		(
			"status" = 'PENDING'
			AND "verified_at" IS NULL
		)
		OR (
			"status" = 'VERIFIED'
			AND "verified_at" IS NOT NULL
			AND "verified_at" >= "accepted_at"
			AND "verified_at" <= "proof_expires_at"
		)
	)
);

CREATE UNIQUE INDEX "ai_consent_receipts_acceptance_unique"
	ON "widgets"."ai_consent_receipts"("acceptance_id");
CREATE INDEX "ai_consent_receipts_pending_retention_idx"
	ON "widgets"."ai_consent_receipts"("status", "proof_expires_at", "id");
CREATE INDEX "ai_consent_receipts_verified_retention_idx"
	ON "widgets"."ai_consent_receipts"("status", "accepted_at", "id");

CREATE FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, widgets
AS $ai_consent_receipt_immutability$
BEGIN
	IF (
		to_jsonb(NEW) - ARRAY['status', 'verified_at', 'updated_at']
	) IS DISTINCT FROM (
		to_jsonb(OLD) - ARRAY['status', 'verified_at', 'updated_at']
	) THEN
		RAISE EXCEPTION 'AI consent receipt evidence is immutable'
			USING ERRCODE = '23514';
	END IF;

	IF OLD."status" <> 'PENDING'::"widgets"."AiConsentReceiptStatus"
		OR NEW."status" <> 'VERIFIED'::"widgets"."AiConsentReceiptStatus"
		OR OLD."verified_at" IS NOT NULL
		OR NEW."verified_at" IS NULL
		OR NEW."verified_at" < NEW."accepted_at"
		OR NEW."verified_at" > NEW."proof_expires_at"
		OR NEW."updated_at" < OLD."updated_at" THEN
		RAISE EXCEPTION 'AI consent receipt status transition is invalid'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END
$ai_consent_receipt_immutability$;

REVOKE ALL ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()
	FROM PUBLIC;

CREATE TRIGGER "ai_consent_receipts_immutable_update"
	BEFORE UPDATE ON "widgets"."ai_consent_receipts"
	FOR EACH ROW
	EXECUTE FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"();

REVOKE ALL ON TABLE "widgets"."ai_consent_receipts" FROM PUBLIC;

DO $widgets_ai_consent_known_roles$
BEGIN
	IF to_regrole('winwidget_widgets_runtime') IS NOT NULL THEN
		REVOKE ALL ON TABLE "widgets"."ai_consent_receipts"
			FROM "winwidget_widgets_runtime";
		GRANT SELECT, INSERT, UPDATE, DELETE
			ON TABLE "widgets"."ai_consent_receipts"
			TO "winwidget_widgets_runtime";
		REVOKE ALL ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()
			FROM "winwidget_widgets_runtime";
	END IF;
	IF to_regrole('winwidget_widgets_backup') IS NOT NULL THEN
		REVOKE ALL ON TABLE "widgets"."ai_consent_receipts"
			FROM "winwidget_widgets_backup";
		GRANT SELECT ON TABLE "widgets"."ai_consent_receipts"
			TO "winwidget_widgets_backup";
		REVOKE ALL ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()
			FROM "winwidget_widgets_backup";
	END IF;
END
$widgets_ai_consent_known_roles$;

COMMIT;
