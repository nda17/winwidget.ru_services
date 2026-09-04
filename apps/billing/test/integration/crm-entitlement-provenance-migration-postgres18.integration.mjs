import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_MIGRATION =
	'20260904092000_add_crm_entitlement_provisioning_provenance';
const ENTITLEMENT_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const AMBIGUOUS_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_ENTITLEMENT_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';
const SECOND_COMMAND_ID = '77777777-7777-4777-8777-777777777777';
const INVALID_WORKSPACE_ID = '88888888-8888-4888-8888-888888888888';
const COMMAND_TYPE = 'ACTIVATE_WINCRM_TRIAL';
const REQUEST_HASH = 'a'.repeat(64);
const LEGACY_REQUEST_HASH = '0'.repeat(64);
const EXPECTED_FAILURES = {
	'ambiguous-receipts':
		'Every WinCRM entitlement must have exactly one accepted provisioning command receipt',
	'invalid-receipt':
		'Cannot backfill WinCRM provisioning provenance from an invalid accepted command receipt',
	'legacy-unbound-receipt':
		'Cannot backfill WinCRM provisioning provenance from an invalid accepted command receipt',
	'missing-receipt':
		'Every WinCRM entitlement must have exactly one accepted provisioning command receipt'
};
const SUPPORTED_SCENARIOS = new Set([
	'valid-backfill',
	...Object.keys(EXPECTED_FAILURES)
]);

if (
	process.env.BILLING_CRM_PROVENANCE_MIGRATION_ALLOW_MUTATION !== 'true'
) {
	throw new Error(
		'BILLING_CRM_PROVENANCE_MIGRATION_ALLOW_MUTATION=true is required'
	);
}

const scenario = requiredEnv('BILLING_CRM_PROVENANCE_TEST_SCENARIO');
assert.ok(
	SUPPORTED_SCENARIOS.has(scenario),
	`Unsupported Billing CRM provenance migration scenario: ${scenario}`
);
const databaseUrl = requiredEnv(
	'BILLING_CRM_PROVENANCE_TEST_DATABASE_URL'
);
const expectedMigrationRole = requiredEnv(
	'BILLING_CRM_PROVENANCE_TEST_MIGRATION_ROLE'
);
assert.match(expectedMigrationRole, /^[a-z][a-z0-9_]{0,62}$/);
assertLocalTestDatabase(databaseUrl, expectedMigrationRole);

const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const prismaRoot = join(appRoot, 'prisma');
const targetMigrationPath = join(
	prismaRoot,
	'migrations',
	TARGET_MIGRATION,
	'migration.sql'
);
const targetMigrationSql = readFileSync(targetMigrationPath, 'utf8');
const validationBlocks =
	targetMigrationSql.match(/DO \$\$[\s\S]*?\$\$;/g) ?? [];
assert.equal(
	validationBlocks.length,
	2,
	'Billing provenance migration must keep both fail-closed validation blocks'
);
assert.doesNotMatch(
	targetMigrationSql,
	/gen_random_uuid|uuid_generate/i,
	'Provisioning provenance migration must not generate replacement UUIDs'
);

const fixtureRoot = mkdtempSync(
	join(tmpdir(), 'winwidget-billing-provenance-upgrade-')
);
const oldPrismaRoot = join(fixtureRoot, 'prisma');
const targetPrismaRoot = join(fixtureRoot, 'target-prisma');
cpSync(prismaRoot, oldPrismaRoot, { recursive: true });
cpSync(prismaRoot, targetPrismaRoot, { recursive: true });
removeMigrationDirectories(
	oldPrismaRoot,
	name => name >= TARGET_MIGRATION
);
removeMigrationDirectories(
	targetPrismaRoot,
	name => name > TARGET_MIGRATION
);

const importedClient = await import('@prisma/billing-client');
const PrismaClient =
	importedClient.PrismaClient || importedClient.default?.PrismaClient;
if (!PrismaClient) {
	throw new Error('Generated Billing Prisma client is unavailable');
}

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});

