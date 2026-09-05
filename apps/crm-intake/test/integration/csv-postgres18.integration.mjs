import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const required = name => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};
const local = value => {
	const url = new URL(value);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
	assert.match(url.pathname, /^\/winwidget_crm_intake_test[a-z0-9_]*$/);
	assert.equal(url.searchParams.get('schema'), 'crm_intake');
	return `${url.hostname}:${url.port}${url.pathname}`;
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
const { PrismaClient } = await import('@prisma/crm-intake-client');
const imported =
	await import('../../dist/src/intake/intake-csv-import.service.js');
const { IntakeCsvImportService } = imported.default || imported;
const manualImported =
	await import('../../dist/src/intake/intake.service.js');
const { IntakeService } = manualImported.default || manualImported;
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const service = new IntakeCsvImportService(runtime);
const manual = new IntakeService(runtime);
const workspaceIds = [randomUUID(), randomUUID()];
const teamId = randomUUID();
const context = {
	schemaVersion: 1,
	workspaceId: workspaceIds[0],
	subject: 'a'.repeat(256),
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['intake:read', 'intake:write']
};
const row = {
	title: ' Запрос CSV ',
	name: ' Анна ',
	phone: '+79000000001',
	email: 'ANNA@EXAMPLE.TEST',
	message: ' Текст '
};
const command = (count = 2) => ({
	schemaVersion: 1,
	workspaceId: context.workspaceId,
	commandId: randomUUID(),
	label: 'Клиенты.csv',
	teamId,
	rows: Array.from({ length: count }, (_, index) => ({
		...row,
		title: `${row.title}${index}`
	}))
});
const http = status => error => error?.getStatus?.() === status;
const sqlState = code => error =>
	error?.meta?.code === code || error?.code === code;
const tables = [
	'csv_import_rows',
	'csv_imports',
	'intake_activities',
	'intake_commands',
	'inbox_entries'
];
async function counts() {
	return Promise.all(
		tables.map(async table => {
			const [result] = await runtime.$queryRawUnsafe(
				`SELECT count(*)::integer AS count FROM crm_intake.${table} WHERE workspace_id = $1::uuid`,
				context.workspaceId
			);
			return result.count;
		})
	);
}

try {
	const [version] = await runtime.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::integer AS version"
	);
	assert.equal(Math.floor(version.version / 10000), 18);
	const [role] = await runtime.$queryRawUnsafe(
		'SELECT current_user AS name, NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname = current_user'
	);
	assert.equal(role.name, expectedRole);
	assert.equal(role.restricted, true);
	for (const table of [
		'csv_imports',
		'csv_import_rows',
		'intake_commands',
		'intake_activities'
	]) {
		const [privileges] = await runtime.$queryRawUnsafe(
			"SELECT has_table_privilege(current_user, $1, 'SELECT,INSERT') AS allowed, has_table_privilege(current_user, $1, 'TRUNCATE') AS truncate",
			`crm_intake.${table}`
		);
		assert.equal(privileges.allowed, true);
		assert.equal(privileges.truncate, false);
		await assert.rejects(
			runtime.$executeRawUnsafe(
				`UPDATE crm_intake.${table} SET workspace_id=workspace_id WHERE false`
			),
			sqlState('42501')
		);
		await assert.rejects(
			runtime.$executeRawUnsafe(
				`DELETE FROM crm_intake.${table} WHERE false`
			),
			sqlState('42501')
		);
	}
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT * FROM foreign_service_guard.sentinel'
		),
		sqlState('42501')
	);
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT migration_name FROM crm_intake._prisma_migrations LIMIT 0'
		),
		sqlState('42501')
	);

	const large = command(250);
	const started = Date.now();
	const first = await service.create(context, large);
	assert.ok(
		Date.now() - started < 5000,
		'Bounded CSV transaction exceeded its deadline'
	);
	assert.deepEqual(Object.keys(first).sort(), ['import', 'schemaVersion']);
	assert.deepEqual(Object.keys(first.import).sort(), [
		'createdAt',
		'createdBySubject',
		'id',
		'label',
		'rowCount',
		'teamId',
		'workspaceId'
	]);
	assert.equal(first.import.rowCount, 250);
	assert.equal(first.import.id, large.commandId);
	assert.deepEqual(await service.create(context, large), first);
	assert.deepEqual(await counts(), [250, 1, 250, 1, 250]);
	const entries = await runtime.inboxEntry.findMany({
		where: { workspaceId: context.workspaceId }
	});
	assert.ok(
		entries.every(
			entry =>
				entry.status === 'NEW' &&
				entry.origin === 'CSV' &&
				entry.sourceId === null &&
				entry.contactId === null &&
				entry.dealId === null &&
				entry.email === 'anna@example.test'
		)
	);
	assert.equal(
		await runtime.acceptance.count({
			where: { workspaceId: context.workspaceId }
		}),
		0
	);
	const receipt = await runtime.intakeCommand.findUnique({
		where: { commandId: large.commandId }
	});
	assert.deepEqual(receipt.response, first);
	assert.equal(
		JSON.stringify(receipt.response).includes('anna@example.test'),
		false
	);

	const parallel = command(8);
	const outcomes = await Promise.allSettled(
		Array.from({ length: 6 }, () => service.create(context, parallel))
	);
	assert.ok(
		outcomes.every(result => result.status === 'fulfilled'),
		'Parallel CSV replay failed'
	);
	assert.ok(
		outcomes.every(result => result.value.import.id === parallel.commandId)
	);
	assert.deepEqual(await counts(), [258, 2, 258, 2, 258]);
	for (const changed of [
		{ ...large, label: 'changed.csv' },
		{ ...large, rows: [...large.rows].reverse() },
		{
			...large,
			rows: large.rows.map(value => ({
				...value,
				email: value.email.toLowerCase()
			}))
		}
	])
		await assert.rejects(service.create(context, changed), http(409));
	await assert.rejects(
		service.create({ ...context, subject: 'other' }, large),
		http(409)
	);
	await assert.rejects(
		service.create(
			{ ...context, workspaceId: workspaceIds[1] },
			{ ...large, workspaceId: workspaceIds[1] }
		),
		http(409)
	);
	await assert.rejects(
		service.create({ ...context, state: 'READ_ONLY' }, large),
		http(403)
	);
	await assert.rejects(
		service.create({ ...context, role: 'ANALYST' }, command()),
		http(403)
	);
	await assert.rejects(
		service.create({ ...context, teamIds: [] }, large),
		http(403)
	);
	await assert.rejects(
		service.create(
			{ ...context, permissions: ['intake:read'] },
			command()
		),
		http(403)
	);
	assert.deepEqual(
		await service.get(
			{ ...context, state: 'READ_ONLY', dataScope: 'OWN' },
			context.workspaceId,
			large.commandId
		),
		first
	);
	await assert.rejects(
		service.get(
			{ ...context, subject: 'other', dataScope: 'OWN' },
			context.workspaceId,
			large.commandId
		),
		http(404)
	);
	assert.deepEqual(
		await service.get(
			{ ...context, subject: 'team-peer', dataScope: 'TEAM' },
			context.workspaceId,
			large.commandId
		),
		first
	);
	await assert.rejects(
		service.get(
			{ ...context, subject: 'team-peer', dataScope: 'TEAM', teamIds: [] },
			context.workspaceId,
			large.commandId
		),
		http(404)
	);
	await assert.rejects(
		service.get(
			{ ...context, workspaceId: workspaceIds[1] },
			workspaceIds[1],
			large.commandId
		),
		http(404)
	);
	const manualCommand = {
		schemaVersion: 1,
		workspaceId: context.workspaceId,
		commandId: randomUUID(),
		title: 'manual',
		name: 'manual'
	};
	await manual.createManual(context, manualCommand);
	await assert.rejects(
		service.create(context, {
			...command(),
			commandId: manualCommand.commandId
		}),
		http(409)
	);

	for (const [delegate, operation] of [
		['inboxEntry', 'createMany'],
		['intakeActivity', 'createMany'],
		['csvImportRow', 'createMany'],
		['intakeCommand', 'create']
	]) {
		const before = await counts();
		let reached = false;
		const fault = new IntakeCsvImportService(
			wrapTransaction(runtime, (tx, name) =>
				name === delegate
					? new Proxy(tx[name], {
							get(target, method) {
								if (method === operation)
									return async args => {
										await target[method](args);
										reached = true;
										throw new Error('injected after successful write');
									};
								const value = Reflect.get(target, method);
								return typeof value === 'function'
									? value.bind(target)
									: value;
							}
						})
					: tx[name]
			)
		);
		await assert.rejects(fault.create(context, command()), http(503));
		assert.equal(
			reached,
			true,
			`Fault did not reach ${delegate}.${operation}`
		);
		assert.deepEqual(
			await counts(),
			before,
			`Partial CSV records survived ${delegate}.${operation}`
		);
	}
	const beforeInvalid = await counts();
	let receiptInserted = false;
	const invalid = new IntakeCsvImportService(
		wrapTransaction(runtime, (tx, name) => {
			if (name === 'csvImport')
				return new Proxy(tx[name], {
					get(target, method) {
						if (method === 'create')
							return args =>
								target.create({
									...args,
									data: { ...args.data, rowCount: args.data.rowCount + 1 }
								});
						const value = Reflect.get(target, method);
						return typeof value === 'function'
							? value.bind(target)
							: value;
					}
				});
			if (name === 'intakeCommand')
				return new Proxy(tx[name], {
					get(target, method) {
						if (method === 'create')
							return async args => {
								const result = await target.create(args);
								receiptInserted = true;
								return result;
							};
						const value = Reflect.get(target, method);
						return typeof value === 'function'
							? value.bind(target)
							: value;
					}
				});
			return tx[name];
		})
	);
	await assert.rejects(invalid.create(context, command()), http(503));
	assert.equal(
		receiptInserted,
		true,
		'Deferred proof fault must follow real receipt insertion'
	);
	assert.deepEqual(await counts(), beforeInvalid);
	const bound = await runtime.csvImportRow.findFirst({
		where: { importId: large.commandId }
	});
	await assert.rejects(
		runtime.$executeRawUnsafe(
			'INSERT INTO crm_intake.csv_import_rows (import_id, workspace_id, row_number, entry_id, audit_command_id) VALUES ($1::uuid,$2::uuid,1,$3::uuid,$4::uuid)',
			randomUUID(),
			workspaceIds[1],
			bound.entryId,
			randomUUID()
		),
		sqlState('23503')
	);
	console.log(
		'CSV PostgreSQL 18: atomic 250-row bulk, 6 concurrent replays, exact actor/workspace/input binding, read-only/team scope, namespace collision, reached-write rollback, deferred proof failure, FK and append-only grants passed'
	);
} finally {
	await migrator.$transaction(async tx => {
		for (const table of tables)
			await tx.$executeRawUnsafe(
				`DELETE FROM crm_intake.${table} WHERE workspace_id = ANY($1::uuid[])`,
				workspaceIds
			);
	});
	await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
}

function wrapTransaction(database, delegate) {
	return new Proxy(database, {
		get(target, property) {
			if (property === '$transaction')
				return (callback, options) =>
					target.$transaction(
						tx =>
							callback(
								new Proxy(tx, {
									get(inner, name) {
										const value = delegate(inner, name);
										return typeof value === 'function'
											? value.bind(inner)
											: value;
									}
								})
							),
						options
					);
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}
