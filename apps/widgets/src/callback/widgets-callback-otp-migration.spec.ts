import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260828010000_add_callback_otp_verification/migration.sql'
	),
	'utf8'
);

describe('Callback OTP forward-only migration', () => {
	it('backfills every persisted Callback config before enforcing required fields', () => {
		expect(migration.indexOf('BEGIN;')).toBe(0);
		expect(migration.trim().endsWith('COMMIT;')).toBe(true);
		expect(migration).toContain('UPDATE "widgets"."callbacks"');
		expect(migration).toContain(
			'UPDATE "widgets"."widget_config_revisions"'
		);
		for (const canonicalValue of [
			"'{verificationMode}'",
			'\'"OFF"\'::jsonb',
			"'{launcherEnabled}'",
			"'true'::jsonb"
		]) {
			expect(migration).toContain(canonicalValue);
		}
		expect(migration).toContain('"widget_type" = \'CALLBACK\'');
		expect(migration.indexOf('UPDATE "widgets"."callbacks"')).toBeLessThan(
			migration.indexOf(
				'ADD CONSTRAINT "callbacks_config_verification_contract_check"'
			)
		);
		expect(migration).toContain(
			"jsonb_typeof(\"config\" -> 'verificationMode') = 'string'"
		);
		expect(migration).toContain(
			"jsonb_typeof(\"config\" -> 'launcherEnabled') = 'boolean'"
		);
		expect(migration).toContain('false\n\t\t)');
	});

	it('stores only purpose-hashed OTP data and constrains rate scopes', () => {
		for (const hashColumn of [
			'"destination_hash" CHAR(64)',
			'"ip_hash" CHAR(64)',
			'"code_hash" CHAR(64)'
		]) {
			expect(migration).toContain(hashColumn);
		}
		expect(migration).not.toMatch(/\n\s*"(?:destination|ip|code)"\s/);
		for (const scope of [
			'DESTINATION_RESEND',
			'DESTINATION_HOUR',
			'DESTINATION_DAY',
			'IP_TEN_MINUTES',
			'IP_DAY',
			'WIDGET_DAY',
			'OWNER_DAY',
			'GLOBAL_SMS_DAY',
			'GLOBAL_EMAIL_DAY'
		]) {
			expect(migration).toContain(`'${scope}'`);
		}
	});

	it('requires a challenge if and only if a lead used verification', () => {
		expect(migration).toContain(
			'"verification_mode" = \'OFF\'\n\t\t\tAND "verification_challenge_id" IS NULL'
		);
		expect(migration).toContain(
			'"verification_mode" IN (\'SMS\', \'EMAIL\')\n\t\t\tAND "verification_challenge_id" IS NOT NULL'
		);
		expect(migration).toContain(
			'CREATE UNIQUE INDEX "callback_leads_verification_challenge_unique"'
		);
		expect(migration).toContain('ON DELETE NO ACTION ON UPDATE CASCADE');
	});
});
