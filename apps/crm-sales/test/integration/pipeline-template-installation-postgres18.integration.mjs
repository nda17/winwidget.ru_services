import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const runtimeDatabaseUrl = requiredEnv('CRM_SALES_TEST_DATABASE_URL');
const migrationDatabaseUrl = requiredEnv(
	'CRM_SALES_TEST_MIGRATION_DATABASE_URL'
);
const expectedRuntimeRole = requiredEnv('CRM_SALES_TEST_RUNTIME_ROLE');
if (process.env.CRM_SALES_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('CRM_SALES_INTEGRATION_ALLOW_MUTATION=true is required');
}
const runtimeDatabase = assertLocalTestDatabase(
	runtimeDatabaseUrl,
	'CRM_SALES_TEST_DATABASE_URL'
);
const migrationDatabase = assertLocalTestDatabase(
	migrationDatabaseUrl,
	'CRM_SALES_TEST_MIGRATION_DATABASE_URL'
);
assert.equal(
	runtimeDatabase,
	migrationDatabase,
	'CRM Sales runtime and migration roles must use the same test database'
);

const appRoot = new URL('../../', import.meta.url);
const migration = spawnSync('pnpm', ['run', 'prisma:migrate:deploy'], {
	cwd: appRoot,
	env: { ...process.env, CRM_SALES_DATABASE_URL: migrationDatabaseUrl },
	encoding: 'utf8',
	timeout: 120_000
});
if (migration.status !== 0) {
	throw new Error(
		`CRM Sales migration failed:\n${migration.stdout}\n${migration.stderr}`
	);
}

const importedClient = await import('@prisma/crm-sales-client');
const PrismaClient =
	importedClient.PrismaClient || importedClient.default?.PrismaClient;
const importedCatalog = await import(
	new URL(
		'../../dist/src/templates/pipeline-template-catalog.service.js',
		import.meta.url
	)
);
const PipelineTemplateCatalogService =
	importedCatalog.PipelineTemplateCatalogService ||
	importedCatalog.default?.PipelineTemplateCatalogService;
const importedInstallation = await import(
	new URL(
		'../../dist/src/pipelines/pipeline-template-installation.service.js',
		import.meta.url
	)
);
const PipelineTemplateInstallationService =
	importedInstallation.PipelineTemplateInstallationService ||
	importedInstallation.default?.PipelineTemplateInstallationService;
if (
	!PrismaClient ||
	!PipelineTemplateCatalogService ||
	!PipelineTemplateInstallationService
) {
	throw new Error(
		'Compiled CRM Sales integration dependencies are unavailable'
	);
}

const prisma = new PrismaClient({
	datasources: { db: { url: runtimeDatabaseUrl } }
});
const migrationPrisma = new PrismaClient({
	datasources: { db: { url: migrationDatabaseUrl } }
});
const catalog = new PipelineTemplateCatalogService();
const service = new PipelineTemplateInstallationService(prisma, catalog);
const workspaceIds = Array.from({ length: 5 }, () => randomUUID());
const forbiddenTable = `runtime_forbidden_${randomUUID().replaceAll('-', '')}`;

