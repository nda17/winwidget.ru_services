import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appRoot = resolve(__dirname, '../..');
const migration = readFileSync(
	resolve(
		appRoot,
		'prisma/migrations/20260827210000_replace_online_consultant_with_ai_consultant/migration.sql'
	),
	'utf8'
);
const schema = readFileSync(
	resolve(appRoot, 'prisma/schema.prisma'),
	'utf8'
);

describe('AI consultant forward-only migration', () => {
	it('wraps counter adjustment, cleanup, drop, and create in one transaction', () => {
		expect(migration.indexOf('BEGIN;')).toBeGreaterThan(-1);
		expect(migration.trim().endsWith('COMMIT;')).toBe(true);
		expect(migration.indexOf('BEGIN;')).toBeLessThan(
			migration.indexOf('UPDATE "widgets"."usage_counters"')
		);
		expect(
			migration.indexOf('DROP TABLE "widgets"."online_consultants"')
		).toBeLessThan(
			migration.indexOf('CREATE TABLE "widgets"."ai_consultants"')
		);
	});

	it('removes every Widgets-owned artifact of the retired aggregate before dropping it', () => {
		for (const artifact of [
			'widget_config_revisions',
			'widget_runtime_daily_step_metrics',
			'widget_runtime_daily_metrics',
			'widget_runtime_presence',
			'aggregate_versions',
			'usage_ledger',
			'consumer_failures',
			'consumer_receipts',
			'outbox_events',
			'integration_delivery_failures',
			'integration_delivery_receipts',
			'integration_credential_snapshots',
			'online_consultant_leads',
			'online_consultants'
		]) {
			expect(migration).toContain(`"widgets"."${artifact}"`);
		}
		expect(
			migration.indexOf('DELETE FROM "widgets"."consumer_failures"')
		).toBeLessThan(
			migration.indexOf('DELETE FROM "widgets"."outbox_events"')
		);
		expect(
			migration.indexOf(
				'DELETE FROM "widgets"."integration_delivery_failures"'
			)
		).toBeLessThan(
			migration.indexOf(
				'DELETE FROM "widgets"."integration_credential_snapshots"'
			)
		);
		expect(
			migration.indexOf('DROP TABLE "widgets"."online_consultant_leads"')
		).toBeLessThan(
			migration.indexOf('DROP TABLE "widgets"."online_consultants"')
		);
		expect(migration).not.toMatch(
			/\bCREATE\s+(?:LOCAL\s+|GLOBAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i
		);
		expect(migration).toContain(
			'CREATE TABLE "widgets"."retired_online_consultant_event_ids"'
		);
		expect(
			migration.indexOf(
				'DROP TABLE "widgets"."retired_online_consultant_event_ids"'
			)
		).toBeGreaterThan(
			migration.indexOf('DELETE FROM "widgets"."outbox_events"')
		);
		expect(migration).toContain(
			"\"payload\" ->> 'source' = 'online-consultant'"
		);
		expect(migration).toContain(
			"\"payload\" #>> '{target,widgetType}' = 'ONLINE_CONSULTANT'"
		);
		expect(migration).toContain('ON CONFLICT ("event_id") DO NOTHING');
	});

	it('leaves only the lead-free AiConsultant model in the current schema', () => {
		expect(schema).toContain('model AiConsultant');
		expect(schema).toContain('@@map("ai_consultants")');
		expect(schema).not.toContain('model OnlineConsultant');
		expect(schema).not.toContain('AiConsultantLead');
		expect(schema).not.toContain('ai_consultant_leads');
	});
});
