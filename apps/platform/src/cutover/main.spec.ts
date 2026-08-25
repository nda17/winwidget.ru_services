import * as continuity from '../domain/billing-offer-continuity';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlatformCoreArgs } from './core-main';
import {
	billingOfferFingerprint,
	canonicalJson,
	loadPlatformSnapshot,
	parsePlatformCutoverArgs,
	parseSnapshot,
	PlatformCutoverError,
	type PlatformCutoverSnapshot,
	snapshotSemanticHash
} from './main';

const coreCutoverSource = readFileSync(
	join(__dirname, 'core-main.ts'),
	'utf8'
);
const targetCutoverSource = readFileSync(
	join(__dirname, 'main.ts'),
	'utf8'
);
const productionCutoverSource = readFileSync(
	join(__dirname, '../../../../scripts/platform-cutover-production.sh'),
	'utf8'
);
const databaseLifecycleSource = readFileSync(
	join(__dirname, '../../../../scripts/platform-database-lifecycle.sh'),
	'utf8'
);
const coreAclRepairMigration = readFileSync(
	join(
		__dirname,
		'../../../../prisma/migrations/20260824010000_fix_platform_core_state_acl/migration.sql'
	),
	'utf8'
);

function sourceSection(
	source: string,
	start: string,
	end: string
): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Missing source section: ${start}`);
	}
	return source.slice(startIndex, endIndex);
}

const awaitedActionContracts: Array<
	[
		scope: string,
		source: string,
		start: string,
		end: string,
		actionPattern: RegExp
	]
> = [
	[
		'Core',
		coreCutoverSource,
		'export async function runPlatformCoreAction(args: Args)',
		'if (require.main === module)',
		/(?:status|preflight|prepare|fence|exportSnapshot|activate|abort)/
	],
	[
		'target',
		targetCutoverSource,
		'export async function runPlatformCutover(',
		'function record(',
		/(?:status|validateShadow|verify|activate|abortImport|preflight|importSnapshot)/
	]
];

function snapshot(): PlatformCutoverSnapshot {
	const timestamp = '2026-08-24T00:00:00.000Z';
	const content =
		'<section data-winwidget-section="auto-renewal-v1">offer</section>';
	const producer = {
		contractVersion: 2 as const,
		sequenceScope: 'billing.offer:offer' as const,
		aggregateVersion: '41',
		sourceSequence: '870'
	};
	const value: PlatformCutoverSnapshot = {
		schemaVersion: 1,
		snapshotId: '11111111-1111-4111-8111-111111111111',
		createdAt: timestamp,
		sourceRevision: 'a'.repeat(40),
		sourceFingerprint: '',
		platformHighWater: '6',
		counts: { siteSettings: 1, legalPages: 4, homePageContent: 1 },
		siteSettings: {
			id: 'singleton',
			bannerEnabled: true,
			bannerText: 'notice',
			snowflakeEnabled: false,
			updatedAt: timestamp,
			aggregateVersion: '1',
			sourceSequence: '1'
		},
		legalPages: [
			{
				slug: 'consent-processing',
				content: '<p>consent</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '2'
			},
			{
				slug: 'cookie-notice',
				content: '<p>cookies</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '3'
			},
			{
				slug: 'oferta',
				content,
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '4'
			},
			{
				slug: 'personal-policy',
				content: '<p>policy</p>',
				updatedAt: timestamp,
				aggregateVersion: '1',
				sourceSequence: '5'
			}
		],
		homePageContent: {
			id: 'singleton',
			content: { title: 'WinWidget' },
			updatedAt: timestamp,
			aggregateVersion: '1',
			sourceSequence: '6'
		},
		billingOfferProducer: {
			...producer,
			fingerprint: billingOfferFingerprint(content, producer)
		}
	};
	value.sourceFingerprint = snapshotSemanticHash(value);
	return value;
}

describe('Platform cutover snapshot contract', () => {
	beforeEach(() => {
		jest
			.spyOn(continuity, 'isAutoRenewalOfferCompatible')
			.mockReturnValue(true);
	});

	afterEach(() => jest.restoreAllMocks());

	it('accepts the exact frozen source and producer-scoped cursor', () => {
		expect(parseSnapshot(snapshot())).toEqual(snapshot());
	});

	it('rejects content tampering even when the embedded producer cursor remains valid', () => {
		const value = snapshot();
		value.siteSettings.bannerText = 'tampered';
		expect(() => parseSnapshot(value)).toThrow('sourceFingerprint');
	});

	it('rejects a retired Billing producer contract', () => {
		const value = snapshot();
		(
			value.billingOfferProducer as { contractVersion: number }
		).contractVersion = 1;
		expect(() => parseSnapshot(value)).toThrow(
			'snapshot.billingOfferProducer'
		);
	});

	it('rejects missing or duplicate Platform source continuity', () => {
		const value = snapshot();
		value.legalPages[0]!.sourceSequence = '1';
		expect(() => parseSnapshot(value)).toThrow('source continuity');
	});

	it('rejects a tampered resume file against its durable SHA anchor', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'platform-snapshot-test-')
		);
		const file = join(directory, 'snapshot.json');
		try {
			const value = snapshot();
			await writeFile(file, `${canonicalJson(value)}\n`, { mode: 0o600 });
			const anchored = await loadPlatformSnapshot(file);
			value.siteSettings.bannerText = 'tampered after durable anchor';
			value.sourceFingerprint = snapshotSemanticHash(value);
			await writeFile(file, `${canonicalJson(value)}\n`, { mode: 0o600 });

			await expect(
				loadPlatformSnapshot(file, anchored.sha256)
			).rejects.toThrow('SHA-256 differs from expected digest');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a partially written snapshot on resume', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'platform-snapshot-test-')
		);
		const file = join(directory, 'snapshot.json');
		try {
			await writeFile(file, '{', { mode: 0o600 });
			await expect(loadPlatformSnapshot(file)).rejects.toThrow(
				'bounded regular file'
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('Platform lifecycle argument contracts', () => {
	it('keeps both source and target preflight actions argument-exact', () => {
		const revision = 'a'.repeat(40);
		expect(
			parsePlatformCoreArgs(['preflight', '--revision', revision])
		).toEqual({
			action: 'preflight',
			revision
		});
		expect(parsePlatformCutoverArgs(['validate-shadow'])).toEqual({
			action: 'validate-shadow'
		});
		expect(() =>
			parsePlatformCutoverArgs([
				'validate-shadow',
				'--sha256',
				'b'.repeat(64)
			])
		).toThrow(PlatformCutoverError);
	});

	it('requires immutable snapshot identity for target activation', () => {
		expect(
			parsePlatformCutoverArgs(['activate', '--sha256', 'b'.repeat(64)])
		).toEqual({
			action: 'activate',
			sha256: 'b'.repeat(64)
		});
		expect(() => parsePlatformCutoverArgs(['activate'])).toThrow(
			PlatformCutoverError
		);
	});

	it('requires every frozen Core activation anchor', () => {
		const revision = 'a'.repeat(40);
		expect(
			parsePlatformCoreArgs([
				'activate',
				'--revision',
				revision,
				'--file',
				'/evidence/platform-snapshot.json',
				'--sha256',
				'b'.repeat(64),
				'--fingerprint',
				'c'.repeat(64),
				'--high-watermark',
				'6'
			])
		).toMatchObject({
			action: 'activate',
			revision,
			file: '/evidence/platform-snapshot.json',
			sha256: 'b'.repeat(64),
			fingerprint: 'c'.repeat(64),
			highWatermark: '6'
		});
		expect(() =>
			parsePlatformCoreArgs([
				'activate',
				'--revision',
				revision,
				'--sha256',
				'b'.repeat(64)
			])
		).toThrow(PlatformCutoverError);
	});
});

describe('Platform production recovery regressions', () => {
	it.each(awaitedActionContracts)(
		'awaits every %s action before disconnecting its Prisma client',
		(_scope, source, start, end, actionPattern) => {
			const runner = sourceSection(source, start, end);
			const awaitedActions =
				runner.match(
					new RegExp(`return await ${actionPattern.source}\\(`, 'g')
				) || [];

			expect(awaitedActions).toHaveLength(7);
			expect(runner).not.toMatch(
				new RegExp(`return (?!await\\b)${actionPattern.source}\\(`)
			);
			expect(runner).toMatch(
				/finally\s*{\s*await client\.\$disconnect\(\);/
			);
		}
	);

	it('repairs the Core Platform state ACL with one forward migration', () => {
		expect(productionCutoverSource).toContain(
			"readonly PLATFORM_CORE_PREPARE_MIGRATION='20260824010000_fix_platform_core_state_acl'"
		);
		expect(coreAclRepairMigration.trimStart()).toMatch(/^BEGIN;/);
		expect(coreAclRepairMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(coreAclRepairMigration).toContain(
			'REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state" FROM PUBLIC;'
		);
		for (const role of [
			'winwidget_api_runtime',
			'winwidget_maintenance',
			'winwidget_backup'
		]) {
			expect(coreAclRepairMigration).toContain(
				`IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN`
			);
			expect(coreAclRepairMigration).toContain(
				`REVOKE ALL PRIVILEGES ON TABLE public."platform_core_state"\n            FROM "${role}";`
			);
			expect(coreAclRepairMigration).toContain(
				`GRANT SELECT ON TABLE public."platform_core_state"\n            TO "${role}";`
			);
		}
		expect(
			coreAclRepairMigration.match(
				/REVOKE ALL PRIVILEGES ON TABLE public\."platform_core_state"/g
			)
		).toHaveLength(4);
		expect(
			coreAclRepairMigration.match(
				/GRANT SELECT ON TABLE public\."platform_core_state"/g
			)
		).toHaveLength(3);
		expect(coreAclRepairMigration).not.toMatch(
			/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)/
		);
	});

	it('keeps production cutover probes aligned with the live PostgreSQL and filesystem contracts', () => {
		expect(productionCutoverSource).toContain(
			"AND left(trigger_entry.tgname, 9) = 'platform_'"
		);
		expect(
			productionCutoverSource.match(/WHERE integration = 'offer'/g)
		).toHaveLength(2);
		expect(productionCutoverSource).not.toContain(
			"WHERE consumer = 'offer'"
		);
		expect(productionCutoverSource).toContain(
			'absent:absent | absent:preparing | absent:prepared) catalog_mode=initial ;;'
		);
		const snapshotValidator = sourceSection(
			productionCutoverSource,
			'platform_cutover_snapshot_field() {',
			'platform_cutover_dump() {'
		);
		expect(snapshotValidator).toContain(
			'--user 0:0 --mount "type=bind,source=$snapshot,target=/snapshot.json,readonly"'
		);
		const restoreEvidenceValidator = sourceSection(
			productionCutoverSource,
			'platform_cutover_validate_restore_evidence() {',
			'platform_cutover_run_restore() {'
		);
		expect(restoreEvidenceValidator).toMatch(
			/--user 0:0\s*\\\s+--mount "type=bind,source=\$evidence,target=\/evidence\.json,readonly"/
		);
		expect(databaseLifecycleSource).toContain(
			'if ((value["database_id"] == "pending") != (value["database_system_identifier"] == "pending")) exit 1'
		);
		expect(databaseLifecycleSource).not.toMatch(
			/!=\s*\n\s*\(value\["database_system_identifier"\]/
		);
	});

	it('keeps RabbitMQ retirement idempotent and independent of host Node', () => {
		const queueDeleteHelper = sourceSection(
			productionCutoverSource,
			'platform_cutover_queue_presence_is_exact() {',
			'platform_cutover_billing_offer_v2_listing_is_exact() {'
		);
		expect(queueDeleteHelper).toContain('list_queues -p "$vhost" name');
		expect(queueDeleteHelper).toContain('$0 == queue { found += 1 }');
		expect(queueDeleteHelper).toContain(
			'platform_cutover_delete_queue_if_present() {'
		);
		expect(
			queueDeleteHelper.match(
				/platform_cutover_queue_presence_is_exact "\$container" "\$vhost" "\$queue"/g
			)
		).toHaveLength(2);
		expect(queueDeleteHelper).toContain(
			'delete_queue \\\n\t\t-p "$vhost" "$queue" --if-empty --if-unused'
		);
		const billingRetirement = sourceSection(
			productionCutoverSource,
			'platform_cutover_retire_billing_offer_v1() {',
			'platform_cutover_verify_billing_offer_v2_boundary() {'
		);
		expect(billingRetirement).toContain(
			'platform_cutover_delete_queue_if_present "$container" "$vhost" "$queue"'
		);
		expect(billingRetirement).not.toContain(
			'rabbitmqctl --silent delete_queue'
		);
		const settingsRetirement = sourceSection(
			productionCutoverSource,
			'platform_cutover_retire_settings_projection() {',
			'platform_cutover_billing_offer_projection_matches() {'
		);
		expect(settingsRetirement).toContain(
			"while IFS=$' \\t' read -r queue _; do"
		);
		expect(settingsRetirement).toContain(
			'platform_cutover_delete_queue_if_present "$container" "$vhost" "$queue"'
		);

		for (const [start, end, imageKind, discriminator] of [
			[
				'platform_cutover_billing_offer_v2_queue_details_are_exact() {',
				'platform_cutover_platform_admin_audit_queue_listing_is_exact() {',
				'billing',
				'PLATFORM_QUEUE_EVENT'
			],
			[
				'platform_cutover_platform_admin_audit_queue_details_are_exact() {',
				'platform_cutover_assert_billing_worker_image() {',
				'core',
				'PLATFORM_QUEUE_KIND'
			]
		] as const) {
			const validator = sourceSection(productionCutoverSource, start, end);
			expect(validator).toContain(
				`platform_cutover_assert_release_image_id ${imageKind} "$image"`
			);
			expect(validator).toContain(
				'platform_database_docker run --rm --pull never --network none --read-only'
			);
			expect(validator).toContain(
				'--cap-drop ALL --security-opt no-new-privileges --pids-limit 64'
			);
			expect(validator).toContain(
				`--env ${discriminator} --entrypoint node "$image" -e`
			);
			expect(validator).toContain(
				'const classic = { "x-queue-type": "classic" };'
			);
			expect(validator).not.toMatch(/\snode -e '/);
		}
		expect(
			productionCutoverSource.match(
				/delete rows\[0\]\.arguments\["x-queue-type"\]/g
			)
		).toHaveLength(2);
		expect(
			productionCutoverSource.match(
				/rows\[0\]\.arguments\["x-queue-type"\] = "quorum"/g
			)
		).toHaveLength(2);
		const adminProvisioning = sourceSection(
			productionCutoverSource,
			'platform_cutover_provision_platform_admin_audit_topology() {',
			'platform_cutover_assert_integration_worker_permissions() {'
		);
		expect(
			adminProvisioning.match(
				/arguments: \{ "x-queue-type": "classic" \}/g
			)
		).toHaveLength(3);
		expect(productionCutoverSource).toContain(
			"legacy_listing=$'winwidget.core.billing.settings.v1\\ttrue"
		);
		expect(productionCutoverSource).toContain(
			'platform_cutover_self_test_delete_queue_if_present'
		);
		expect(
			productionCutoverSource.match(
				/rabbitmqctl --silent list_permissions -p "\$vhost" \|/g
			)
		).toHaveLength(2);
		expect(
			productionCutoverSource.match(
				/rabbitmqctl --silent list_topic_permissions -p "\$vhost" \|/g
			)
		).toHaveLength(2);
		expect(productionCutoverSource).not.toMatch(
			/list_permissions -p "\$vhost"\s*\\\s*user configure write read/
		);
		expect(productionCutoverSource).not.toMatch(
			/list_topic_permissions -p "\$vhost"\s*\\\s*user exchange write read/
		);
	});
});