try {
	assertMigrationSucceeded(
		runMigration(join(oldPrismaRoot, 'schema.prisma'), databaseUrl),
		'Billing pre-provenance migrations'
	);
	await assertMigrationRoleBoundary(prisma, expectedMigrationRole);
	await seedHistoricalState(prisma, scenario);
	if (scenario !== 'valid-backfill') {
		await assertExpectedValidationFailure(prisma, scenario);
	}

	const result = runMigration(
		join(targetPrismaRoot, 'schema.prisma'),
		databaseUrl
	);
	if (scenario === 'valid-backfill') {
		assertMigrationSucceeded(result, 'Billing provenance migration');
		await assertSuccessfulBackfill(prisma);
	} else {
		assert.notEqual(
			result.status,
			0,
			`Billing provenance migration unexpectedly accepted ${scenario}`
		);
		assertRejectedMigrationReason(result, scenario);
		await assertFailedMigrationRolledBack(prisma, scenario);
	}
	await assertMigrationRoleBoundary(prisma, expectedMigrationRole);

	console.log(
		`Billing CRM provenance PostgreSQL 18 upgrade scenario passed: ${scenario}`
	);
} finally {
	await prisma.$disconnect();
	rmSync(fixtureRoot, { recursive: true, force: true });
}

async function seedHistoricalState(client, selectedScenario) {
	await insertHistoricalEntitlement(
		client,
		ENTITLEMENT_ID,
		WORKSPACE_ID,
		42
	);

	if (selectedScenario === 'missing-receipt') return;

	await insertAcceptedReceipt(client, COMMAND_ID, {
		entitlementId: ENTITLEMENT_ID,
		requestHash:
			selectedScenario === 'legacy-unbound-receipt'
				? LEGACY_REQUEST_HASH
				: REQUEST_HASH,
		requestHashVersion:
			selectedScenario === 'legacy-unbound-receipt' ? 0 : 1,
		sourceSequence: 42,
		workspaceId:
			selectedScenario === 'invalid-receipt'
				? INVALID_WORKSPACE_ID
				: WORKSPACE_ID
	});

	if (selectedScenario === 'valid-backfill') {
		await insertHistoricalEntitlement(
			client,
			SECOND_ENTITLEMENT_ID,
			SECOND_WORKSPACE_ID,
			43
		);
		await insertAcceptedReceipt(client, SECOND_COMMAND_ID, {
			entitlementId: SECOND_ENTITLEMENT_ID,
			requestHash: 'b'.repeat(64),
			sourceSequence: 43,
			workspaceId: SECOND_WORKSPACE_ID
		});
	}

	if (selectedScenario === 'ambiguous-receipts') {
		await insertAcceptedReceipt(client, AMBIGUOUS_COMMAND_ID, {
			entitlementId: ENTITLEMENT_ID,
			requestHash: 'c'.repeat(64),
			sourceSequence: 42,
			workspaceId: WORKSPACE_ID
		});
	}
}

async function insertHistoricalEntitlement(
	client,
	entitlementId,
	workspaceId,
	sourceSequence
) {
	await client.$executeRawUnsafe(
		`INSERT INTO "billing"."crm_entitlements" (
			"id", "workspace_id", "product_code", "plan_code", "status",
			"seat_limit", "trial_started_at", "effective_from",
			"effective_until", "activated_by_user_id", "aggregate_version",
			"source_sequence", "created_at", "updated_at"
		) VALUES (
			$1::uuid, $2::uuid, 'WINCRM', 'TRIAL',
			'ACTIVE'::"billing"."CrmEntitlementStatus", NULL,
			TIMESTAMP '2026-09-02 10:00:00',
			TIMESTAMP '2026-09-02 10:00:00',
			TIMESTAMP '2026-09-07 10:00:00', 'identity-user', 1, $3::bigint,
			TIMESTAMP '2026-09-02 10:00:00',
			TIMESTAMP '2026-09-02 10:00:00'
		)`,
		entitlementId,
		workspaceId,
		sourceSequence
	);
}

