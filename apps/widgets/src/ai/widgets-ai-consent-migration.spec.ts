import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260830030000_add_ai_consent_receipts/migration.sql'
	),
	'utf8'
);

describe('AI consent receipt migration', () => {
	it('stores bounded non-PII evidence without a foreign key', () => {
		expect(migration.indexOf('BEGIN;')).toBe(0);
		expect(migration.trim().endsWith('COMMIT;')).toBe(true);
		for (const field of [
			'"acceptance_id" UUID',
			'"widget_public_key" CHAR(12)',
			'"owner_scope" CHAR(43)',
			'"session_scope" CHAR(43)',
			'"source_scope" CHAR(43)',
			'"document_hash" CHAR(64)',
			'"statement_text" TEXT',
			'"privacy_url" VARCHAR(500)'
		]) {
			expect(migration).toContain(field);
		}
		expect(migration).not.toMatch(
			/"(?:ip|session|transcript|user_agent|page_url)"\s/i
		);
		expect(migration).not.toContain('FOREIGN KEY');
		expect(migration).toContain(
			'"proof_expires_at" <= "accepted_at" + INTERVAL \'15 minutes\''
		);
	});

	it('enforces one immutable PENDING to VERIFIED transition in the database', () => {
		expect(migration).toContain(
			'CREATE FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()'
		);
		expect(migration).toContain('SECURITY INVOKER');
		expect(migration).not.toContain('SECURITY DEFINER');
		expect(migration).toContain(
			"to_jsonb(NEW) - ARRAY['status', 'verified_at', 'updated_at']"
		);
		expect(migration).toContain(
			'OLD."status" <> \'PENDING\'::"widgets"."AiConsentReceiptStatus"'
		);
		expect(migration).toContain(
			'NEW."status" <> \'VERIFIED\'::"widgets"."AiConsentReceiptStatus"'
		);
		expect(migration).toContain(
			'BEFORE UPDATE ON "widgets"."ai_consent_receipts"'
		);
	});

	it('keeps the trigger routine owner-only while standard table CRUD supports retention', () => {
		expect(migration).toContain(
			'GRANT SELECT, INSERT, UPDATE, DELETE\n\t\t\tON TABLE "widgets"."ai_consent_receipts"'
		);
		expect(migration).toContain(
			'REVOKE ALL ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()\n\t\t\tFROM "winwidget_widgets_runtime"'
		);
		expect(migration).not.toContain(
			'GRANT EXECUTE ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"()'
		);
	});
});
