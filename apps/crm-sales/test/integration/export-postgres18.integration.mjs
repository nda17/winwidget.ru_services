import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const required = name => {
	const value = process.env[name];
	assert.ok(value, name + ' is required');
	return value;
};
const local = value => {
	const url = new URL(value);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
	assert.match(url.pathname, /^\/winwidget_crm_sales_test[a-z0-9_]*$/);
	assert.equal(url.searchParams.get('schema'), 'crm_sales');
	return url.hostname + ':' + url.port + url.pathname;
};
const runtimeUrl = required('CRM_SALES_TEST_DATABASE_URL');
const migrationUrl = required('CRM_SALES_TEST_MIGRATION_DATABASE_URL');
const expectedRole = required('CRM_SALES_TEST_RUNTIME_ROLE');
assert.equal(process.env.CRM_SALES_INTEGRATION_ALLOW_MUTATION, 'true');
assert.equal(local(runtimeUrl), local(migrationUrl));
assert.notEqual(
	new URL(runtimeUrl).username,
	new URL(migrationUrl).username
);
assert.equal(
	decodeURIComponent(new URL(runtimeUrl).username),
	expectedRole
);
const { PrismaClient } = require('@prisma/crm-sales-client');
const {
	SalesExportService
} = require('../../dist/src/exports/export.service.js');
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const workspaces = Array.from({ length: 5 }, () => randomUUID());
const teamId = randomUUID();
let context = {
	schemaVersion: 1,
	workspaceId: workspaces[0],
	subject: 'a'.repeat(256),
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['sales:read', 'sales:export']
};
let authHook = null;
let authCalls = 0;
let pageHook = null;
let taskPageHook = null;
const authorization = {
	authorize: async (_bearer, workspaceId) => {
		authCalls++;
		if (authHook) await authHook();
		return { ...context, workspaceId };
	}
};
const proxy = new Proxy(runtime, {
	get(target, key) {
		if (key === '$transaction')
			return (fn, options) =>
				target.$transaction(
					tx =>
						fn(
							new Proxy(tx, {
								get(current, property) {
									if (!['deal', 'salesTask'].includes(property))
										return current[property];
									return new Proxy(current[property], {
										get(model, method) {
											if (method !== 'findMany') return model[method];
											return async args => {
												const result = await model.findMany(args);
												const hook =
													property === 'deal' ? pageHook : taskPageHook;
												if (hook) await hook(current, args, result);
												return result;
											};
										}
									});
								}
							})
						),
					options
				);
		return target[key];
	}
});
const service = new SalesExportService(proxy, authorization);
const http = status => error => error?.getStatus?.() === status;
const sqlState = code => error =>
	error?.meta?.code === code || error?.code === code;
const auditCount = () =>
	runtime.exportAudit.count({ where: { workspaceId: workspaces[0] } });
