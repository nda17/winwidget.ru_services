import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(
	join(
		__dirname,
		'../../prisma/migrations/20260823000000_init_platform/migration.sql'
	),
	'utf8'
);
const monotonicTimestampMigration = readFileSync(
	join(
		__dirname,
		'../../prisma/migrations/20260823010000_fix_service_identity_timestamp_monotonicity/migration.sql'
	),
	'utf8'
);
const sequenceSource = readFileSync(
	join(__dirname, 'platform-sequence.ts'),
	'utf8'
);
const cutoverSource = readFileSync(
	join(__dirname, '../cutover/main.ts'),
	'utf8'
);
const databaseLifecycleSource = readFileSync(
	join(__dirname, '../../../../scripts/platform-database-lifecycle.sh'),
	'utf8'
);
const restoreRehearsalSource = readFileSync(
	join(
		__dirname,
		'../../../../scripts/platform-backup-restore-rehearsal.sh'
	),
	'utf8'
);
const deployWorkflowSource = readFileSync(
	join(__dirname, '../../../../.github/workflows/deploy-production.yml'),
	'utf8'
);

const semanticGuardTables = [
	'service_identity',
	'source_sequences',
	'site_settings',
	'legal_pages',
	'home_page_content',
	'billing_offer_producer_state'
];

