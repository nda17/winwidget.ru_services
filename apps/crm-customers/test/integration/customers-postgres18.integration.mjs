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
	await companyV2Proof(
		runtime,
		service,
		failure,
		context,
		workspaceIds[2]
	);
	console.log(
		'CRM Customers PostgreSQL 18 CRUD v1/v2, nullable requisites, replay, CAS, tenant/team scope, FK, rollback and append-only grants passed'
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

async function companyV2Proof(
	runtime,
	service,
	failure,
	context,
	rollbackWorkspace
) {
	const fields = {
		legalName: 'Полное наименование',
		kpp: '123456789',
		ogrn: '1234567890123',
		legalAddress: 'г. Москва, тестовый адрес',
		entityType: 'LEGAL'
	};
	const create = command(context.workspaceId, {
		schemaVersion: 2,
		name: 'Requisites proof',
		inn: '1234567890',
		...fields
	});
	const first = await service.create('company', context, create);
	assert.equal(first.schemaVersion, 2);
	for (const [key, value] of Object.entries(fields))
		assert.equal(first.company[key], value);
	assert.deepEqual(
		await service.create('company', context, create),
		first
	);
	const stored = await runtime.company.findUnique({
		where: { id: first.company.id }
	});
	for (const [key, value] of Object.entries(fields))
		assert.equal(stored[key], value);
	assert.deepEqual(
		(
			await runtime.customerCommand.findUnique({
				where: { commandId: create.commandId }
			})
		).response,
		first
	);
	assert.equal(
		await runtime.customerActivity.count({
			where: { commandId: create.commandId }
		}),
		1
	);
	await assert.rejects(
		service.create('company', context, { ...create, schemaVersion: 1 }),
		http(409)
	);
	const oldView = await service.get(
		'company',
		context,
		first.company.id,
		context.workspaceId
	);
	assert.equal(oldView.schemaVersion, 1);
	for (const key of Object.keys(fields))
		assert.equal(Object.hasOwn(oldView.company, key), false);
	assert.equal(
		(
			await service.get(
				'company',
				{ ...context, state: 'READ_ONLY' },
				first.company.id,
				context.workspaceId,
				2
			)
		).company.legalName,
		fields.legalName
	);
	await assert.rejects(
		service.get(
			'company',
			{ ...context, subject: 'other', dataScope: 'OWN' },
			first.company.id,
			context.workspaceId,
			2
		),
		http(404)
	);
	await assert.rejects(
		service.update(
			'company',
			{ ...context, state: 'READ_ONLY' },
			first.company.id,
			{ ...create, commandId: randomUUID(), expectedVersion: 1 }
		),
		http(403)
	);

	// Duplicate INN remains an explicit operator choice: no merge or deletion.
	const duplicate = await service.create('company', context, {
		...create,
		commandId: randomUUID()
	});
	assert.notEqual(duplicate.company.id, first.company.id);
	assert.equal(
		await runtime.company.count({
			where: { workspaceId: context.workspaceId, inn: create.inn }
		}),
		2
	);
	const page = await service.list(
		'company',
		context,
		{
			workspaceId: context.workspaceId,
			page: 2,
			pageSize: 1,
			search: 'Requisites proof'
		},
		2
	);
	assert.equal(page.schemaVersion, 2);
	assert.equal(page.total, 2);
	assert.equal(page.items.length, 1);
	for (const [key, value] of Object.entries(fields))
		assert.equal(page.items[0][key], value);

	const base = { name: 'Requisites proof edited', inn: create.inn };
	let legacyEdit;
	for (const schemaVersion of [2, 1]) {
		const edit = {
			...command(context.workspaceId, base),
			schemaVersion,
			expectedVersion: schemaVersion === 2 ? 1 : 2
		};
		const updated = await service.update(
			'company',
			context,
			first.company.id,
			edit
		);
		if (schemaVersion === 1)
			legacyEdit = { command: edit, response: updated };
		assert.equal(updated.schemaVersion, schemaVersion);
		const current = await runtime.company.findUnique({
			where: { id: first.company.id }
		});
		for (const [key, value] of Object.entries(fields))
			assert.equal(current[key], value);
		if (schemaVersion === 1)
			for (const key of Object.keys(fields))
				assert.equal(Object.hasOwn(updated.company, key), false);
	}
	const beforeFailure = await runtime.company.findUnique({
		where: { id: first.company.id }
	});
	const failing = {
		...command(context.workspaceId, base),
		schemaVersion: 2,
		expectedVersion: 3,
		legalName: 'Must roll back',
		kpp: null
	};
	const activityCount = await runtime.customerActivity.count({
		where: { workspaceId: context.workspaceId, entityId: first.company.id }
	});
	await assert.rejects(
		failure.update('company', context, first.company.id, failing),
		/forced receipt failure/
	);
	assert.deepEqual(
		await runtime.company.findUnique({ where: { id: first.company.id } }),
		beforeFailure
	);
	assert.equal(
		await runtime.customerCommand.count({
			where: { commandId: failing.commandId }
		}),
		0
	);
	assert.equal(
		await runtime.customerActivity.count({
			where: {
				workspaceId: context.workspaceId,
				entityId: first.company.id
			}
		}),
		activityCount
	);
	const failingCreate = {
		...command(rollbackWorkspace, base),
		schemaVersion: 2,
		...fields
	};
	await assert.rejects(
		failure.create('company', access(rollbackWorkspace), failingCreate),
		/forced receipt failure/
	);
	for (const delegate of [
		'company',
		'customerCommand',
		'customerActivity'
	])
		assert.equal(
			await runtime[delegate].count({
				where: { workspaceId: rollbackWorkspace }
			}),
			0
		);

	const clear = {
		...command(context.workspaceId, base),
		schemaVersion: 2,
		expectedVersion: 3,
		legalName: null,
		legalAddress: null,
		kpp: null,
		entityType: null
	};
	const cleared = await service.update(
		'company',
		context,
		first.company.id,
		clear
	);
	assert.equal(cleared.company.version, 4);
	for (const key of ['legalName', 'legalAddress', 'kpp', 'entityType'])
		assert.equal(cleared.company[key], null);
	assert.equal(cleared.company.ogrn, fields.ogrn);
	const competing = await Promise.allSettled(
		['987654321', '111111111'].map(kpp =>
			service.update('company', context, first.company.id, {
				...command(context.workspaceId, base),
				schemaVersion: 2,
				expectedVersion: 4,
				kpp
			})
		)
	);
	assert.equal(
		competing.filter(result => result.status === 'fulfilled').length,
		1
	);
	assert.equal(
		competing.filter(
			result => result.status === 'rejected' && http(409)(result.reason)
		).length,
		1
	);
	assert.equal(
		(await runtime.company.findUnique({ where: { id: first.company.id } }))
			.version,
		5
	);
	assert.deepEqual(
		await service.update(
			'company',
			context,
			first.company.id,
			legacyEdit.command
		),
		legacyEdit.response
	);
	assert.deepEqual(
		await service.update('company', context, first.company.id, clear),
		cleared
	);
	const omitted = { ...clear };
	delete omitted.legalName;
	await assert.rejects(
		service.update('company', context, first.company.id, omitted),
		http(409)
	);

	// Existing table grants cover new nullable columns; invalid values are denied
	// by database constraints, without granting new tables/types/functions.
	for (const invalid of [
		{ kpp: '12345678' },
		{ ogrn: '12345678901234' },
		{ entityType: 'UNKNOWN' },
		{ legalName: 'a'.repeat(2001) },
		{ legalAddress: 'a'.repeat(2001) }
	])
		await assert.rejects(
			runtime.company.update({
				where: { id: first.company.id },
				data: invalid
			})
		);
	const empty = await service.create(
		'company',
		context,
		command(context.workspaceId, {
			schemaVersion: 2,
			name: 'Manual company without requisites'
		})
	);
	for (const key of Object.keys(fields))
		assert.equal(empty.company[key], null);
	const individual = await service.create(
		'company',
		context,
		command(context.workspaceId, {
			schemaVersion: 2,
			name: 'Manual individual',
			entityType: 'INDIVIDUAL',
			inn: '123456789012',
			ogrn: '123456789012345'
		})
	);
	assert.equal(individual.company.ogrn, '123456789012345');
	assert.equal(individual.company.kpp, null);

	const archivedLegacy = await service.archive(
		'company',
		context,
		first.company.id,
		{
			schemaVersion: 1,
			workspaceId: context.workspaceId,
			commandId: randomUUID(),
			expectedVersion: 5
		}
	);
	assert.equal(archivedLegacy.schemaVersion, 1);
	for (const key of Object.keys(fields))
		assert.equal(Object.hasOwn(archivedLegacy.company, key), false);
	assert.equal(
		(await runtime.company.findUnique({ where: { id: first.company.id } }))
			.ogrn,
		fields.ogrn
	);
	const archiveV2 = {
		schemaVersion: 2,
		workspaceId: context.workspaceId,
		commandId: randomUUID(),
		expectedVersion: 1
	};
	const archivedV2 = await service.archive(
		'company',
		context,
		duplicate.company.id,
		archiveV2
	);
	assert.equal(archivedV2.schemaVersion, 2);
	assert.equal(archivedV2.company.legalName, fields.legalName);
	assert.deepEqual(
		await service.archive(
			'company',
			context,
			duplicate.company.id,
			archiveV2
		),
		archivedV2
	);
	const activity = await service.activities(
		'company',
		context,
		first.company.id,
		{ workspaceId: context.workspaceId, page: 1, pageSize: 100 },
		2
	);
	assert.equal(activity.schemaVersion, 2);
	assert.ok(
		activity.items.some(item => item.changedFields.includes('legalName'))
	);
	assert.ok(
		activity.items.every(
			item => !('legalName' in item) && !('legalAddress' in item)
		)
	);
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