try {
	await assertRuntimeLeastPrivilege(
		prisma,
		expectedRuntimeRole,
		forbiddenTable
	);

	const firstCommand = command(workspaceIds[0], randomUUID());
	const first = await service.install(firstCommand);
	assert.equal(first.schemaVersion, 1);
	assert.equal(first.installation.commandId, firstCommand.commandId);
	assert.equal(
		first.installation.initialCommandId,
		firstCommand.commandId
	);
	assert.equal(first.installation.workspaceId, firstCommand.workspaceId);
	assert.equal(first.installation.templateKey, firstCommand.templateKey);
	assert.equal(first.installation.templateVersion, 1);
	assert.match(first.installation.templateFingerprint, /^[0-9a-f]{64}$/);

	const expectedStageCount = catalog.getTemplate('universal-sales', 1)
		.stages.length;
	assert.deepEqual(await service.install(firstCommand), first);
	await assertWorkspaceCounts(prisma, workspaceIds[0], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 1
	});

	await assert.rejects(
		service.install({ ...firstCommand, templateKey: 'blank' }),
		isHttpStatus(409)
	);
	await assertWorkspaceCounts(prisma, workspaceIds[0], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 1
	});

	const recoveredCommand = command(workspaceIds[0], randomUUID(), {
		installedBySubject: 'replacement-owner'
	});
	const recovered = await service.install(recoveredCommand);
	assert.equal(
		recovered.installation.commandId,
		recoveredCommand.commandId
	);
	assert.equal(
		recovered.installation.initialCommandId,
		firstCommand.commandId
	);
	assert.equal(
		recovered.installation.pipelineId,
		first.installation.pipelineId
	);
	await assertWorkspaceCounts(prisma, workspaceIds[0], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 2
	});
	await assert.rejects(
		service.install(
			command(workspaceIds[0], randomUUID(), { templateKey: 'blank' })
		),
		isHttpStatus(409)
	);
	await assertWorkspaceCounts(prisma, workspaceIds[0], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 2
	});

	const concurrentCommand = command(workspaceIds[1], randomUUID());
	const identical = await Promise.all([
		service.install(concurrentCommand),
		service.install(concurrentCommand)
	]);
	assert.deepEqual(identical[0], identical[1]);
	await assertWorkspaceCounts(prisma, workspaceIds[1], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 1
	});

	const concurrentSamePair = [
		command(workspaceIds[2], randomUUID()),
		command(workspaceIds[2], randomUUID())
	];
	const samePairResults = await Promise.all(
		concurrentSamePair.map(value => service.install(value))
	);
	assert.equal(
		samePairResults[0].installation.pipelineId,
		samePairResults[1].installation.pipelineId
	);
	assert.equal(
		new Set(
			samePairResults.map(value => value.installation.initialCommandId)
		).size,
		1
	);
	await assertWorkspaceCounts(prisma, workspaceIds[2], {
		pipelines: 1,
		stages: expectedStageCount,
		installations: 1,
		commands: 2
	});

	await assert.rejects(
		service.install(
			command(workspaceIds[3], randomUUID(), {
				templateKey: 'missing-template'
			})
		),
		isHttpStatus(404)
	);
	await assertWorkspaceCounts(prisma, workspaceIds[3], {
		pipelines: 0,
		stages: 0,
		installations: 0,
		commands: 0
	});

	const rollbackService = new PipelineTemplateInstallationService(
		createReceiptFailurePrisma(prisma),
		catalog
	);
	await assert.rejects(
		rollbackService.install(command(workspaceIds[4], randomUUID())),
		/forced integration receipt failure/
	);
	await assertWorkspaceCounts(prisma, workspaceIds[4], {
		pipelines: 0,
		stages: 0,
		installations: 0,
		commands: 0
	});

	const summary = await service.getInstallation(workspaceIds[0]);
	assert.equal(
		summary.installation.pipelineId,
		first.installation.pipelineId
	);
	assert.equal(
		summary.installation.initialCommandId,
		firstCommand.commandId
	);

	console.log(
		'CRM Sales PostgreSQL 18 atomic installation and runtime-role integration passed'
	);
} finally {
	await cleanupWorkspaces(migrationPrisma, workspaceIds).catch(
		() => undefined
	);
	await migrationPrisma
		.$executeRawUnsafe(
			`DROP TABLE IF EXISTS "crm_sales"."${forbiddenTable}"`
		)
		.catch(() => undefined);
	await Promise.all([prisma.$disconnect(), migrationPrisma.$disconnect()]);
}

function command(workspaceId, commandId, overrides = {}) {
	return {
		schemaVersion: 1,
		commandId,
		workspaceId,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: 'identity-subject',
		...overrides
	};
}

async function assertRuntimeLeastPrivilege(
	client,
	expectedRole,
	forbiddenTableName
) {
	const [privileges] = await client.$queryRawUnsafe(`
		SELECT
			current_user AS "currentUser",
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
				AND NOT rolinherit AND rolcanlogin AND NOT rolreplication
				AND NOT rolbypassrls AS "restrictedRole",
			has_database_privilege(current_user, current_database(), 'CONNECT')
				AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
				AS "databaseBoundary",
			has_schema_privilege(current_user, 'crm_sales', 'USAGE')
				AND NOT has_schema_privilege(current_user, 'crm_sales', 'CREATE')
				AS "schemaBoundary",
			NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE')
				AND NOT has_schema_privilege(current_user, 'foreign_service_guard', 'CREATE')
				AS "foreignSchemaBoundary",
			(SELECT NOT has_table_privilege(current_user, tables.oid, 'SELECT')
			 FROM pg_class AS tables
			 JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
			 WHERE schemas.nspname = 'crm_sales'
			   AND tables.relname = '_prisma_migrations') AS "migrationTableDenied",
			(SELECT NOT has_table_privilege(current_user, tables.oid, 'SELECT')
			 FROM pg_class AS tables
			 JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
			 WHERE schemas.nspname = 'foreign_service_guard'
			   AND tables.relname = 'sentinel') AS "foreignTableDenied",
			(SELECT count(*) = 2 AND bool_and(
				has_table_privilege(current_user, tables.oid, 'SELECT')
				AND has_table_privilege(current_user, tables.oid, 'INSERT')
				AND has_table_privilege(current_user, tables.oid, 'UPDATE')
				AND has_table_privilege(current_user, tables.oid, 'DELETE')
			 )
			 FROM pg_class AS tables
			 JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
			 WHERE schemas.nspname = 'crm_sales'
			   AND tables.relname IN ('pipelines', 'pipeline_stages'))
				AS "mutableTablesDmlAllowed",
			(SELECT count(*) = 2 AND bool_and(
				has_table_privilege(current_user, tables.oid, 'SELECT')
				AND has_table_privilege(current_user, tables.oid, 'INSERT')
				AND NOT has_table_privilege(current_user, tables.oid, 'UPDATE')
				AND NOT has_table_privilege(current_user, tables.oid, 'DELETE')
			 )
			 FROM pg_class AS tables
			 JOIN pg_namespace AS schemas ON schemas.oid = tables.relnamespace
			 WHERE schemas.nspname = 'crm_sales'
			   AND tables.relname IN (
				'pipeline_template_installations',
				'pipeline_template_installation_commands'
			   )) AS "immutableTablesAppendOnly"
		FROM pg_roles
		WHERE rolname = current_user
	`);
	assert.equal(privileges.currentUser, expectedRole);
	assert.equal(privileges.restrictedRole, true);
	assert.equal(privileges.databaseBoundary, true);
	assert.equal(privileges.schemaBoundary, true);
	assert.equal(privileges.foreignSchemaBoundary, true);
	assert.equal(privileges.migrationTableDenied, true);
	assert.equal(privileges.foreignTableDenied, true);
	assert.equal(privileges.mutableTablesDmlAllowed, true);
	assert.equal(privileges.immutableTablesAppendOnly, true);

	await assertPermissionDenied(() =>
		client.$executeRawUnsafe(
			`CREATE TABLE "crm_sales"."${forbiddenTableName}" (id INTEGER PRIMARY KEY)`
		)
	);
	await assertPermissionDenied(() =>
		client.$queryRawUnsafe(
			'SELECT migration_name FROM "crm_sales"."_prisma_migrations" LIMIT 1'
		)
	);
	await assertPermissionDenied(() =>
		client.$queryRawUnsafe(
			'SELECT id FROM "foreign_service_guard"."sentinel" LIMIT 1'
		)
	);
	await assertPermissionDenied(() =>
		client.$executeRawUnsafe(
			'UPDATE "crm_sales"."service_identity" SET "updated_at" = CURRENT_TIMESTAMP'
		)
	);
	await assertImmutableTableMutationsDenied(
		client,
		'pipeline_template_installations',
		'template_key'
	);
	await assertImmutableTableMutationsDenied(
		client,
		'pipeline_template_installation_commands',
		'request_hash'
	);
}

