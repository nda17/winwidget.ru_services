import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';

const runtimeUrl = required('CRM_CUSTOMERS_TEST_DATABASE_URL');
const migrationUrl = required('CRM_CUSTOMERS_TEST_MIGRATION_DATABASE_URL');
const runtimeRole = required('CRM_CUSTOMERS_TEST_RUNTIME_ROLE');
assert.equal(process.env.CRM_CUSTOMERS_INTEGRATION_ALLOW_MUTATION, 'true');
assert.equal(local(runtimeUrl), local(migrationUrl));
assert.match(runtimeRole, /^[a-z][a-z0-9_]{0,62}$/);
const { PrismaClient } = await import('@prisma/crm-customers-client');
const { ContactIntakeOperationService } =
	await import('../../dist/src/intake-operations/intake-operation.service.js');
const { operationHash } =
	await import('../../dist/src/intake-operations/intake-operation.dto.js');
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const workspaceId = randomUUID();
let allowed = true;
let scope = 'ALL';
let role = 'OWNER';
const access = {
	authorizeWorkflow: async (workspace, subject) => {
		if (!allowed) throw new ForbiddenException();
		return {
			schemaVersion: 1,
			workspaceId: workspace,
			subject,
			role,
			state: 'ACTIVE',
			dataScope: scope,
			teamIds: [],
			permissions: ['customers:read', 'customers:write']
		};
	}
};
const service = new ContactIntakeOperationService(runtime, access);
const command = (
	payload = {
		mode: 'CREATE',
		name: 'Intake PG test',
		phone: null,
		email: null,
		teamId: null
	}
) => ({
	schemaVersion: 1,
	workspaceId,
	workflowId: randomUUID(),
	operationId: randomUUID(),
	actorSubject: 'workflow-owner',
	payloadHash: operationHash(payload),
	commandId: randomUUID(),
	payload
});
const binding = ({ payload, commandId, ...value }) => value;
const status = code => error => error?.getStatus?.() === code;
try {
	const [version] = await runtime.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::int AS value"
	);
	assert.equal(Math.floor(version.value / 10000), 18);
	const [dbRole] = await runtime.$queryRawUnsafe(
		'SELECT current_user AS name, NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname=current_user'
	);
	assert.equal(dbRole.name, runtimeRole);
	assert.equal(dbRole.restricted, true);
	for (const table of [
		'intake_operation_slots',
		'intake_operation_commands'
	])
		for (const verb of ['UPDATE', 'DELETE'])
			await assert.rejects(
				() =>
					runtime.$executeRawUnsafe(
						verb === 'UPDATE'
							? `UPDATE crm_customers.${table} SET workspace_id=workspace_id WHERE false`
							: `DELETE FROM crm_customers.${table} WHERE false`
					),
				error => error?.meta?.code === '42501'
			);
	const dto = command();
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, () => service.execute(dto))
	);
	for (const result of results)
		assert.equal(
			result.status,
			'fulfilled',
			`Concurrent execute failed with safe status ${result.reason?.getStatus?.() ?? 'database'}`
		);
	const first = results[0].value;
	for (const result of results) assert.deepEqual(result.value, first);
	assert.equal(await runtime.contact.count({ where: { workspaceId } }), 1);
	assert.equal(
		await runtime.intakeOperationCommand.count({ where: { workspaceId } }),
		1
	);
	assert.equal(
		await runtime.customerActivity.count({ where: { workspaceId } }),
		1
	);
	await assert.rejects(
		() => service.read({ ...binding(dto), actorSubject: 'other' }),
		status(409)
	);
	await assert.rejects(
		() =>
			service.execute({
				...dto,
				payload: { ...dto.payload, name: 'Changed' }
			}),
		status(400)
	);
	allowed = false;
	assert.deepEqual(await service.read(binding(dto)), first);
	await assert.rejects(() => service.execute(dto), status(403));
	await assert.rejects(() => service.verify(binding(dto)), status(403));
	allowed = true;
	await runtime.contact.update({
		where: { id: first.result.contactId },
		data: { archivedAt: new Date(), version: { increment: 1 } }
	});
	await assert.rejects(() => service.verify(binding(dto)), status(404));
	assert.deepEqual(await service.read(binding(dto)), first);
	const cancelledDto = command();
	const closed = await service.close({
		...binding(cancelledDto),
		commandId: randomUUID(),
		recoverySubject: 'admin'
	});
	assert.equal(closed.state, 'CANCELLED');
	assert.deepEqual(await service.execute(cancelledDto), closed);
	assert.equal(await runtime.contact.count({ where: { workspaceId } }), 1);
	const race = command();
	const raceResults = await Promise.allSettled([
		service.execute(race),
		service.close({
			...binding(race),
			commandId: randomUUID(),
			recoverySubject: 'admin'
		})
	]);
	for (const result of raceResults)
		assert.equal(result.status, 'fulfilled');
	assert.equal(raceResults[0].value.state, raceResults[1].value.state);
	assert.equal(
		(await service.read(binding(race))).state,
		raceResults[0].value.state
	);
	const foreign = command({ mode: 'EXISTING', contactId: randomUUID() });
	await assert.rejects(() => service.execute(foreign), status(404));
	assert.equal(
		await runtime.intakeOperationSlot.count({
			where: { operationId: foreign.operationId }
		}),
		0
	);
	assert.equal(
		await runtime.intakeOperationCommand.count({
			where: { commandId: foreign.commandId }
		}),
		0
	);
	role = 'MANAGER';
	await assert.rejects(
		() =>
			service.close({
				...binding(command()),
				commandId: randomUUID(),
				recoverySubject: 'manager'
			}),
		status(403)
	);
	console.log(
		'CRM Customers PG18 operation slots: parallel execute, close race, tombstones, binding, expiry, archived verify, rollback and append-only grants passed'
	);
} finally {
	try {
		await migrator.$transaction(async tx => {
			const where = { workspaceId };
			await tx.intakeOperationCommand.deleteMany({ where });
			await tx.intakeOperationSlot.deleteMany({ where });
			await tx.customerActivity.deleteMany({ where });
			await tx.contact.deleteMany({ where });
		});
	} finally {
		await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
	}
}
function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} required`);
	return value;
}
function local(value) {
	const url = new URL(value);
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
		!/(?:_test|_ci)$/.test(url.pathname) ||
		url.searchParams.get('schema') !== 'crm_customers'
	)
		throw new Error('Isolated loopback Customers test database required');
	return `${url.hostname}:${url.port}${url.pathname}`;
}