async function insertAcceptedReceipt(
	client,
	commandId,
	{
		entitlementId,
		requestHash,
		requestHashVersion = 1,
		sourceSequence,
		workspaceId
	}
) {
	await client.$executeRawUnsafe(
		`INSERT INTO "billing"."command_receipts" (
			"command_id", "command_type", "request_hash",
			"request_hash_version", "result", "created_at"
		) VALUES ($1, $2, $3, $4::smallint, $5::jsonb, CURRENT_TIMESTAMP)`,
		commandId,
		COMMAND_TYPE,
		requestHash,
		requestHashVersion,
		JSON.stringify(
			historicalActivationResult(
				entitlementId,
				sourceSequence,
				workspaceId
			)
		)
	);
}

function historicalActivationResult(
	entitlementId,
	sourceSequence,
	workspaceId
) {
	return {
		schemaVersion: 1,
		productCode: 'WINCRM',
		status: 'ACTIVE',
		entitlement: {
			id: entitlementId,
			workspaceId,
			planCode: 'TRIAL',
			seatLimit: null,
			trialStartedAt: '2026-09-02T10:00:00.000Z',
			effectiveFrom: '2026-09-02T10:00:00.000Z',
			effectiveUntil: '2026-09-07T10:00:00.000Z',
			aggregateVersion: '1',
			sourceSequence: String(sourceSequence)
		},
		activated: true
	};
}

async function assertSuccessfulBackfill(client) {
	const rows = await client.$queryRawUnsafe(`
		SELECT
			entitlement."id"::text AS "entitlementId",
			entitlement."workspace_id"::text AS "workspaceId",
			entitlement."provisioning_command_id"::text AS "provisioningCommandId",
			entitlement."provisioning_command_type" AS "provisioningCommandType",
			receipt."command_id" AS "sourceCommandId",
			NOT (receipt."result"->'entitlement' ? 'provisioningCommandId')
				AS "sourceReceiptUnchanged"
		FROM "billing"."crm_entitlements" AS entitlement
		JOIN "billing"."command_receipts" AS receipt
		  ON receipt."command_id" = entitlement."provisioning_command_id"::text
		ORDER BY entitlement."id"
	`);
	assert.deepEqual(rows, [
		{
			entitlementId: ENTITLEMENT_ID,
			workspaceId: WORKSPACE_ID,
			provisioningCommandId: COMMAND_ID,
			provisioningCommandType: COMMAND_TYPE,
			sourceCommandId: COMMAND_ID,
			sourceReceiptUnchanged: true
		},
		{
			entitlementId: SECOND_ENTITLEMENT_ID,
			workspaceId: SECOND_WORKSPACE_ID,
			provisioningCommandId: SECOND_COMMAND_ID,
			provisioningCommandType: COMMAND_TYPE,
			sourceCommandId: SECOND_COMMAND_ID,
			sourceReceiptUnchanged: true
		}
	]);

	const [constraints] = await client.$queryRawUnsafe(`
		SELECT
			(SELECT count(*) = 2
				AND bool_and(
					columns.is_nullable = 'NO'
					AND columns.column_default IS NULL
				)
			 FROM information_schema.columns AS columns
			 WHERE columns.table_schema = 'billing'
			   AND columns.table_name = 'crm_entitlements'
			   AND columns.column_name IN (
				'provisioning_command_id',
				'provisioning_command_type'
			   )) AS "columnsRequiredWithoutDefaults",
			(SELECT indexes.indisunique
				AND indexes.indisvalid
				AND indexes.indisready
				AND (
					SELECT array_agg(attributes.attname::text ORDER BY keys.ordinality)
					FROM unnest(indexes.indkey) WITH ORDINALITY
						AS keys(attnum, ordinality)
					JOIN pg_attribute AS attributes
					  ON attributes.attrelid = indexes.indrelid
					 AND attributes.attnum = keys.attnum
				) = ARRAY['provisioning_command_id']::text[]
			 FROM pg_index AS indexes
			 JOIN pg_class AS index_relations
			   ON index_relations.oid = indexes.indexrelid
			 JOIN pg_namespace AS schemas
			   ON schemas.oid = index_relations.relnamespace
			 WHERE schemas.nspname = 'billing'
			   AND index_relations.relname =
				'crm_entitlements_provisioning_command_id_key')
				AS "exactUniqueIndexPresent",
			(SELECT count(*) = 1
				AND bool_and(
					constraints.contype = 'c'
					AND constraints.convalidated
				)
			 FROM pg_constraint AS constraints
			 WHERE constraints.conrelid =
				'billing.crm_entitlements'::regclass
			   AND constraints.conname =
				'crm_entitlements_provisioning_command_type_check')
				AS "validatedTypeCheckPresent"
	`);
	assert.equal(constraints.columnsRequiredWithoutDefaults, true);
	assert.equal(constraints.exactUniqueIndexPresent, true);
	assert.equal(constraints.validatedTypeCheckPresent, true);

	await assertDatabaseError(
		() =>
			client.$executeRawUnsafe(
				`UPDATE "billing"."crm_entitlements"
				 SET "provisioning_command_id" = NULL
				 WHERE "id" = '${ENTITLEMENT_ID}'::uuid`
			),
		'23502'
	);
	await assertDatabaseError(
		() =>
			client.$executeRawUnsafe(
				`UPDATE "billing"."crm_entitlements"
				 SET "provisioning_command_type" = 'invalid'
				 WHERE "id" = '${ENTITLEMENT_ID}'::uuid`
			),
		'23514'
	);
	await assertDatabaseError(
		() =>
			client.$executeRawUnsafe(
				`UPDATE "billing"."crm_entitlements"
				 SET "provisioning_command_id" = '${COMMAND_ID}'::uuid
				 WHERE "id" = '${SECOND_ENTITLEMENT_ID}'::uuid`
			),
		'23505'
	);

	const [migration] = await client.$queryRawUnsafe(`
		SELECT count(*)::integer AS "count"
		FROM "billing"."_prisma_migrations"
		WHERE migration_name = '${TARGET_MIGRATION}'
		  AND finished_at IS NOT NULL
		  AND rolled_back_at IS NULL
	`);
	assert.equal(migration.count, 1);
}

