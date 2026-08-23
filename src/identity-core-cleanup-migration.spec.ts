import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve(
	__dirname,
	'../prisma/migrations/20260815000000_remove_legacy_identity_core_source/migration.sql'
);
const migration = readFileSync(migrationPath, 'utf8');

describe('Identity Core source cleanup migration', () => {
	it('requires the exact production evidence contract before destructive SQL', () => {
		const expectedSettings = [
			'winwidget.identity_backup_sha256',
			'winwidget.identity_cleanup_migration_sha256',
			'winwidget.identity_cleanup_revision',
			'winwidget.identity_core_backup_sha256',
			'winwidget.identity_core_source_cleanup',
			'winwidget.identity_ownership_phase',
			'winwidget.identity_ownership_revision',
			'winwidget.identity_queue_drain_evidence_sha256',
			'winwidget.identity_restore_evidence_sha256',
			'winwidget.identity_soak_evidence_sha256',
			'winwidget.identity_stopped_writers_evidence_sha256'
		];
		const actualSettings = Array.from(
			new Set(migration.match(/winwidget\.identity_[a-z0-9_]+/g) ?? [])
		).sort();
		const firstDestructiveStatement = migration.indexOf('DROP TRIGGER');

		expect(actualSettings).toEqual(expectedSettings);
		expect(firstDestructiveStatement).toBeGreaterThan(0);
		for (const setting of expectedSettings) {
			expect(migration.indexOf(setting)).toBeLessThan(
				firstDestructiveStatement
			);
		}
		expect(migration).toContain(
			"'winwidget.identity_core_source_cleanup',\n            true\n        ) = 'production-destructive-approved'"
		);
		expect(migration).toContain(
			'expected_cleanup_revision <> expected_ownership_revision'
		);
		expect(migration).toContain(
			'fenced_revision = expected_ownership_revision'
		);
		expect(migration).toContain(
			'checksum = expected_cleanup_migration_sha256'
		);
		expect(migration).toContain(
			"migration_name =\n                '20260815000000_remove_legacy_identity_core_source'"
		);
		expect(migration).toContain(
			'IF NOT (pristine_bootstrap OR production_approved) THEN'
		);
		expect(migration).toContain(
			'Identity Core source function set is not exact'
		);
		expect(migration).toContain('relation.relname = ANY(target_tables)');
	});

	it('limits the irreversible schema deletion to the reviewed Identity objects', () => {
		const dropTables = migration.match(
			/DROP TABLE\s+([\s\S]*?)\s+RESTRICT;/
		);
		const droppedTableNames = dropTables?.[1]
			.split(',')
			.map(value =>
				value
					.trim()
					.replace(/^public\./, '')
					.replaceAll('"', '')
			)
			.sort();
		const droppedTypes = Array.from(
			migration.matchAll(/DROP TYPE public\."([^"]+)" RESTRICT;/g),
			match => match[1]
		).sort();
		const droppedColumns = Array.from(
			migration.matchAll(/DROP COLUMN ([a-z_]+)/g),
			match => match[1]
		).sort();
		const droppedFunctions = Array.from(
			migration.matchAll(/DROP FUNCTION public\.([a-z_]+)\(([^)]*)\);/g),
			match =>
				`${match[1]}(${match[2].replaceAll(/\s+/g, '').toLowerCase()})`
		).sort();
		const droppedTriggers = Array.from(
			migration.matchAll(
				/DROP TRIGGER "([^"]+)"\s+ON public\.(?:"([^"]+)"|([a-z_]+));/g
			),
			match => `${match[2] ?? match[3]}:${match[1]}`
		).sort();

		expect(droppedTableNames).toEqual(
			[
				'User',
				'auth_identities',
				'identity_core_source_state',
				'telegram_notification_channels',
				'user_sessions',
				'verification_challenges'
			].sort()
		);
		expect(droppedTypes).toEqual(
			[
				'AuthIdentityType',
				'Role',
				'UserStatus',
				'VerificationChallengePurpose',
				'VerificationChallengeType'
			].sort()
		);
		expect(droppedColumns).toEqual(
			[
				'github_auth_enabled',
				'google_auth_enabled',
				'recaptcha_enabled',
				'telegram_auth_enabled',
				'vk_auth_enabled',
				'yandex_auth_enabled'
			].sort()
		);
		expect(droppedFunctions).toEqual(
			[
				'billing_emit_identity_projection(text,boolean)',
				'billing_identity_auth_projection_trigger()',
				'billing_identity_telegram_projection_trigger()',
				'billing_identity_user_projection_trigger()',
				'fence_identity_core_source(text)',
				'identity_core_source_is_open()',
				'lock_identity_core_source_open()',
				'reject_fenced_identity_auth_settings_write()',
				'reject_fenced_identity_core_source_write()',
				'reporting_auth_identity_projection_trigger()',
				'reporting_emit_user_projection(text,boolean)',
				'reporting_user_projection_trigger()',
				'unfence_identity_core_source(text)'
			].sort()
		);
		expect(droppedTriggers).toEqual(
			[
				'User:billing_identity_user_projection',
				'User:identity_core_source_write_fence',
				'User:reporting_user_projection',
				'auth_identities:billing_identity_auth_projection',
				'auth_identities:identity_core_source_write_fence',
				'auth_identities:reporting_auth_identity_projection',
				'site_settings:identity_core_auth_settings_write_fence',
				'telegram_notification_channels:billing_identity_telegram_projection',
				'telegram_notification_channels:identity_core_source_write_fence',
				'user_sessions:identity_core_source_write_fence',
				'verification_challenges:identity_core_source_write_fence'
			].sort()
		);
		expect(migration).not.toMatch(/\bCASCADE\b/);
	});
});
