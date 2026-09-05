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
	assert.match(url.pathname, /^\/winwidget_crm_intake_test[a-z0-9_]*$/);
	assert.equal(url.searchParams.get('schema'), 'crm_intake');
	return url.hostname + ':' + url.port + url.pathname;
};
const runtimeUrl = required('CRM_INTAKE_TEST_DATABASE_URL');
const migrationUrl = required('CRM_INTAKE_TEST_MIGRATION_DATABASE_URL');
const expectedRole = required('CRM_INTAKE_TEST_RUNTIME_ROLE');
assert.equal(process.env.CRM_INTAKE_INTEGRATION_ALLOW_MUTATION, 'true');
assert.equal(local(runtimeUrl), local(migrationUrl));
assert.notEqual(
	new URL(runtimeUrl).username,
	new URL(migrationUrl).username
);
assert.equal(
	decodeURIComponent(new URL(runtimeUrl).username),
	expectedRole
);
const { PrismaClient } = require('@prisma/crm-intake-client');
const {
	IntakeExportService
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
	permissions: ['intake:read', 'intake:export']
};
let authHook = null;
let authCalls = 0;
let pageHook = null;
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
									if (property !== 'inboxEntry') return current[property];
									return new Proxy(current[property], {
										get(model, method) {
											if (method !== 'findMany') return model[method];
											return async args => {
												const result = await model.findMany(args);
												if (pageHook)
													await pageHook(current, args, result);
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
const service = new IntakeExportService(proxy, authorization);
const http = status => error => error?.getStatus?.() === status;
const sqlState = code => error =>
	error?.meta?.code === code || error?.code === code;
const auditCount = () =>
	runtime.exportAudit.count({ where: { workspaceId: workspaces[0] } });
async function seed(workspaceId, count, large = false) {
	const data = Array.from({ length: count }, () => ({
		id: randomUUID(),
		workspaceId,
		title: '=Example',
		name: 'Имя',
		message: large ? 'я'.repeat(5000) : 'before',
		origin: 'MANUAL',
		createdBySubject: context.subject,
		teamId
	}));
	for (let n = 0; n < data.length; n += 500)
		await runtime.inboxEntry.createMany({ data: data.slice(n, n + 500) });
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
		"SELECT has_table_privilege(current_user,'crm_intake.export_audit','SELECT') AS read,has_table_privilege(current_user,'crm_intake.export_audit','INSERT') AS append,has_table_privilege(current_user,'crm_intake.export_audit','TRUNCATE') AS truncate"
	);
	assert.deepEqual(acl, { read: true, append: true, truncate: false });
	for (const sql of [
		'UPDATE crm_intake.export_audit SET row_count=row_count WHERE false',
		'DELETE FROM crm_intake.export_audit WHERE false',
		'SELECT * FROM foreign_service_guard.sentinel',
		'SELECT migration_name FROM crm_intake._prisma_migrations LIMIT 0'
	])
		await assert.rejects(runtime.$queryRawUnsafe(sql), sqlState('42501'));
	const ids = await seed(workspaces[0], 501);
	await seed(workspaces[1], 1);
	let modified = false;
	pageHook = async (_tx, args) => {
		if (!modified && !args.where.id) {
			modified = true;
			await runtime.inboxEntry.update({
				where: { id: ids[500] },
				data: { message: 'after' }
			});
		}
	};
	const snapshot = await service.prepare(
		'Bearer test',
		workspaces[0],
		'inbox',
		'json'
	);
	pageHook = null;
	assert.equal(snapshot.rowCount, 501);
	assert.equal(authCalls, 2);
	const items = JSON.parse(snapshot.body).items;
	assert.ok(items.every(row => row.workspaceId === workspaces[0]));
	assert.equal(items.find(row => row.id === ids[500]).message, 'before');
	assert.equal(
		(await runtime.inboxEntry.findUnique({ where: { id: ids[500] } }))
			.message,
		'after'
	);

	const csv = await service.prepare(
		'Bearer test',
		workspaces[0],
		'inbox',
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
		service.prepare('Bearer test', workspaces[0], 'inbox', 'json'),
		http(403)
	);
	assert.equal(await auditCount(), before);
	authHook = null;
	context = { ...context, role: 'OWNER' };
	context = { ...context, dataScope: 'OWN', subject: 'stranger' };
	assert.equal(
		(await service.prepare('Bearer test', workspaces[0], 'inbox', 'json'))
			.rowCount,
		0
	);
	context = { ...context, dataScope: 'TEAM', teamIds: [teamId] };
	assert.equal(
		(await service.prepare('Bearer test', workspaces[0], 'inbox', 'json'))
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
					entity: 'inbox',
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
	const auditFailure = new IntakeExportService(
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
		auditFailure.prepare('Bearer test', workspaces[0], 'inbox', 'json'),
		http(503)
	);
	assert.equal(await auditCount(), auditBefore);
	pageHook = async tx => {
		await tx.$executeRawUnsafe('SELECT pg_sleep(6)');
	};
	const began = Date.now();
	await assert.rejects(
		service.prepare('Bearer test', workspaces[0], 'inbox', 'json'),
		http(503)
	);
	pageHook = null;
	assert.ok(Date.now() - began < 5500);
	await seed(workspaces[2], 10001);
	await assert.rejects(
		service.prepare('Bearer test', workspaces[2], 'inbox', 'json'),
		http(413)
	);
	assert.equal(
		await runtime.exportAudit.count({
			where: { workspaceId: workspaces[2] }
		}),
		0
	);
	await seed(workspaces[3], 1800, true);
	await assert.rejects(
		service.prepare('Bearer test', workspaces[3], 'inbox', 'json'),
		http(413)
	);
	assert.equal(
		await runtime.exportAudit.count({
			where: { workspaceId: workspaces[3] }
		}),
		0
	);
	console.log(
		'Intake export PG18: repeatable snapshot, fresh revoke, scope, archives, row/UTF8 caps, SQL deadline, audit and restricted ACL passed'
	);
} catch (error) {
	console.error(
		'Intake export PG18 failed safely',
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
		for (const table of ['export_audit', 'inbox_entries'])
			await migrator.$executeRawUnsafe(
				'DELETE FROM crm_intake.' +
					table +
					' WHERE workspace_id = ANY($1::uuid[])',
				workspaces
			);
	} catch (error) {
		console.error(
			'Intake export test cleanup failed safely',
			JSON.stringify({ code: error?.code, sqlState: error?.meta?.code })
		);
		process.exitCode = 1;
	}
	await runtime.$disconnect();
	await migrator.$disconnect();
}