const {
	PipelineTemplateCatalogService
} = require('../../dist/src/templates/pipeline-template-catalog.service.js');
const {
	PipelineTemplateInstallationService
} = require('../../dist/src/pipelines/pipeline-template-installation.service.js');
const installer = new PipelineTemplateInstallationService(
	runtime,
	new PipelineTemplateCatalogService()
);
async function seed(workspaceId, count, large = false) {
	const installed = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: context.subject
	});
	const pipeline = await runtime.pipeline.findUniqueOrThrow({
		where: { id: installed.installation.pipelineId },
		include: { stages: true }
	});
	const stage = pipeline.stages.find(row => row.state === 'WON');
	assert.ok(stage);
	if (large) {
		await runtime.pipeline.update({
			where: { id: pipeline.id },
			data: { name: 'я'.repeat(200) }
		});
		await runtime.pipelineStage.update({
			where: { id: stage.id },
			data: { name: 'я'.repeat(200) }
		});
	}
	const data = Array.from({ length: count }, () => ({
		id: randomUUID(),
		workspaceId,
		title: large ? 'я'.repeat(200) : '=Example',
		currency: 'RUB',
		amountMinor: 100,
		pipelineId: pipeline.id,
		stageId: stage.id,
		status: 'WON',
		contactId: randomUUID(),
		contactName: large ? 'я'.repeat(200) : 'before',
		assignedToSubject: context.subject,
		teamId,
		archivedAt: new Date('2026-09-01T00:00:00.000Z')
	}));
	for (let n = 0; n < data.length; n += 500)
		await runtime.$transaction(
			async tx => {
				await tx.deal.createMany({ data: data.slice(n, n + 500) });
				await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
			},
			{ timeout: 10000 }
		);
	return data.map(row => row.id).sort();
}
try {
	const [role] = await runtime.$queryRawUnsafe(
		"SELECT current_user AS name,current_setting('server_version_num')::integer AS version,NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname=current_user"
	);
	assert.equal(role.name, expectedRole);
	assert.equal(role.restricted, true);
	assert.equal(Math.floor(role.version / 10000), 18);
	const [acl] = await runtime.$queryRawUnsafe(
		"SELECT has_table_privilege(current_user,'crm_sales.export_audit','SELECT') AS read,has_table_privilege(current_user,'crm_sales.export_audit','INSERT') AS append,has_table_privilege(current_user,'crm_sales.export_audit','TRUNCATE') AS truncate"
	);
	assert.deepEqual(acl, { read: true, append: true, truncate: false });
	for (const sql of [
		'UPDATE crm_sales.export_audit SET row_count=row_count WHERE false',
		'DELETE FROM crm_sales.export_audit WHERE false',
		'SELECT * FROM foreign_service_guard.sentinel',
		'SELECT migration_name FROM crm_sales._prisma_migrations LIMIT 0'
	])
		await assert.rejects(runtime.$queryRawUnsafe(sql), sqlState('42501'));
	const ids = await seed(workspaces[0], 501);
	await seed(workspaces[1], 1);
	let modified = false;
	pageHook = async (_tx, args) => {
		if (!modified && !args.where.id) {
			modified = true;
			await runtime.deal.update({
				where: { id: ids[500] },
				data: { contactName: 'after' }
			});
		}
	};
	const snapshot = await service.prepare(
		'Bearer test',
		workspaces[0],
		'deals',
		'json'
	);
	pageHook = null;
	assert.equal(snapshot.rowCount, 501);
	assert.equal(authCalls, 2);
	const items = JSON.parse(snapshot.body).items;
	assert.ok(items.every(row => row.workspaceId === workspaces[0]));
	assert.equal(
		items.find(row => row.id === ids[500]).contactName,
		'before'
	);
	assert.equal(
		(await runtime.deal.findUnique({ where: { id: ids[500] } }))
			.contactName,
		'after'
	);
	assert.ok(items.every(row => row.archivedAt !== null));
	await runtime.salesTask.create({
		data: {
			workspaceId: workspaces[0],
			dealId: ids[0],
			title: 'Завершённая задача',
			dueAt: new Date(),
			status: 'COMPLETED',
			completedAt: new Date(),
			assignedToSubject: context.subject
		}
	});
	const tasks = await service.prepare(
		'Bearer test',
		workspaces[0],
		'tasks',
		'json'
	);
	assert.equal(tasks.rowCount, 1);
	assert.equal(JSON.parse(tasks.body).items[0].status, 'COMPLETED');
	const csv = await service.prepare(
		'Bearer test',
		workspaces[0],
		'deals',
		'csv'
	);
	assert.ok(csv.body.toString().startsWith('\uFEFF"id","workspaceId"'));
	assert.ok(csv.body.toString().includes('"\'=Example"'));
	const before = await auditCount();
	authCalls = 0;
	authHook = () => {
		if (authCalls === 2) context = { ...context, role: 'CRM_ADMIN' };
	};
	await assert.rejects(
		service.prepare('Bearer test', workspaces[0], 'deals', 'json'),
		http(403)
	);
	assert.equal(await auditCount(), before);
	authHook = null;
	context = { ...context, role: 'OWNER' };
	context = { ...context, dataScope: 'OWN', subject: 'stranger' };
	assert.equal(
		(await service.prepare('Bearer test', workspaces[0], 'deals', 'json'))
			.rowCount,
		0
	);
	context = { ...context, dataScope: 'TEAM', teamIds: [teamId] };
	assert.equal(
		(await service.prepare('Bearer test', workspaces[0], 'deals', 'json'))
			.rowCount,
		501
	);
	context = { ...context, subject: 'a'.repeat(256), dataScope: 'ALL' };
	await assert.rejects(
		runtime.$transaction(async tx => {
			await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
			await tx.exportAudit.create({
				data: {
					workspaceId: workspaces[0],
					actorSubject: context.subject,
					entity: 'deals',
					format: 'json',
					rowCount: 0,
					byteCount: 1,
					snapshotAt: new Date()
				}
			});
		}),
		error =>
			error?.meta?.code === '25006' ||
			error?.message?.includes('read-only')
	);
	const auditFailure = new SalesExportService(
		new Proxy(proxy, {
			get(target, key) {
				return key === 'exportAudit'
					? {
							create: async () => {
								throw new Error('private-data');
							}
						}
					: target[key];
			}
		}),
		authorization
	);
	const auditBefore = await auditCount();
	await assert.rejects(
		auditFailure.prepare('Bearer test', workspaces[0], 'deals', 'json'),
		http(503)
	);
	assert.equal(await auditCount(), auditBefore);
	pageHook = async tx => {
		await tx.$executeRawUnsafe('SELECT pg_sleep(6)');
	};
	const began = Date.now();
	await assert.rejects(
		service.prepare('Bearer test', workspaces[0], 'deals', 'json'),
		http(503)
	);
	pageHook = null;
	assert.ok(Date.now() - began < 5500);
	await seed(workspaces[2], 10001);
	await assert.rejects(
		service.prepare('Bearer test', workspaces[2], 'deals', 'json'),
		http(413)
	);
	assert.equal(
		await runtime.exportAudit.count({
			where: { workspaceId: workspaces[2] }
		}),
		0
	);
	await seed(workspaces[3], 8500, true);
	await assert.rejects(
		service.prepare('Bearer test', workspaces[3], 'deals', 'json'),
		http(413)
	);
	assert.equal(
		await runtime.exportAudit.count({
			where: { workspaceId: workspaces[3] }
		}),
		0
	);
	await verifyTaskExportV2();
	console.log(
		'Sales export PG18: repeatable snapshot, fresh revoke, scope, archives, row/UTF8 caps, SQL deadline, audit and restricted ACL passed'
	);
} catch (error) {
	console.error(
		'Sales export PG18 failed safely',
		JSON.stringify({
			name: error?.name,
			code: error?.code,
			sqlState: error?.meta?.code,
			status: error?.getStatus?.(),
			assertion: error?.operator
		})
	);
	process.exitCode = 1;
} finally {
	try {
		// This receipt owns only installation_id; scope cleanup through its own FK.
		await migrator.$executeRawUnsafe(
			'DELETE FROM crm_sales.pipeline_template_installation_commands WHERE installation_id IN (SELECT id FROM crm_sales.pipeline_template_installations WHERE workspace_id = ANY($1::uuid[]))',
			workspaces
		);
		for (const table of [
			'export_audit',
			'tasks',
			'deals',
			'pipeline_template_installations',
			'pipeline_stages',
			'pipelines'
		])
			await migrator.$executeRawUnsafe(
				'DELETE FROM crm_sales.' +
					table +
					' WHERE workspace_id = ANY($1::uuid[])',
				workspaces
			);
	} catch (error) {
		console.error(
			'Sales export test cleanup failed safely',
			JSON.stringify({ code: error?.code, sqlState: error?.meta?.code })
		);
		process.exitCode = 1;
	}
	await runtime.$disconnect();
	await migrator.$disconnect();
}

