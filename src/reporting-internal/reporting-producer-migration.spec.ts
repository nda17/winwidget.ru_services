import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
	resolve(
		process.cwd(),
		'prisma/migrations/20260731010000_add_reporting_projection_producers/migration.sql'
	),
	'utf8'
);

const snapshotService = readFileSync(
	resolve(
		process.cwd(),
		'src/reporting-internal/reporting-projection-snapshot.service.ts'
	),
	'utf8'
);

const getFunctionCallArgumentCounts = (
	source: string,
	functionName: string
): number[] => {
	const marker = `PERFORM "${functionName}"(`;
	const counts: number[] = [];
	let searchFrom = 0;

	while (true) {
		const callStart = source.indexOf(marker, searchFrom);
		if (callStart < 0) break;

		let depth = 1;
		let commas = 0;
		let inString = false;
		let index = callStart + marker.length;
		for (; index < source.length && depth > 0; index += 1) {
			const character = source[index];
			if (character === "'") {
				if (inString && source[index + 1] === "'") {
					index += 1;
					continue;
				}
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (character === '(') depth += 1;
			if (character === ')') depth -= 1;
			if (character === ',' && depth === 1) commas += 1;
		}

		if (depth !== 0) {
			throw new Error(`Unterminated ${functionName} call in migration`);
		}
		counts.push(commas + 1);
		searchFrom = index;
	}

	return counts;
};

describe('Reporting projection producer migration', () => {
	it('installs all source triggers with producers disabled', () => {
		expect(migration).toContain(
			"VALUES ('singleton', false, NULL, 'CORE', 0, NULL, CURRENT_TIMESTAMP)"
		);
		for (const table of [
			'User',
			'auth_identities',
			'payments',
			'subscriptions',
			'widgets',
			'quizzes',
			'callbacks',
			'countdown_timers',
			'stop_offers',
			'online_consultants',
			'calculators',
			'leads',
			'quiz_leads',
			'callback_leads',
			'countdown_timer_leads',
			'stop_offer_leads',
			'online_consultant_leads',
			'calculator_leads',
			'telegram_bot_settings'
		]) {
			expect(migration).toContain(
				`AFTER INSERT OR UPDATE OR DELETE ON "${table}"`
			);
		}
		expect(migration.match(/FOR EACH ROW EXECUTE FUNCTION/g)).toHaveLength(
			19
		);
		expect(migration).toContain(
			'"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP'
		);
	});

	it('versions in the source transaction and writes the exact Outbox envelope', () => {
		expect(migration).toContain('LANGUAGE plpgsql\nVOLATILE');
		expect(migration).toContain(
			'FROM "reporting_producer_state"\n    WHERE "id" = \'singleton\'\n    FOR SHARE'
		);
		expect(migration).toContain(
			'"version" = "reporting_projection_versions"."version" + 1'
		);
		expect(migration).toContain(
			'source_sequence_value := nextval(\'"reporting_source_sequence"\')'
		);
		for (const key of [
			'schemaVersion',
			'eventType',
			'eventId',
			'aggregateId',
			'aggregateVersion',
			'sourceSequence',
			'occurredAt',
			'tombstone',
			'state'
		]) {
			expect(migration).toContain(`'${key}'`);
		}
		expect(migration).toContain('widget_type_value || \':\' || NEW."id"');
		expect(migration).toContain(
			"lead_type_value || ':' || (row_value->>'id')"
		);
		const argumentCounts = getFunctionCallArgumentCounts(
			migration,
			'reporting_record_projection_event'
		);
		expect(argumentCounts.length).toBeGreaterThan(0);
		expect(argumentCounts.every(count => count === 6)).toBe(true);
	});

	it('preserves the legacy exact empty-string install-domain metric', () => {
		const exactExpression = `'hasInstallDomain', NEW."install_domain" <> ''`;
		expect(migration).toContain(exactExpression);
		expect(migration).not.toContain(
			`BTRIM(COALESCE(NEW."install_domain", '')) <> ''`
		);
		expect(snapshotService).toContain(
			`'hasInstallDomain', "source"."install_domain" <> ''`
		);
		expect(snapshotService).not.toContain(
			`BTRIM(COALESCE("source"."install_domain", '')) <> ''`
		);
	});

	it('keeps source tables additive and excludes raw PII from state builders', () => {
		for (const sourceTable of [
			'User',
			'payments',
			'subscriptions',
			'widgets',
			'leads'
		]) {
			expect(migration).not.toMatch(
				new RegExp(`ALTER TABLE "${sourceTable}"`)
			);
		}
		for (const forbiddenStateKey of [
			"'email',",
			"'phone',",
			"'contact',",
			"'ip',",
			"'value',",
			"'installDomain',",
			"'answers',"
		]) {
			expect(migration).not.toContain(forbiddenStateKey);
		}
	});

	it('grants explicit least-privilege access for runtime, maintenance and backup', () => {
		expect(migration).toContain("rolname = 'winwidget_api_runtime'");
		expect(migration).toContain(
			'GRANT SELECT ON TABLE "reporting_producer_state"\n            TO "winwidget_maintenance"'
		);
		expect(migration).toContain(
			'GRANT SELECT ON SEQUENCE "reporting_source_sequence"\n            TO "winwidget_backup"'
		);
		expect(migration).toContain(
			'REVOKE EXECUTE ON FUNCTION\n    "reporting_producers_enabled"()'
		);
	});
});
