import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const runtimeUrl = required('CRM_CUSTOMERS_TEST_DATABASE_URL');
const migrationUrl = required('CRM_CUSTOMERS_TEST_MIGRATION_DATABASE_URL');
const runtimeRole = required('CRM_CUSTOMERS_TEST_RUNTIME_ROLE');
if (process.env.CRM_CUSTOMERS_INTEGRATION_ALLOW_MUTATION !== 'true')
	throw new Error(
		'Explicit CRM_CUSTOMERS_INTEGRATION_ALLOW_MUTATION=true is required'
	);
assert.equal(
	assertLocal(runtimeUrl),
	assertLocal(migrationUrl),
	'Runtime and migration URLs must point to the same local test database'
);
assert.match(runtimeRole, /^[a-z][a-z0-9_]{0,62}$/);

const migration =
	process.env.CRM_CUSTOMERS_TEST_SKIP_MIGRATIONS === 'true'
		? null
		: spawnSync('pnpm', ['prisma:migrate:deploy'], {
				cwd: new URL('../../', import.meta.url),
				env: { ...process.env, CRM_CUSTOMERS_DATABASE_URL: migrationUrl },
				encoding: 'utf8',
				timeout: 120_000
			});
if (migration && migration.status !== 0)
	throw new Error(
		'CRM Customers test migration failed; inspect the isolated database without printing credentials'
	);

const { PrismaClient } = await import('@prisma/crm-customers-client');
const serviceModule =
	await import('../../dist/src/customers/customers.service.js');
const CustomersService =
	serviceModule.CustomersService || serviceModule.default.CustomersService;
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const service = new CustomersService(runtime);
const workspaceIds = Array.from({ length: 3 }, () => randomUUID());
const context = access(workspaceIds[0]);
const teamId = randomUUID();