async function verifyTaskExportV2() {
	const savedContext = context;
	const workspaceId = workspaces[4];
	const otherTeamId = randomUUID();
	const ownerSubject = context.subject;
	context = {
		...context,
		workspaceId,
		dataScope: 'ALL',
		teamIds: [teamId]
	};
	try {
		const parentIds = await seed(workspaceId, 4);
		for (let index = 0; index < 3; index++) {
			await runtime.deal.update({
				where: { id: parentIds[index] },
				data: {
					archivedAt: null,
					assignedToSubject: index === 0 ? ownerSubject : 'peer',
					teamId: index === 2 ? otherTeamId : teamId
				}
			});
		}
		const date = new Date('2026-09-07T10:00:00.000Z');
		const membershipId = randomUUID();
		const task = data => ({
			id: randomUUID(),
			workspaceId,
			dealId: null,
			title: '=Встреча\n"😀"',
			dueAt: date,
			status: 'COMPLETED',
			completedAt: date,
			assignedToSubject: ownerSubject,
			assignedToMembershipId: null,
			teamId: null,
			...data
		});
		const ownStandalone = task({ status: 'OPEN', completedAt: null });
		const teamStandalone = task({
			status: 'IN_PROGRESS',
			completedAt: null,
			assignedToSubject: 'peer',
			assignedToMembershipId: membershipId,
			teamId
		});
		const otherStandalone = task({
			assignedToSubject: 'peer',
			teamId: otherTeamId
		});
		const ownParent = task({
			dealId: parentIds[0],
			assignedToSubject: 'peer',
			teamId: otherTeamId
		});
		const teamParent = task({
			dealId: parentIds[1],
			assignedToSubject: 'peer',
			status: 'CANCELLED',
			teamId: otherTeamId
		});
		// Its task assignment/team cannot reveal a currently hidden parent.
		const hiddenParent = task({ dealId: parentIds[2], teamId });
		const archivedParent = task({ dealId: parentIds[3], teamId });
		const fixtures = [
			ownStandalone,
			teamStandalone,
			otherStandalone,
			ownParent,
			teamParent,
			hiddenParent,
			archivedParent
		];
		await runtime.salesTask.createMany({ data: fixtures });
		const foreignStandalone = task({
			workspaceId: workspaces[1],
			title: 'foreign-workspace'
		});
		await runtime.salesTask.create({ data: foreignStandalone });
		await assert.rejects(
			runtime.salesTask.create({
				data: task({ workspaceId: workspaces[1], dealId: parentIds[0] })
			})
		);
		const download = async (dataScope = 'ALL', format = 'json') => {
			context = { ...context, dataScope };
			return service.prepareTasksV2('Bearer test', workspaceId, format);
		};
		const idsFrom = file =>
			JSON.parse(file.body)
				.items.map(item => item.id)
				.sort();
		assert.deepEqual(
			idsFrom(await download('OWN')),
			[ownStandalone.id, ownParent.id].sort()
		);
		assert.deepEqual(
			idsFrom(await download('TEAM')),
			[
				ownStandalone.id,
				teamStandalone.id,
				ownParent.id,
				teamParent.id
			].sort()
		);
		const allFile = await download();
		const all = JSON.parse(allFile.body);
		assert.equal(all.schemaVersion, 2);
		assert.equal(all.entity, 'tasks');
		assert.deepEqual(
			idsFrom(allFile),
			fixtures
				.filter(item => item !== archivedParent)
				.map(item => item.id)
				.sort()
		);
		assert.ok(
			all.items.every(
				item =>
					item.workspaceId === workspaceId &&
					!('deal' in item) &&
					!('timeline' in item)
			)
		);
		assert.equal(
			all.items.find(item => item.id === ownStandalone.id).dealId,
			null
		);
		assert.equal(
			all.items.find(item => item.id === ownStandalone.id)
				.assignedToMembershipId,
			null
		);
		assert.equal(
			all.items.find(item => item.id === ownStandalone.id).teamId,
			null
		);
		assert.equal(
			all.items.find(item => item.id === teamStandalone.id)
				.assignedToMembershipId,
			membershipId
		);
		assert.equal(
			all.items.find(item => item.id === ownParent.id).teamId,
			teamId
		);
		assert.equal(
			all.items.find(item => item.id === teamParent.id).teamId,
			teamId
		);
		assert.deepEqual(
			[...new Set(all.items.map(item => item.status))].sort(),
			['CANCELLED', 'COMPLETED', 'IN_PROGRESS', 'OPEN']
		);
		const v1 = await service.prepare(
			'Bearer test',
			workspaceId,
			'tasks',
			'json'
		);
		assert.equal(JSON.parse(v1.body).schemaVersion, 1);
		assert.deepEqual(
			idsFrom(v1),
			[
				ownParent.id,
				teamParent.id,
				hiddenParent.id,
				archivedParent.id
			].sort()
		);
		assert.ok(
			JSON.parse(v1.body).items.every(
				item =>
					item.dealId &&
					!('teamId' in item) &&
					!('assignedToMembershipId' in item)
			)
		);
		const csv = await download('ALL', 'csv');
		assert.ok(
			csv.body
				.toString()
				.startsWith('\uFEFF"id","workspaceId","dealId","version"')
		);
		assert.ok(csv.body.toString().includes('"\'=Встреча\n""😀"""'));
		const v2Audit = await runtime.exportAudit.findFirstOrThrow({
			where: { workspaceId, entity: 'tasks', format: 'csv' },
			orderBy: { preparedAt: 'desc' }
		});
		assert.equal(v2Audit.rowCount, 6);
		assert.equal(v2Audit.byteCount, csv.body.byteLength);
		assert.equal(v2Audit.actorSubject, ownerSubject);

		// Changes between pages cannot splice current parent or standalone values
		// into the earlier REPEATABLE READ snapshot.
		const bulk = Array.from({ length: 501 }, () =>
			task({
				title: 'before-snapshot',
				dueAt: new Date('2030-01-01T00:00:00.000Z')
			})
		);
		await runtime.salesTask.createMany({ data: bulk });
		const visible = await runtime.salesTask.findMany({
			where: {
				workspaceId,
				OR: [{ dealId: null }, { deal: { is: { archivedAt: null } } }]
			},
			orderBy: { id: 'asc' },
			select: { id: true }
		});
		const last = visible.at(-1).id;
		await runtime.salesTask.update({
			where: { id: last },
			data: {
				dealId: parentIds[0],
				status: 'COMPLETED',
				completedAt: date,
				title: 'before-snapshot'
			}
		});
		let modifiedTask = false;
		taskPageHook = async (_tx, args, result) => {
			if (!modifiedTask && result.length === 500) {
				modifiedTask = true;
				assert.equal(args.where.AND.length, 1);
				assert.ok(result.every(row => row.id !== last));
				await runtime.salesTask.update({
					where: { id: last },
					data: { title: 'after-snapshot' }
				});
				await runtime.deal.update({
					where: { id: parentIds[0] },
					data: { teamId: otherTeamId }
				});
			}
		};
		const frozen = JSON.parse((await download()).body);
		taskPageHook = null;
		assert.equal(modifiedTask, true);
		assert.equal(frozen.rowCount, 507);
		assert.equal(
			frozen.items.find(row => row.id === last).title,
			'before-snapshot'
		);
		assert.equal(frozen.items.find(row => row.id === last).teamId, teamId);
		assert.equal(
			(await runtime.salesTask.findUniqueOrThrow({ where: { id: last } }))
				.title,
			'after-snapshot'
		);
		const auditBefore = await runtime.exportAudit.count({
			where: { workspaceId }
		});
		authCalls = 0;
		authHook = () => {
			if (authCalls === 2)
				context = { ...context, subject: 'changed-session-actor' };
		};
		await assert.rejects(download(), http(403));
		assert.equal(
			await runtime.exportAudit.count({ where: { workspaceId } }),
			auditBefore
		);
		authHook = null;
		context = { ...context, subject: ownerSubject, role: 'CRM_ADMIN' };
		await assert.rejects(download(), http(403));
		assert.equal(
			await runtime.exportAudit.count({ where: { workspaceId } }),
			auditBefore
		);
		console.log(
			'Sales task export v2 PG18: mixed standalone/live-parent OWN/TEAM/ALL, archived/foreign exclusion, effective team, nullable membership, all statuses/dates, v1 compatibility, page snapshot and fresh owner authority passed'
		);
	} finally {
		context = savedContext;
		taskPageHook = null;
		authHook = null;
	}
}