async function assertFailedMigrationRolledBack(client, selectedScenario) {
	const [state] = await client.$queryRawUnsafe(`
		SELECT
			(SELECT count(*)::integer
			 FROM information_schema.columns
			 WHERE table_schema = 'billing'
			   AND table_name = 'crm_entitlements'
			   AND column_name IN (
				'provisioning_command_id',
				'provisioning_command_type'
			   )) AS "provenanceColumnCount",
			(SELECT count(*)::integer
			 FROM "billing"."crm_entitlements") AS "entitlementCount",
			(SELECT count(*)::integer
			 FROM "billing"."command_receipts"
			 WHERE "command_type" = '${COMMAND_TYPE}'
			   AND "result"->'activated' = 'true'::jsonb) AS "receiptCount",
			(SELECT count(*)::integer
			 FROM "billing"."_prisma_migrations"
			 WHERE migration_name = '${TARGET_MIGRATION}'
			   AND finished_at IS NULL
			   AND rolled_back_at IS NULL) AS "failedMigrationCount"
	`);
	assert.equal(state.provenanceColumnCount, 0);
	assert.equal(state.entitlementCount, 1);
	assert.equal(
		state.receiptCount,
		selectedScenario === 'missing-receipt'
			? 0
			: selectedScenario === 'ambiguous-receipts'
				? 2
				: 1
	);
	assert.equal(state.failedMigrationCount, 1);
}

async function assertMigrationRoleBoundary(client, expectedRole) {
	const [privileges] = await client.$queryRawUnsafe(`
		SELECT
			current_user AS "currentUser",
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
				AND NOT rolinherit AND rolcanlogin AND NOT rolreplication
				AND NOT rolbypassrls AS "restrictedRole",
			NOT has_database_privilege(
				current_user,
				current_database(),
				'CREATE'
			) AS "databaseCreateDenied",
			pg_get_userbyid(schemas.nspowner) = current_user
				AS "ownsBillingSchema",
			NOT has_schema_privilege(
				current_user,
				'foreign_service_guard',
				'USAGE'
			) AS "foreignSchemaDenied"
		FROM pg_roles AS roles
		JOIN pg_namespace AS schemas ON schemas.nspname = 'billing'
		WHERE roles.rolname = current_user
	`);
	assert.equal(privileges.currentUser, expectedRole);
	assert.equal(privileges.restrictedRole, true);
	assert.equal(privileges.databaseCreateDenied, true);
	assert.equal(privileges.ownsBillingSchema, true);
	assert.equal(privileges.foreignSchemaDenied, true);
	await assert.rejects(
		client.$queryRawUnsafe(
			'SELECT id FROM "foreign_service_guard"."sentinel" LIMIT 1'
		),
		error =>
			error?.meta?.code === '42501' ||
			/permission denied|insufficient privilege/i.test(
				String(error?.message)
			)
	);
}

