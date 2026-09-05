import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-sales-client');
const { ForbiddenException } = require('@nestjs/common');
const {
	IntakeOperationService
} = require('../../dist/src/intake-operations/intake-operation.service.js');
const {
	operationHash,
	operationBinding
} = require('../../dist/src/intake-operations/intake-operation.dto.js');
const {
	PipelineTemplateCatalogService
} = require('../../dist/src/templates/pipeline-template-catalog.service.js');
const {
	PipelineTemplateInstallationService
} = require('../../dist/src/pipelines/pipeline-template-installation.service.js');

assert.equal(process.env.CRM_SALES_INTEGRATION_ALLOW_MUTATION, 'true');
const databaseUrl = process.env.CRM_SALES_TEST_DATABASE_URL;
const runtimeRole = process.env.CRM_SALES_TEST_RUNTIME_ROLE;
assert.ok(
	databaseUrl && runtimeRole,
	'Provide isolated integration database configuration'
);
const url = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.match(url.pathname, /^\/winwidget_crm_sales_test(?:_[a-z0-9]+)*$/);
assert.equal(decodeURIComponent(url.username), runtimeRole);
assert.equal(url.searchParams.get('schema'), 'crm_sales');
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const workspaceId = randomUUID();
const contactId = randomUUID();
let actorAllowed = true;
let contactAllowed = true;
let verifyHook = null;
let authorizationCount = 0;
let verifyCount = 0;
const client = {
	authorize: async (binding, subject = binding.actorSubject) => {
		authorizationCount += 1;
		if (!actorAllowed && subject !== 'recovery-owner')
			throw new ForbiddenException();
		return {
			schemaVersion: 1,
			workspaceId: binding.workspaceId,
			subject,
			role: subject === 'recovery-owner' ? 'OWNER' : 'MANAGER',
			state: 'ACTIVE',
			dataScope: subject === 'recovery-owner' ? 'ALL' : 'OWN',
			teamIds: [],
			permissions: ['sales:write']
		};
	},
	verifyContact: async binding => {
		verifyCount += 1;
		assert.equal(binding.workspaceId, workspaceId);
		if (!contactAllowed) throw new ForbiddenException();
		if (verifyHook) await verifyHook();
		return { contactId, contactName: 'Проверочный контакт' };
	}
};
const service = new IntakeOperationService(prisma, client);
const conflict = error => error?.status === 409;
const deniedSql = error => error?.meta?.code === '42501';
const command = (pipeline, payloadOverrides = {}) => {
	const payload = {
		title: 'Сделка из обращения',
		currency: 'RUB',
		amountMinor: 149900,
		pipelineId: pipeline.id,
		stageId: pipeline.stages.find(stage => stage.state === 'OPEN').id,
		teamId: null,
		nextTask: {
			title: 'Связаться с клиентом',
			dueAt: '2026-09-06T10:00:00.000Z'
		},
		contactOperation: {
			operationId: randomUUID(),
			payloadHash: 'a'.repeat(64)
		},
		...payloadOverrides
	};
	return {
		schemaVersion: 1,
		workspaceId,
		workflowId: randomUUID(),
		operationId: randomUUID(),
		actorSubject: 'acceptance-manager',
		payloadHash: operationHash(payload),
		commandId: randomUUID(),
		payload
	};
};
const closeCommand = request => ({
	...operationBinding(request),
	commandId: randomUUID(),
	recoverySubject: 'recovery-owner'
});
const counts = () =>
	Promise.all([
		prisma.deal.count({ where: { workspaceId } }),
		prisma.salesTask.count({ where: { workspaceId } }),
		prisma.dealTimeline.count({ where: { workspaceId } }),
		prisma.intakeOperationSlot.count({ where: { workspaceId } }),
		prisma.intakeOperationCommand.count({ where: { workspaceId } })
	]);