try {
	const [version] = await runtime.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::integer AS version"
	);
	assert.equal(
		Math.floor(version.version / 10000),
		18,
		'PostgreSQL 18 is required'
	);
	const [role] = await runtime.$queryRawUnsafe(
		`SELECT current_user AS name, NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname = current_user`
	);
	assert.equal(role.name, runtimeRole);
	assert.equal(role.restricted, true);
	for (const table of ['customer_commands', 'customer_activities']) {
		await denied(() =>
			runtime.$executeRawUnsafe(
				`UPDATE crm_customers.${table} SET workspace_id=workspace_id WHERE false`
			)
		);
		await denied(() =>
			runtime.$executeRawUnsafe(
				`DELETE FROM crm_customers.${table} WHERE false`
			)
		);
	}
	for (const table of ['contacts', 'companies'])
		await denied(() =>
			runtime.$executeRawUnsafe(
				`DELETE FROM crm_customers.${table} WHERE false`
			)
		);
	await denied(() =>
		runtime.$queryRawUnsafe(
			'SELECT migration_name FROM crm_customers._prisma_migrations LIMIT 0'
		)
	);
	await denied(() =>
		runtime.$executeRawUnsafe(
			'UPDATE crm_customers.service_identity SET service_name=service_name WHERE false'
		)
	);

	const company = await service.create(
		'company',
		context,
		command(context.workspaceId, { name: 'Тестовая компания' })
	);
	const create = command(context.workspaceId, {
		name: 'Тестовый контакт',
		phone: '+79000000001',
		email: 'CLIENT@EXAMPLE.TEST',
		companyId: company.company.id
	});
	const first = await service.create('contact', context, create);
	assert.equal(first.contact.email, 'client@example.test');
	assert.deepEqual(
		await service.create('contact', context, create),
		first
	);
	assert.equal(
		await runtime.customerActivity.count({
			where: { commandId: create.commandId }
		}),
		1
	);
	assert.equal(
		await runtime.customerCommand.count({
			where: { commandId: create.commandId }
		}),
		1
	);
	await assert.rejects(
		service.create('contact', context, { ...create, name: 'Другое имя' }),
		http(409)
	);
	await assert.rejects(
		service.create(
			'contact',
			{ ...context, subject: 'another-subject' },
			create
		),
		http(409)
	);
	await assert.rejects(
		service.get(
			'contact',
			access(workspaceIds[1]),
			first.contact.id,
			workspaceIds[1]
		),
		http(404)
	);
	await assert.rejects(
		service.get(
			'contact',
			{ ...context, subject: 'other', dataScope: 'OWN' },
			first.contact.id,
			context.workspaceId
		),
		http(404)
	);
	await assert.rejects(
		service.create(
			'contact',
			{ ...context, state: 'READ_ONLY' },
			command(context.workspaceId)
		),
		http(403)
	);
	assert.equal(
		(
			await service.get(
				'contact',
				{ ...context, state: 'READ_ONLY' },
				first.contact.id,
				context.workspaceId
			)
		).contact.id,
		first.contact.id
	);

	const concurrent = command(context.workspaceId, {
		name: 'Конкурентная команда'
	});
	const results = await Promise.all([
		service.create('contact', context, concurrent),
		service.create('contact', context, concurrent)
	]);
	assert.deepEqual(results[0], results[1]);
	assert.equal(
		await runtime.customerActivity.count({
			where: { commandId: concurrent.commandId }
		}),
		1
	);
	const edits = await Promise.allSettled([
		service.update('contact', context, first.contact.id, {
			...command(context.workspaceId, {
				name: 'Первое изменение',
				companyId: company.company.id
			}),
			expectedVersion: 1
		}),
		service.update('contact', context, first.contact.id, {
			...command(context.workspaceId, {
				name: 'Второе изменение',
				companyId: company.company.id
			}),
			expectedVersion: 1
		})
	]);
	assert.equal(
		edits.filter(result => result.status === 'fulfilled').length,
		1
	);
	assert.equal(
		edits.filter(
			result => result.status === 'rejected' && http(409)(result.reason)
		).length,
		1
	);
	assert.equal(
		(
			await service.get(
				'contact',
				context,
				first.contact.id,
				context.workspaceId
			)
		).contact.version,
		2
	);
	await assert.rejects(
		service.archive('company', context, company.company.id, {
			...command(context.workspaceId),
			expectedVersion: 1
		}),
		http(409)
	);

	const teamContext = {
		...context,
		subject: 'team-member',
		teamIds: [teamId],
		dataScope: 'TEAM'
	};
	const teamRecord = await service.create(
		'contact',
		teamContext,
		command(context.workspaceId, {
			name: 'Контакт команды',
			teamId,
			phone: '+79000000009'
		})
	);
	const leadContext = { ...teamContext, subject: 'team-lead' };
	assert.equal(
		(
			await service.get(
				'contact',
				leadContext,
				teamRecord.contact.id,
				context.workspaceId
			)
		).contact.id,
		teamRecord.contact.id
	);
	await assert.rejects(
		service.get(
			'contact',
			{ ...leadContext, teamIds: [] },
			teamRecord.contact.id,
			context.workspaceId
		),
		http(404)
	);
	const ownList = await service.list(
		'contact',
		{ ...context, dataScope: 'OWN' },
		{ workspaceId: context.workspaceId, page: 1, pageSize: 1 }
	);
	assert.equal(ownList.items.length, 1);
	assert.equal(ownList.total, 2);
	const duplicates = await service.duplicates(leadContext, {
		workspaceId: context.workspaceId,
		phone: '+79000000009',
		page: 1,
		pageSize: 25
	});
	assert.equal(duplicates.total, 1);
	assert.equal(
		(
			await service.duplicates(
				{ ...context, dataScope: 'OWN' },
				{
					workspaceId: context.workspaceId,
					phone: '+79000000009',
					page: 1,
					pageSize: 25
				}
			)
		).total,
		0
	);

	const foreignCompany = await service.create(
		'company',
		access(workspaceIds[1]),
		command(workspaceIds[1], { name: 'Другая компания' })
	);
	await assert.rejects(
		service.create(
			'contact',
			context,
			command(context.workspaceId, {
				companyId: foreignCompany.company.id
			})
		),
		http(404)
	);
	await assert.rejects(
		runtime.contact.create({
			data: {
				workspaceId: context.workspaceId,
				name: 'FK guard',
				createdBySubject: 'owner',
				companyId: foreignCompany.company.id
			}
		}),
		error => error?.code === 'P2003'
	);

	const failure = new CustomersService(
		new Proxy(runtime, {
			get(target, property) {
				if (property === '$transaction')
					return (callback, options) =>
						target.$transaction(
							tx =>
								callback(
									new Proxy(tx, {
										get(transaction, key) {
											if (key === 'customerCommand')
												return {
													...transaction.customerCommand,
													create: async () => {
														throw new Error('forced receipt failure');
													}
												};
											const value = Reflect.get(transaction, key);
											return typeof value === 'function'
												? value.bind(transaction)
												: value;
										}
									})
								),
							options
						);
				const value = Reflect.get(target, property);
				return typeof value === 'function' ? value.bind(target) : value;
			}
		})
	);
	await assert.rejects(
		failure.create(
			'contact',
			access(workspaceIds[2]),
			command(workspaceIds[2])
		),
		/forced receipt failure/
	);
	for (const delegate of [
		'contact',
		'customerCommand',
		'customerActivity'
	])
		assert.equal(
			await runtime[delegate].count({
				where: { workspaceId: workspaceIds[2] }
			}),
			0
		);

	const archive = {
		schemaVersion: 1,
		workspaceId: context.workspaceId,
		commandId: randomUUID(),
		expectedVersion: 2
	};
	const archived = await service.archive(
		'contact',
		context,
		first.contact.id,
		archive
	);
	assert.equal(archived.contact.version, 3);
	assert.ok(archived.contact.archivedAt);
	assert.deepEqual(
		await service.archive('contact', context, first.contact.id, archive),
		archived
	);
	await assert.rejects(
		service.get('contact', context, first.contact.id, context.workspaceId),
		http(404)
	);
	const activity = await service.activities(
		'contact',
		context,
		first.contact.id,
		{ workspaceId: context.workspaceId, page: 1, pageSize: 25 }
	);
	assert.equal(activity.total, 3);
	assert.ok(
		activity.items.every(item => !('phone' in item) && !('email' in item))
	);
	console.log(
		'CRM Customers PostgreSQL 18 CRUD, replay, CAS, tenant/team scope, FK, rollback and append-only grants passed'
	);
} finally {
	try {
		await migrator.$transaction(async tx => {
			const where = { workspaceId: { in: workspaceIds } };
			await tx.customerActivity.deleteMany({ where });
			await tx.customerCommand.deleteMany({ where });
			await tx.contact.deleteMany({ where });
			await tx.company.deleteMany({ where });
		});
	} finally {
		await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
	}
}

function access(workspaceId) {
	return {
		schemaVersion: 1,
		workspaceId,
		subject: 'owner',
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: [],
		permissions: ['customers:read', 'customers:write']
	};
}
function command(workspaceId, overrides = {}) {
	return {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId,
		name: 'Тестовый контакт',
		...overrides
	};
}
function http(status) {
	return error => error?.getStatus?.() === status;
}
async function denied(callback) {
	await assert.rejects(
		callback,
		error => error?.meta?.code === '42501' || error?.code === '42501'
	);
}
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function assertLocal(value) {
	const parsed = new URL(value);
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
		!/(?:_test|_ci)$/.test(parsed.pathname) ||
		parsed.searchParams.get('schema') !== 'crm_customers'
	)
		throw new Error(
			'CRM Customers integration requires an isolated loopback test/CI database with crm_customers schema'
		);
	return `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
}
