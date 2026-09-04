import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-sales-client');
const { SalesService } = require('../../dist/src/sales/sales.service.js');
const {
	PipelineTemplateCatalogService
} = require('../../dist/src/templates/pipeline-template-catalog.service.js');
const {
	PipelineTemplateInstallationService
} = require('../../dist/src/pipelines/pipeline-template-installation.service.js');

assert.equal(process.env.CRM_SALES_INTEGRATION_ALLOW_MUTATION, 'true');
const databaseUrl = requiredEnv('CRM_SALES_TEST_DATABASE_URL');
const roleName = requiredEnv('CRM_SALES_TEST_RUNTIME_ROLE');
const url = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/winwidget_crm_sales_test(?:_[a-z0-9]+)*$/);
assert.equal(decodeURIComponent(url.username), roleName);
assert.equal(url.searchParams.get('schema'), 'crm_sales');

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const catalog = new PipelineTemplateCatalogService();
const installer = new PipelineTemplateInstallationService(prisma, catalog);
let allowContact = true;
const service = new SalesService(prisma, {
	requireContact: async (_authorization, workspaceId, id) => {
		if (!allowContact) {
			const error = new Error('contact not visible');
			error.status = 404;
			throw error;
		}
		assert.equal(workspaceId, access.workspaceId);
		return { id, name: 'Integration contact' };
	}
});
const access = {
	schemaVersion: 1,
	workspaceId: randomUUID(),
	subject: 'workflow-owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:write', 'sales:analytics']
};
const contactId = randomUUID();
const nextTask = {
	title: 'Первый звонок',
	dueAt: new Date(Date.now() + 86400000).toISOString()
};