async function assertDatabaseError(operation, expectedCode) {
	await assert.rejects(operation, error => {
		const databaseCode = error?.meta?.code;
		return (
			databaseCode === expectedCode ||
			new RegExp(`(?:SQLSTATE|code)[^0-9A-Z]*${expectedCode}`, 'i').test(
				String(error?.message)
			)
		);
	});
}

function removeMigrationDirectories(prismaDirectory, shouldRemove) {
	const migrationsRoot = join(prismaDirectory, 'migrations');
	for (const entry of readdirSync(migrationsRoot, {
		withFileTypes: true
	})) {
		if (!entry.isDirectory() || !shouldRemove(entry.name)) continue;
		rmSync(join(migrationsRoot, entry.name), {
			recursive: true,
			force: true
		});
	}
}

function runMigration(schemaPath, url) {
	return spawnSync(
		'pnpm',
		['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath],
		{
			cwd: appRoot,
			encoding: 'utf8',
			env: { ...process.env, BILLING_DATABASE_URL: url },
			timeout: 120_000
		}
	);
}

function assertMigrationSucceeded(result, label) {
	if (result.status !== 0) {
		throw new Error(
			`${label} failed:\n${result.stdout}\n${result.stderr}`
		);
	}
}

function assertRejectedMigrationReason(result, selectedScenario) {
	const expectedReason = EXPECTED_FAILURES[selectedScenario];
	assert.match(
		targetMigrationSql,
		new RegExp(escapeRegExp(expectedReason)),
		`Billing provenance migration is missing the fail-closed ${selectedScenario} reason`
	);
	const output = `${result.stdout}\n${result.stderr}`;
	if (output.includes(expectedReason)) return;

	// Prisma 5 tries to persist its migration log before rolling back an
	// explicitly opened PostgreSQL transaction. PostgreSQL correctly raises the
	// domain error first, but Prisma then exposes only the follow-up 25P02 error.
	assert.match(
		output,
		/current transaction is aborted/i,
		`Billing provenance migration did not reject ${selectedScenario} through the expected transactional failure path`
	);
}

async function assertExpectedValidationFailure(client, selectedScenario) {
	let validationError;
	for (const validationSql of validationBlocks) {
		try {
			await client.$executeRawUnsafe(validationSql);
		} catch (error) {
			validationError = error;
			break;
		}
	}

	assert.ok(
		validationError,
		`Billing provenance validation unexpectedly accepted ${selectedScenario}`
	);
	assert.match(
		String(validationError.message),
		new RegExp(escapeRegExp(EXPECTED_FAILURES[selectedScenario])),
		`Billing provenance validation did not reject ${selectedScenario} for the expected domain reason`
	);
}

function assertLocalTestDatabase(rawValue, expectedRole) {
	const url = new URL(rawValue);
	assert.ok(
		url.hostname === '127.0.0.1' || url.hostname === 'localhost',
		'Billing provenance migration test database must be local'
	);
	assert.match(
		url.pathname.slice(1),
		/(?:^|_)(?:ci|test)(?:_|$)/,
		'Billing provenance migration test database name must be CI/test-only'
	);
	assert.equal(
		decodeURIComponent(url.username),
		expectedRole,
		'Billing provenance migration must run through its dedicated migration role'
	);
	assert.equal(url.searchParams.get('schema'), 'billing');
	return url.pathname.slice(1);
}

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