function section(start: string, end: string): string {
	const startIndex = cutoverSource.indexOf(start);
	const endIndex = cutoverSource.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Missing Platform cutover source section: ${start}`);
	}
	return cutoverSource.slice(startIndex, endIndex);
}

describe('Platform semantic fingerprint database guard', () => {
	it.each([
		['service_identity', 'service_identity_semantic_fingerprint_guard'],
		['source_sequences', 'source_sequences_semantic_fingerprint_guard'],
		['site_settings', 'site_settings_semantic_fingerprint_guard'],
		['legal_pages', 'legal_pages_semantic_fingerprint_guard'],
		['home_page_content', 'home_page_content_semantic_fingerprint_guard'],
		[
			'billing_offer_producer_state',
			'billing_offer_producer_semantic_fingerprint_guard'
		]
	])('defers the %s integrity check until commit', (table, trigger) => {
		const contract = [
			`CREATE CONSTRAINT TRIGGER "${trigger}"`,
			`AFTER INSERT OR UPDATE OR DELETE ON "platform"."${table}"`,
			'DEFERRABLE INITIALLY DEFERRED',
			'FOR EACH ROW',
			'EXECUTE FUNCTION "platform"."enforce_current_semantic_fingerprint"();'
		].join('\n');
		expect(migration).toContain(contract);
	});

	it('requires one transaction-local expected post-fingerprint', () => {
		expect(migration).toContain(
			'"platform"."refresh_current_semantic_fingerprint"(\n    expected_post_fingerprint TEXT\n)'
		);
		expect(migration).toContain(
			"'winwidget.platform_expected_semantic_fingerprint'"
		);
		expect(migration).toContain('pg_catalog.set_config(');
		expect(migration).toContain('pg_catalog.current_setting(');
		expect(migration).toContain(
			'stored_fingerprint IS DISTINCT FROM expected_fingerprint'
		);
		expect(migration).toContain(
			'actual_fingerprint IS DISTINCT FROM expected_fingerprint'
		);
		expect(sequenceSource).toContain(
			'platform.refresh_current_semantic_fingerprint('
		);
		expect(sequenceSource).toContain(
			'platform.current_semantic_fingerprint()'
		);
		expect(migration).not.toContain('SECURITY DEFINER');
	});

	it('keeps service identity updated_at monotonic when a transaction refreshes the fingerprint', () => {
		expect(monotonicTimestampMigration.trimStart()).toMatch(/^BEGIN;/);
		expect(monotonicTimestampMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(monotonicTimestampMigration).toContain(
			'CREATE OR REPLACE FUNCTION "platform"."refresh_current_semantic_fingerprint"('
		);
		expect(monotonicTimestampMigration).toContain('VOLATILE');
		expect(monotonicTimestampMigration).toContain('SECURITY INVOKER');
		expect(monotonicTimestampMigration).not.toContain('SECURITY DEFINER');
		expect(monotonicTimestampMigration).toContain(
			'SET search_path = pg_catalog, platform'
		);
		expect(monotonicTimestampMigration).toContain(
			'"updated_at" = GREATEST(\n            "updated_at",\n            pg_catalog.clock_timestamp()::timestamp\n        )'
		);
		expect(monotonicTimestampMigration).not.toContain(
			'"updated_at" = CURRENT_TIMESTAMP'
		);
		expect(monotonicTimestampMigration).toContain(
			"CONSTRAINT = 'platform_current_semantic_fingerprint_guard'"
		);
		expect(monotonicTimestampMigration).toContain(
			"'winwidget.platform_expected_semantic_fingerprint'"
		);
		expect(monotonicTimestampMigration).toContain(
			'REVOKE ALL ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT) FROM PUBLIC;'
		);
		expect(monotonicTimestampMigration).toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT)'
		);
		expect(monotonicTimestampMigration).toContain(
			'GRANT UPDATE (current_semantic_fingerprint, updated_at)'
		);
		expect(restoreRehearsalSource).toContain(
			"monotonic_transaction_start + interval '1 second'"
		);
		expect(restoreRehearsalSource).toContain(
			'Platform fingerprint refresh moved service identity timestamp backwards'
		);
		expect(restoreRehearsalSource).toContain(
			'rollback monotonic timestamp probe'
		);
		expect(deployWorkflowSource).toContain('DO $monotonic_timestamp$');
		expect(deployWorkflowSource).toContain(
			"transaction_started + interval '1 second'"
		);
		expect(deployWorkflowSource).toContain(
			'Platform CI fingerprint refresh moved service identity timestamp backwards'
		);
	});

	it('keeps runtime grants exact for the invoker protocol', () => {
		expect(migration).toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."current_semantic_fingerprint"()\n            TO winwidget_platform_runtime;'
		);
		expect(migration).toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT)\n            TO winwidget_platform_runtime;'
		);
		expect(migration).toContain(
			'GRANT UPDATE (current_semantic_fingerprint, updated_at)\n            ON TABLE "platform"."service_identity" TO winwidget_platform_runtime;'
		);
		expect(migration).not.toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."enforce_current_semantic_fingerprint"()'
		);
		expect(migration).not.toContain(
			'"platform"."refresh_current_semantic_fingerprint"()'
		);
	});

	it('reports one exact check violation contract', () => {
		const guardStart = migration.indexOf(
			'CREATE FUNCTION "platform"."enforce_current_semantic_fingerprint"()'
		);
		const guardEnd = migration.indexOf(
			'REVOKE ALL ON FUNCTION "platform"."enforce_current_semantic_fingerprint"()',
			guardStart
		);
		const guard = migration.slice(guardStart, guardEnd);
		expect(guardStart).toBeGreaterThan(-1);
		expect(guardEnd).toBeGreaterThan(guardStart);
		expect(guard).toContain("ERRCODE = '23514'");
		expect(guard).toContain(
			"CONSTRAINT = 'platform_current_semantic_fingerprint_guard'"
		);
	});

	it('catalog-verifies every semantic constraint trigger exactly', () => {
		for (const source of [
			databaseLifecycleSource,
			restoreRehearsalSource
		]) {
			for (const table of semanticGuardTables) {
				expect(source).toContain(`'${table}'`);
			}
			expect(source).toMatch(/tgenabled (?:=|<>) 'O'/);
			expect(source).toContain('tgisinternal');
			expect(source).toContain('tgconstraint');
			expect(source).toContain('constraint_entry.oid');
			expect(source).toContain('tgdeferrable');
			expect(source).toContain('tginitdeferred');
			expect(source).toMatch(/contype (?:=|<>) 't'/);
			expect(source).toContain(
				"platform.enforce_current_semantic_fingerprint()'::regprocedure"
			);
		}
	});

	it('forces and diagnoses all partial probes without drift', () => {
		for (const table of semanticGuardTables) {
			expect(restoreRehearsalSource).toContain(`'${table}'`);
		}
		expect(restoreRehearsalSource).toContain(
			'SET CONSTRAINTS ALL IMMEDIATE'
		);
		expect(restoreRehearsalSource).toContain('RETURNED_SQLSTATE');
		expect(restoreRehearsalSource).toContain('CONSTRAINT_NAME');
		expect(restoreRehearsalSource).toContain("actual_state <> '23514'");
		expect(restoreRehearsalSource).toContain(
			"actual_constraint <> 'platform_current_semantic_fingerprint_guard'"
		);
		expect(restoreRehearsalSource).toContain(
			'rejected % partial probe left database drift'
		);
		expect(restoreRehearsalSource).toContain(
			'coherent % probe rollback left database drift'
		);
	});

	it('keeps CI ACLs and the persistence sentinel compatible with the guard', () => {
		expect(deployWorkflowSource).toContain(
			'GRANT EXECUTE ON FUNCTION platform.current_semantic_fingerprint()'
		);
		expect(deployWorkflowSource).toContain(
			'GRANT UPDATE (current_semantic_fingerprint, updated_at)'
		);
		expect(deployWorkflowSource).not.toContain(
			'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO winwidget_platform_runtime'
		);
		expect(deployWorkflowSource).toContain('DO $guard_probe$');
		expect(deployWorkflowSource).toContain(
			'INSERT INTO platform.outbox_events'
		);
		expect(deployWorkflowSource).toContain(
			'DELETE FROM platform.outbox_events'
		);
		expect(deployWorkflowSource).not.toContain(
			"INSERT INTO platform.source_sequences (id, next_value, updated_at) VALUES ('$sentinel_id', 42"
		);
	});

	it('keeps the database URL out of Docker argv', () => {
		expect(databaseLifecycleSource).toContain('export PLATFORM_PARSE_URL');
		expect(databaseLifecycleSource).toContain('--env PLATFORM_PARSE_URL');
		expect(databaseLifecycleSource).not.toMatch(
			/^\s*--env "PLATFORM_PARSE_URL=\$value"/m
		);
	});
});

describe('Platform semantic fingerprint transaction coverage', () => {
	it.each([
		[
			'import',
			section(
				'async function importSnapshot(',
				'async function activate('
			),
			'await transaction.serviceIdentity.update({'
		],
		[
			'activate',
			section('async function activate(', 'async function abortImport('),
			'const identity = await transaction.serviceIdentity.updateMany({'
		],
		[
			'abort',
			section('async function abortImport(', 'async function verify('),
			'await transaction.serviceIdentity.update({'
		]
	])(
		'arms the expected post-fingerprint inside the normal %s transaction',
		(_action, source, finalOwnedWrite) => {
			expect(source).toContain('.$transaction(');
			const finalWriteIndex = source.indexOf(finalOwnedWrite);
			const refreshIndex = source.indexOf(
				'await refreshPlatformSemanticFingerprint(transaction);'
			);
			expect(finalWriteIndex).toBeGreaterThan(-1);
			expect(refreshIndex).toBeGreaterThan(finalWriteIndex);
		}
	);

	it.each([
		[
			'site settings',
			'../site-settings/site-settings.service.ts',
			'const updated = await transaction.siteSettings.update({'
		],
		[
			'legal page',
			'../legal-pages/legal-pages.service.ts',
			'const page = await transaction.legalPage.upsert({'
		],
		[
			'home page',
			'../home-page-content/home-page-content.service.ts',
			'const updated = await transaction.homePageContent.update({'
		]
	])(
		'arms the guard after the normal %s mutation and before commit',
		(_mutation, path, ownedWrite) => {
			const source = readFileSync(join(__dirname, path), 'utf8');
			expect(source).toContain('this.prisma.$transaction(');
			const writeIndex = source.indexOf(ownedWrite);
			const refreshIndex = source.indexOf(
				'await refreshPlatformSemanticFingerprint(transaction);'
			);
			expect(writeIndex).toBeGreaterThan(-1);
			expect(refreshIndex).toBeGreaterThan(writeIndex);
		}
	);
});