try {
	const [role] = await prisma.$queryRaw`
		SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin AS restricted,
			pg_get_userbyid(nspowner) <> current_user AS not_owner,
			NOT has_database_privilege(current_user, current_database(), 'CREATE') AS database_create_denied,
			NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS foreign_schema_denied
		FROM pg_roles JOIN pg_namespace ON nspname = 'crm_sales' WHERE rolname = current_user
	`;
	assert.equal(role.name, roleName);
	assert.equal(role.restricted, true);
	assert.equal(role.not_owner, true);
	assert.equal(role.database_create_denied, true);
	assert.equal(role.foreign_schema_denied, true);
	assert.ok(role.version >= 180000 && role.version < 190000);
	await assert.rejects(
		prisma.$queryRawUnsafe(
			'SELECT id FROM foreign_service_guard.sentinel LIMIT 1'
		),
		error => error?.meta?.code === '42501'
	);

	const installed = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: access.subject
	});
	const pipeline = await prisma.pipeline.findUniqueOrThrow({
		where: { id: installed.installation.pipelineId },
		include: { stages: true }
	});
	const openStage = pipeline.stages.find(stage => stage.state === 'OPEN');
	const wonStage = pipeline.stages.find(stage => stage.state === 'WON');
	assert.ok(openStage);
	assert.ok(wonStage);
	const foreignWorkspace = randomUUID();
	const other = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: foreignWorkspace,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: 'foreign-owner'
	});
	const foreignStage = await prisma.pipelineStage.findFirstOrThrow({
		where: { pipelineId: other.installation.pipelineId, state: 'OPEN' }
	});
	const command = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		title: 'Проверка workflow',
		currency: 'RUB',
		amountMinor: 120000,
		pipelineId: pipeline.id,
		stageId: openStage.id,
		contactId,
		nextTask
	};

	allowContact = false;
	await assert.rejects(
		service.create(access, command, 'Bearer test'),
		error => error.status === 404
	);
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		0
	);
	allowContact = true;
	const missingTaskPrisma = {
		$transaction: (callback, options) =>
			prisma.$transaction(
				transaction =>
					callback(
						new Proxy(transaction, {
							get(target, property) {
								if (property === 'salesTask')
									return { ...target.salesTask, create: async () => ({}) };
								const value = Reflect.get(target, property);
								return typeof value === 'function'
									? value.bind(target)
									: value;
							}
						})
					),
				options
			)
	};
	const unsavedCommandId = randomUUID();
	await assert.rejects(
		new SalesService(missingTaskPrisma, {
			requireContact: async () => ({
				id: contactId,
				name: 'Injected contact'
			})
		}).create(
			access,
			{ ...command, commandId: unsavedCommandId },
			'Bearer test'
		),
		error => error?.meta?.code === '23503'
	);
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		0,
		'A failed deferred invariant must not acknowledge or persist a deal'
	);
	assert.equal(
		await prisma.salesCommandReceipt.count({
			where: { commandId: unsavedCommandId }
		}),
		0
	);
	await assert.rejects(
		service.create(
			access,
			{ ...command, stageId: foreignStage.id },
			'Bearer test'
		),
		error => error.status === 404
	);
	const results = await Promise.all([
		service.create(access, command, 'Bearer test'),
		service.create(access, command, 'Bearer test')
	]);
	assert.deepEqual(results[0], results[1]);
	let current = results[0].deal;
	assert.equal(current.version, 1);
	assert.equal(current.nextTask.status, 'OPEN');
	assert.equal(
		await prisma.deal.count({
			where: { workspaceId: access.workspaceId }
		}),
		1
	);
	assert.equal(
		await prisma.salesTask.count({
			where: { workspaceId: access.workspaceId, status: 'OPEN' }
		}),
		1
	);
	assert.equal(
		await prisma.dealTimeline.count({ where: { dealId: current.id } }),
		1
	);
	await assert.rejects(
		service.create(
			access,
			{ ...command, title: 'Changed' },
			'Bearer test'
		),
		error => error.status === 409
	);
	await assert.rejects(
		service.detail(
			{ ...access, workspaceId: foreignWorkspace },
			current.id
		),
		error => error.status === 404
	);
	await assert.rejects(
		service.detail(
			{
				...access,
				subject: 'other-manager',
				dataScope: 'OWN',
				role: 'MANAGER'
			},
			current.id
		),
		error => error.status === 404
	);
	await assert.rejects(
		service.detail({ ...access, role: 'ANALYST' }, current.id),
		error => error.status === 403
	);
	await assert.rejects(
		service.create(
			{ ...access, state: 'READ_ONLY' },
			command,
			'Bearer test'
		),
		error => error.status === 403
	);
	assert.equal(
		(await service.analytics({ ...access, role: 'ANALYST' })).items.find(
			item => item.status === 'OPEN'
		).count,
		1
	);
	assert.equal(
		(
			await service.deals(access, {
				page: 1,
				pageSize: 1,
				workspaceId: access.workspaceId,
				search: 'workflow'
			})
		).total,
		1
	);
	assert.equal(
		(
			await service.tasks(access, {
				page: 1,
				pageSize: 20,
				workspaceId: access.workspaceId
			})
		).total,
		1
	);

	await assert.rejects(
		prisma.$transaction(async transaction => {
			await transaction.salesTask.updateMany({
				where: { id: current.nextTask.id },
				data: { status: 'COMPLETED', completedAt: new Date() }
			});
			await transaction.$executeRaw`SET CONSTRAINTS crm_sales.deals_next_task_fkey, crm_sales.deals_next_action_integrity, crm_sales.tasks_next_action_integrity IMMEDIATE`;
		}),
		error =>
			error?.meta?.code === 'P0001' &&
			String(error?.meta?.message).includes(
				'Open deal requires exactly one current next action'
			)
	);
	assert.equal(
		(await service.detail(access, current.id)).deal.nextTask.status,
		'OPEN'
	);
	await assert.rejects(
		prisma.$executeRaw`UPDATE crm_sales.deals SET stage_id = ${foreignStage.id}::uuid WHERE id = ${current.id}::uuid`,
		error => error?.meta?.code === '23503'
	);

	const completeCommand = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.nextTask.version,
		outcome: 'Обсудили предложение',
		nextTask: { ...nextTask, title: 'Подготовить предложение' }
	};
	const completed = await service.complete(
		access,
		current.nextTask.id,
		completeCommand
	);
	assert.equal(completed.deal.version, 2);
	assert.notEqual(completed.deal.nextTask.id, current.nextTask.id);
	assert.deepEqual(
		await service.complete(access, current.nextTask.id, completeCommand),
		completed
	);
	current = completed.deal;
	const transition = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.version,
		targetStageId: wonStage.id,
		outcome: 'Оплачено'
	};
	const competitors = await Promise.allSettled([
		service.transition(access, current.id, transition),
		service.transition(access, current.id, {
			...transition,
			commandId: randomUUID()
		})
	]);
	assert.equal(
		competitors.filter(item => item.status === 'fulfilled').length,
		1
	);
	assert.equal(
		competitors.find(item => item.status === 'rejected').reason.status,
		409
	);
	current = (await service.detail(access, current.id)).deal;
	assert.equal(current.status, 'WON');
	assert.equal(current.nextTask, null);
	assert.equal(current.version, 3);
	assert.equal(
		await prisma.salesTask.count({
			where: { dealId: current.id, status: 'OPEN' }
		}),
		0
	);

	const reopened = await service.transition(access, current.id, {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: current.version,
		targetStageId: openStage.id,
		outcome: 'Повторное обращение',
		nextTask
	});
	assert.equal(reopened.deal.status, 'OPEN');
	assert.equal(reopened.deal.nextTask.status, 'OPEN');
	const archiveCommand = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: access.workspaceId,
		expectedVersion: reopened.deal.version
	};
	const archived = await service.archive(
		access,
		current.id,
		archiveCommand
	);
	assert.ok(archived.deal.archivedAt);
	assert.equal(archived.deal.nextTask, null);
	assert.deepEqual(
		await service.archive(access, current.id, archiveCommand),
		archived
	);
	await assert.rejects(
		service.detail(access, current.id),
		error => error.status === 404
	);
	assert.equal(
		await prisma.dealTimeline.count({ where: { dealId: current.id } }),
		5
	);
	assert.equal(
		(
			await service.tasks(access, {
				workspaceId: access.workspaceId,
				page: 1,
				pageSize: 20
			})
		).total,
		0
	);

	for (const table of ['deal_timeline', 'command_receipts']) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`UPDATE crm_sales.${table} SET workspace_id = workspace_id WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_sales.${table} WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
	}
	for (const table of ['deals', 'tasks']) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_sales.${table} WHERE FALSE`
			),
			error => error?.meta?.code === '42501'
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(`TRUNCATE TABLE crm_sales.${table}`),
			error => error?.meta?.code === '42501'
		);
	}
	console.log(
		'CRM Sales PostgreSQL 18 workflow, tenant scope, replay, CAS and next-action invariants passed'
	);
} finally {
	await prisma.$disconnect();
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	assert.ok(value, `${name} is required`);
	return value;
}