try {
	const [role] =
		await prisma.$queryRaw`SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
		NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AS restricted,
		pg_get_userbyid(nspowner) <> current_user AS not_owner FROM pg_roles JOIN pg_namespace ON nspname='crm_sales' WHERE rolname=current_user`;
	assert.equal(role.name, runtimeRole);
	assert.equal(role.restricted, true);
	assert.equal(role.not_owner, true);
	assert.ok(role.version >= 180000 && role.version < 190000);
	await assert.rejects(
		prisma.$queryRawUnsafe(
			'SELECT id FROM foreign_service_guard.sentinel LIMIT 1'
		),
		deniedSql
	);
	const installer = new PipelineTemplateInstallationService(
		prisma,
		new PipelineTemplateCatalogService()
	);
	const installed = await installer.install({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId,
		templateKey: 'universal-sales',
		templateVersion: 1,
		installedBySubject: 'acceptance-manager'
	});
	const pipeline = await prisma.pipeline.findUniqueOrThrow({
		where: { id: installed.installation.pipelineId },
		include: { stages: true }
	});
	const create = command(pipeline);
	console.log('Sales Intake PG18: parallel replay');
	assert.equal((await service.read(create)).state, 'ABSENT');
	const settled = await Promise.allSettled(
		Array.from({ length: 6 }, () => service.execute(create))
	);
	const rejected = settled.find(item => item.status === 'rejected');
	if (rejected) throw rejected.reason;
	const parallel = settled.map(item => item.value);
	for (const result of parallel) assert.deepEqual(result, parallel[0]);
	const proof = parallel[0];
	assert.equal(proof.state, 'COMMITTED');
	assert.equal(proof.result.contactId, contactId);
	assert.deepEqual(await counts(), [1, 1, 1, 1, 1]);
	const deal = await prisma.deal.findUniqueOrThrow({
		where: { id: proof.result.dealId }
	});
	assert.equal(deal.nextTaskId, proof.result.firstTaskId);
	assert.equal(deal.assignedToSubject, create.actorSubject);
	const verifyBefore = verifyCount;
	const authorizeBefore = authorizationCount;
	assert.deepEqual(
		await service.execute({ ...create, commandId: randomUUID() }),
		proof
	);
	assert.equal(
		verifyCount,
		verifyBefore,
		'Committed Sales proof must not revalidate/create contact'
	);
	assert.equal(
		authorizationCount,
		authorizeBefore + 1,
		'Execute replay still checks actor authority'
	);
	assert.deepEqual(
		await service.close(closeCommand(create)),
		proof,
		'Closing a committed operation cannot erase it'
	);
	await assert.rejects(
		service.read({
			...operationBinding(create),
			workspaceId: randomUUID()
		}),
		conflict
	);
	await assert.rejects(
		service.read({ ...operationBinding(create), actorSubject: 'other' }),
		conflict
	);
	await assert.rejects(
		service.read({
			...operationBinding(create),
			payloadHash: 'f'.repeat(64)
		}),
		conflict
	);
	await assert.rejects(
		service.execute({
			...create,
			payload: { ...create.payload, amountMinor: 1 }
		}),
		error => error?.status === 400
	);
	await assert.rejects(
		service.execute({ ...command(pipeline), commandId: create.commandId }),
		conflict
	);
	actorAllowed = false;
	console.log('Sales Intake PG18: revoked authority and technical proof');
	await assert.rejects(
		service.execute(create),
		error => error?.status === 403
	);
	assert.deepEqual(
		await service.read(create),
		proof,
		'Technical proof remains readable after authority revocation'
	);
	const blocked = command(pipeline);
	await assert.rejects(
		service.execute(blocked),
		error => error?.status === 403
	);
	assert.equal((await service.read(blocked)).state, 'ABSENT');
	actorAllowed = true;
	contactAllowed = false;
	await assert.rejects(
		service.execute(command(pipeline)),
		error => error?.status === 403
	);
	contactAllowed = true;
	const stopped = command(pipeline);
	await assert.rejects(
		service.close({
			...closeCommand(stopped),
			recoverySubject: 'manager'
		}),
		error => error?.status === 403
	);
	const stopProof = await service.close(closeCommand(stopped));
	assert.equal(stopProof.state, 'CANCELLED');
	assert.deepEqual(await service.execute(stopped), stopProof);
	assert.equal(await prisma.deal.count({ where: { workspaceId } }), 1);

	let reachedVerify;
	console.log('Sales Intake PG18: cancellation race');
	let releaseVerify;
	const reached = new Promise(resolve => {
		reachedVerify = resolve;
	});
	const release = new Promise(resolve => {
		releaseVerify = resolve;
	});
	verifyHook = async () => {
		reachedVerify();
		await release;
	};
	const racing = command(pipeline);
	const inFlight = service.execute(racing);
	await reached;
	const cancelled = await service.close(closeCommand(racing));
	assert.equal(cancelled.state, 'CANCELLED');
	releaseVerify();
	assert.deepEqual(
		await inFlight,
		cancelled,
		'A late in-flight write must observe the cancellation tombstone'
	);
	verifyHook = null;
	assert.equal(await prisma.deal.count({ where: { workspaceId } }), 1);

	let injectedCalls = 0;
	const inject = property => ({
		intakeOperationSlot: prisma.intakeOperationSlot,
		$transaction: (callback, options) =>
			prisma.$transaction(
				transaction =>
					callback(
						new Proxy(transaction, {
							get(target, key) {
								if (
									key === property &&
									property === 'intakeOperationCommand'
								)
									return {
										...target[key],
										create: async () => {
											injectedCalls += 1;
											throw new Error('Injected receipt failure');
										}
									};
								if (key === property && property === 'salesTask')
									return {
										...target[key],
										create: args => {
											injectedCalls += 1;
											return target[key].create({
												...args,
												data: {
													...args.data,
													status: 'COMPLETED',
													completedAt: new Date()
												}
											});
										}
									};
								const value = Reflect.get(target, key);
								return typeof value === 'function'
									? value.bind(target)
									: value;
							}
						})
					),
				options
			)
	});
	for (const property of ['intakeOperationCommand', 'salesTask']) {
		console.log('Sales Intake PG18: atomic failure injection ' + property);
		const before = await counts();
		const invalid = command(pipeline);
		injectedCalls = 0;
		await assert.rejects(
			new IntakeOperationService(inject(property), client).execute(invalid)
		);
		assert.equal(
			injectedCalls,
			1,
			'The fault must reach the intended transaction write, not fail during setup'
		);
		assert.deepEqual(
			await counts(),
			before,
			'Failed receipt/next-action invariant must roll back every owned effect'
		);
		assert.equal((await service.read(invalid)).state, 'ABSENT');
	}
	for (const table of [
		'intake_operation_slots',
		'intake_operation_commands'
	]) {
		for (const statement of [
			`UPDATE crm_sales.${table} SET workspace_id=workspace_id`,
			`DELETE FROM crm_sales.${table}`,
			`TRUNCATE crm_sales.${table}`
		]) {
			await assert.rejects(prisma.$executeRawUnsafe(statement), deniedSql);
		}
	}
	const impossible = command(pipeline);
	await assert.rejects(
		prisma.intakeOperationSlot.create({
			data: {
				operationId: impossible.operationId,
				workspaceId,
				workflowId: impossible.workflowId,
				actorSubject: impossible.actorSubject,
				payloadHash: impossible.payloadHash,
				state: 'COMMITTED',
				contactId: randomUUID(),
				dealId: proof.result.dealId,
				firstTaskId: proof.result.firstTaskId,
				committedAt: new Date()
			}
		}),
		error => error?.code === 'P2003'
	);
	const maxSubject = {
		...command(pipeline),
		actorSubject: 's'.repeat(256)
	};
	assert.equal(
		(await service.execute(maxSubject)).state,
		'COMMITTED',
		'The SQL subject constraint must support all 256 characters'
	);
	console.log(
		'CRM Sales Intake PG18: parallel replay, scoped immutable proof, cancellation race, authority revocation, rollback and append-only ACL passed'
	);
} catch (error) {
	console.error(
		'Sales Intake PG18 failed: ' +
			JSON.stringify({
				name: error?.name,
				code: error?.code,
				sqlState: error?.meta?.code,
				status: error?.status,
				message: String(error?.message || 'Unknown failure')
					.split('\n')
					.filter(Boolean)
					.at(-1)
					?.slice(0, 500)
			})
	);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