async function assertImmutableTableMutationsDenied(
	client,
	tableName,
	columnName
) {
	await assertPermissionDenied(() =>
		client.$executeRawUnsafe(
			`UPDATE "crm_sales"."${tableName}" SET "${columnName}" = "${columnName}" WHERE FALSE`
		)
	);
	await assertPermissionDenied(() =>
		client.$executeRawUnsafe(
			`DELETE FROM "crm_sales"."${tableName}" WHERE FALSE`
		)
	);
}

async function assertPermissionDenied(operation) {
	await assert.rejects(operation, error => {
		const databaseCode = error?.meta?.code;
		return (
			databaseCode === '42501' ||
			/permission denied|insufficient privilege/i.test(
				String(error?.message)
			)
		);
	});
}

function createReceiptFailurePrisma(client) {
	return {
		$transaction: (callback, options) =>
			client.$transaction(
				transaction =>
					callback(createReceiptFailureTransaction(transaction)),
				options
			)
	};
}

function createReceiptFailureTransaction(transaction) {
	const receipt = new Proxy(
		transaction.pipelineTemplateInstallationCommand,
		{
			get(target, property, receiver) {
				if (property === 'create') {
					return async () => {
						throw new Error('forced integration receipt failure');
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		}
	);
	return new Proxy(transaction, {
		get(target, property, receiver) {
			if (property === 'pipelineTemplateInstallationCommand')
				return receipt;
			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

async function assertWorkspaceCounts(client, workspaceId, expected) {
	const [pipelines, stages, installations, commands] = await Promise.all([
		client.pipeline.count({ where: { workspaceId } }),
		client.pipelineStage.count({ where: { workspaceId } }),
		client.pipelineTemplateInstallation.count({ where: { workspaceId } }),
		client.pipelineTemplateInstallationCommand.count({
			where: { installation: { workspaceId } }
		})
	]);
	assert.deepEqual(
		{ pipelines, stages, installations, commands },
		expected
	);
}

async function cleanupWorkspaces(client, workspaceId) {
	await client.$transaction(async transaction => {
		await transaction.pipelineTemplateInstallationCommand.deleteMany({
			where: { installation: { workspaceId: { in: workspaceId } } }
		});
		await transaction.pipelineTemplateInstallation.deleteMany({
			where: { workspaceId: { in: workspaceId } }
		});
		await transaction.pipeline.deleteMany({
			where: { workspaceId: { in: workspaceId } }
		});
	});
}

function isHttpStatus(status) {
	return error =>
		typeof error?.getStatus === 'function' && error.getStatus() === status;
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function assertLocalTestDatabase(rawValue, variableName) {
	const parsed = new URL(rawValue);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\//, '')
	).toLowerCase();
	if (
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!/(?:_ci|_test)$/.test(databaseName) ||
		parsed.searchParams.get('schema') !== 'crm_sales'
	) {
		throw new Error(
			`${variableName} must point to the crm_sales schema of a local test or CI database`
		);
	}
	return databaseName;
}
