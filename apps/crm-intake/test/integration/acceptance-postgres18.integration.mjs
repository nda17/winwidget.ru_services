import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';

// This suite uses a real service-owned PostgreSQL database and fault-injected downstream boundaries.
// Customers/Sales own PG suites independently verify their immutable operation slots. HTTP end-to-end is a separate stack gate.
assert.equal(process.env.CRM_INTAKE_INTEGRATION_ALLOW_MUTATION, 'true');
const runtimeUrl = required('CRM_INTAKE_TEST_DATABASE_URL');
const migrationUrl = required('CRM_INTAKE_TEST_MIGRATION_DATABASE_URL');
const runtimeRole = required('CRM_INTAKE_TEST_RUNTIME_ROLE');
assert.equal(local(runtimeUrl), local(migrationUrl));
const { PrismaClient } = await import('@prisma/crm-intake-client');
const { AcceptanceService } =
	await import('../../dist/src/acceptance/acceptance.service.js');
const { AcceptanceProcessor, ACCEPTANCE_CONSUMER } =
	await import('../../dist/src/acceptance/acceptance.processor.js');
const { AcceptancePublisher } =
	await import('../../dist/src/acceptance/acceptance.publisher.js');
const { AcceptanceWorker } =
	await import('../../dist/src/acceptance/acceptance.worker.js');
const {
	AcceptanceRabbit,
	ACCEPTANCE_EXCHANGE,
	ACCEPTANCE_QUEUE,
	ACCEPTANCE_EVENT_TYPE,
	ACCEPTANCE_DEAD_QUEUE
} = await import('../../dist/src/acceptance/acceptance.messaging.js');
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const migrator = new PrismaClient({
	datasources: { db: { url: migrationUrl } }
});
const workspaceId = randomUUID();
const context = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:read', 'intake:write']
};
let allowed = true;
let loseSalesResponse = false;
let blockAfterContact = false;
let failSales = false;
const slots = new Map();
const writes = { customers: 0, sales: 0 };
const access = {
	authorizeWorkflow: async (_workspace, subject) => {
		if (!allowed && subject !== 'recovery-owner')
			throw new ForbiddenException();
		return { ...context, subject };
	}
};
const operations = {
	request: async (target, action, binding, command) => {
		const prior = slots.get(binding.operationId);
		if (prior)
			for (const [key, value] of Object.entries(binding))
				assert.equal(prior[key], value);
		if (action === 'read')
			return (
				prior ?? {
					...binding,
					state: 'ABSENT',
					result: null,
					committedAt: null
				}
			);
		await access.authorizeWorkflow(
			binding.workspaceId,
			command.recoverySubject ?? binding.actorSubject
		);
		if (prior) return prior;
		if (action === 'close') {
			const proof = {
				...binding,
				state: 'CANCELLED',
				result: null,
				committedAt: null
			};
			slots.set(binding.operationId, proof);
			return proof;
		}
		if (target === 'sales' && failSales)
			throw new ServiceUnavailableException();
		const result =
			target === 'customers'
				? {
						contactId: randomUUID(),
						contactName: 'PG workflow contact',
						contactVersion: 1
					}
				: {
						contactId: slots.get(
							command.payload.contactOperation.operationId
						).result.contactId,
						dealId: randomUUID(),
						firstTaskId: randomUUID()
					};
		const proof = {
			...binding,
			state: 'COMMITTED',
			result,
			committedAt: new Date().toISOString()
		};
		slots.set(binding.operationId, proof);
		writes[target]++;
		if (target === 'customers' && blockAfterContact) allowed = false;
		if (target === 'sales' && loseSalesResponse) {
			loseSalesResponse = false;
			throw new ServiceUnavailableException();
		}
		return proof;
	}
};
const service = new AcceptanceService(runtime);
const processor = new AcceptanceProcessor(runtime, access, operations);
let rabbit;
let worker;
let publisher;
let inspector;
let inspectorChannel;
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
		'acceptances',
		'acceptance_outbox',
		'acceptance_receipts'
	])
		await assert.rejects(
			() =>
				runtime.$executeRawUnsafe(
					`DELETE FROM crm_intake.${table} WHERE false`
				),
			error => error?.meta?.code === '42501'
		);
	const first = await intent();
	assert.equal(
		await runtime.acceptanceOutbox.count({
			where: { eventId: first.event.eventId }
		}),
		1
	);
	assert.deepEqual(
		await service.accept(context, first.entry.id, first.dto),
		first.response
	);
	await assert.rejects(
		() =>
			service.accept(context, first.entry.id, {
				...first.dto,
				commandId: randomUUID()
			}),
		status(409)
	);
	const claims = await Promise.allSettled([
		processor.claim(first.event, 0),
		processor.claim(first.event, 0)
	]);
	for (const item of claims) assert.equal(item.status, 'fulfilled');
	assert.equal(
		claims.filter(item => item.value.state === 'CLAIMED').length,
		1
	);
	const claim = claims.find(item => item.value.state === 'CLAIMED').value;
	await processor.run(first.event, claim.token);
	assert.equal(
		(
			await runtime.inboxEntry.findUnique({
				where: { id: first.entry.id }
			})
		).status,
		'ACCEPTED'
	);
	assert.equal((await processor.claim(first.event, 0)).state, 'DONE');
	assert.equal(writes.customers, 1);
	assert.equal(writes.sales, 1);
	await assert.rejects(
		() =>
			service.get(
				{ ...context, workspaceId: randomUUID() },
				first.entry.id,
				workspaceId
			),
		status(403)
	);
	await assert.rejects(
		() =>
			service.accept(
				{ ...context, state: 'READ_ONLY' },
				first.entry.id,
				first.dto
			),
		status(403)
	);

	// Crash after Sales committed but before a successful HTTP response: retry proves the already committed outcome even after expiry.
	const crash = await intent();
	loseSalesResponse = true;
	const crashClaim = await processor.claim(crash.event, 0);
	await assert.rejects(
		() => processor.run(crash.event, crashClaim.token),
		status(503)
	);
	assert.equal(
		(
			await runtime.inboxEntry.findUnique({
				where: { id: crash.entry.id }
			})
		).status,
		'NEW'
	);
	await runtime.acceptanceReceipt.update({
		where: {
			eventId_consumer: {
				eventId: crash.event.eventId,
				consumer: ACCEPTANCE_CONSUMER
			}
		},
		data: { leaseUntil: new Date(0) }
	});
	allowed = false;
	const afterCrash = await processor.claim(crash.event, 0);
	assert.equal(afterCrash.state, 'CLAIMED');
	const countBefore = { ...writes };
	await processor.run(crash.event, afterCrash.token);
	assert.deepEqual(writes, countBefore);
	assert.equal(
		(
			await runtime.inboxEntry.findUnique({
				where: { id: crash.entry.id }
			})
		).status,
		'ACCEPTED'
	);
	allowed = true;

	// A partial contact does not authorize a Sales write. Admin recovery closes Sales before Customers, retains the contact, and permits reviewed restart.
	const partial = await intent();
	blockAfterContact = true;
	const partialClaim = await processor.claim(partial.event, 0);
	await assert.rejects(
		() => processor.run(partial.event, partialClaim.token),
		status(403)
	);
	await processor.fail(
		partial.event,
		partialClaim.token,
		0,
		new ForbiddenException()
	);
	let row = await runtime.acceptance.findUnique({
		where: { id: partial.response.acceptance.id }
	});
	assert.equal(row.status, 'BLOCKED');
	assert.ok(row.contactId);
	assert.equal(row.dealId, null);
	blockAfterContact = false;
	allowed = true;
	await assert.rejects(
		() =>
			service.retry(
				{ ...context, role: 'MANAGER' },
				partial.entry.id,
				command(row.version),
				true
			),
		status(403)
	);
	const recoveryCommand = command(row.version);
	const recovery = await service.retry(
		{ ...context, subject: 'recovery-owner' },
		partial.entry.id,
		recoveryCommand,
		true
	);
	const recoveryEvent = await initialEvent(recovery.acceptance.id, 2);
	const recoveryClaim = await processor.claim(recoveryEvent, 0);
	await processor.run(recoveryEvent, recoveryClaim.token);
	row = await runtime.acceptance.findUnique({ where: { id: row.id } });
	assert.equal(row.status, 'CANCELLED');
	assert.ok(row.contactId);
	assert.equal(slots.get(row.salesOperationId).state, 'CANCELLED');
	assert.equal(slots.get(row.contactOperationId).state, 'COMMITTED');
	assert.equal((await processor.claim(partial.event, 0)).state, 'DONE');
	const currentEntry = await runtime.inboxEntry.findUnique({
		where: { id: partial.entry.id }
	});
	await service.accept(context, partial.entry.id, {
		...partial.dto,
		...command(currentEntry.version),
		contact: { mode: 'EXISTING', contactId: row.contactId }
	});
	assert.equal(
		await runtime.acceptance.count({
			where: { workspaceId, entryId: partial.entry.id }
		}),
		2
	);

	// Failure state and retry Outbox commit together; an old lease cannot acknowledge new ownership.
	const retry = await intent();
	failSales = true;
	const retryClaim = await processor.claim(retry.event, 0);
	await assert.rejects(
		() => processor.run(retry.event, retryClaim.token),
		status(503)
	);

	// A fault after the actual Outbox INSERT must roll back receipt and workflow/source together.
	let retryInsertReached = false;
	const faultPrisma = new Proxy(runtime, {
		get(target, key) {
			if (key !== '$transaction') return target[key];
			return (callback, options) =>
				target.$transaction(
					tx =>
						callback(
							new Proxy(tx, {
								get(current, property) {
									if (property !== 'acceptanceOutbox')
										return current[property];
									return new Proxy(current[property], {
										get(delegate, operation) {
											if (operation !== 'createMany')
												return delegate[operation];
											return async args => {
												await delegate.createMany(args);
												retryInsertReached = true;
												throw new Error('INJECTED_RETRY_AFTER_INSERT');
											};
										}
									});
								}
							})
						),
					options
				);
		}
	});
	const failureSnapshot = await runtime.acceptanceReceipt.findFirst({
		where: { eventId: retry.event.eventId }
	});
	await assert.rejects(
		new AcceptanceProcessor(faultPrisma, access, operations).fail(
			retry.event,
			retryClaim.token,
			0,
			new ServiceUnavailableException()
		),
		/INJECTED_RETRY_AFTER_INSERT/
	);
	assert.equal(retryInsertReached, true);
	assert.deepEqual(
		await runtime.acceptanceReceipt.findFirst({
			where: { eventId: retry.event.eventId }
		}),
		failureSnapshot
	);
	assert.equal(
		await runtime.acceptanceOutbox.count({
			where: { eventId: retry.event.eventId, retryAttempt: 1 }
		}),
		0
	);
	const [beforeRetryClock] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	assert.equal(
		await processor.fail(
			retry.event,
			retryClaim.token,
			0,
			new ServiceUnavailableException()
		),
		true
	);

	const [afterRetryClock] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	const scheduledRetry = await runtime.acceptanceOutbox.findFirstOrThrow({
		where: { eventId: retry.event.eventId, retryAttempt: 1 }
	});
	assert.equal(scheduledRetry.route, 'MAIN');
	assert.ok(
		scheduledRetry.availableAt.getTime() >=
			beforeRetryClock.now.getTime() + 30000
	);
	assert.ok(
		scheduledRetry.availableAt.getTime() <=
			afterRetryClock.now.getTime() + 30000 + 1
	);
	let prematurePublish = false;
	const onlyRetry = scopedOutbox([scheduledRetry.id]);
	await new AcceptancePublisher(onlyRetry, {
		publish: async () => {
			prematurePublish = true;
		}
	}).tick();
	assert.equal(prematurePublish, false);
	row = await runtime.acceptance.findUnique({
		where: { id: retry.response.acceptance.id }
	});
	assert.equal(row.status, 'RETRY_WAIT');
	assert.equal(
		row.retryAt.getTime(),
		scheduledRetry.availableAt.getTime()
	);
	assert.equal(
		await runtime.acceptanceOutbox.count({
			where: {
				eventId: retry.event.eventId,
				route: 'MAIN',
				retryAttempt: 1
			}
		}),
		1
	);
	assert.equal(
		await processor.fail(retry.event, retryClaim.token, 0, new Error()),
		false
	);
	failSales = false;
	const retryAgain = await processor.claim(retry.event, 1);
	await processor.run(retry.event, retryAgain.token);

	await verifyDelayedPublisher();
	const broker = process.env.CRM_INTAKE_ACCEPTANCE_TEST_RABBITMQ_URL;
	if (broker) {
		const url = new URL(broker);
		assert.ok(['amqp:', 'amqps:'].includes(url.protocol));
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.match(
			decodeURIComponent(url.pathname),
			/^\/[a-z0-9_-]+_(test|ci)$/
		);
		assert.ok(url.username && url.password);
		const { connect } = await import('amqplib');
		inspector = await connect(broker);
		inspectorChannel = await inspector.createChannel();
		// Namespace belongs exclusively to this isolated vhost. Existing messages are forbidden; the test never purges another run.
		process.env.CRM_INTAKE_RABBITMQ_URL = broker;
		process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'true';
		rabbit = new AcceptanceRabbit();
		await rabbit.onModuleInit();
		for (const queue of [ACCEPTANCE_QUEUE, ACCEPTANCE_DEAD_QUEUE]) {
			const state = await inspectorChannel.checkQueue(queue);
			assert.equal(state.messageCount, 0);
			assert.equal(state.consumerCount, 0);
		}
		// Retire only this test workspace's previously exercised envelopes before the live push phase.
		await runtime.acceptanceOutbox.updateMany({
			where: { payload: { path: ['workspaceId'], equals: workspaceId } },
			data: {
				status: 'PUBLISHED',
				publishedAt: new Date(),
				leaseToken: null,
				leaseUntil: null
			}
		});
		failSales = true;
		const live = await intent();
		worker = new AcceptanceWorker(processor, rabbit, runtime);
		publisher = new AcceptancePublisher(runtime, rabbit);
		await worker.onApplicationBootstrap();
		assert.equal(rabbit.ready(true), true);

		await publisher.tick();
		await until(async () =>
			Boolean(
				await runtime.acceptanceOutbox.findFirst({
					where: { eventId: live.event.eventId, retryAttempt: 1 }
				})
			)
		);
		const liveRetry = await runtime.acceptanceOutbox.findFirstOrThrow({
			where: { eventId: live.event.eventId, retryAttempt: 1 }
		});
		assert.equal(liveRetry.route, 'MAIN');
		failSales = false;
		await publisher.tick();
		assert.equal(
			(
				await runtime.acceptanceOutbox.findUniqueOrThrow({
					where: { id: liveRetry.id }
				})
			).status,
			'PENDING'
		);
		// A fresh publisher process resumes the persisted delay; no shortened business clock or TTL relay.
		await publisher.beforeApplicationShutdown();
		publisher = new AcceptancePublisher(runtime, rabbit);
		await until(
			async () => {
				await publisher.tick();
				return (
					(
						await runtime.acceptance.findUniqueOrThrow({
							where: { id: live.response.acceptance.id }
						})
					).status === 'COMPLETED'
				);
			},
			50000,
			1000
		);
		const deliveredRetry =
			await runtime.acceptanceOutbox.findUniqueOrThrow({
				where: { id: liveRetry.id }
			});
		assert.equal(deliveredRetry.status, 'PUBLISHED');
		assert.ok(deliveredRetry.publishedAt >= liveRetry.availableAt);

		const liveCount = { ...writes };
		await rabbit.publish(live.event, 'MAIN', 0);
		await until(
			async () =>
				(await inspectorChannel.checkQueue(ACCEPTANCE_QUEUE))
					.messageCount === 0
		);
		assert.deepEqual(writes, liveCount);
		// Publisher confirm alone is insufficient when a mandatory message has no route.
		await inspectorChannel.unbindQueue(
			ACCEPTANCE_QUEUE,
			ACCEPTANCE_EXCHANGE,
			ACCEPTANCE_EVENT_TYPE
		);
		try {
			await assert.rejects(
				() => rabbit.publish(live.event, 'MAIN', 0),
				/MANDATORY_RETURN/
			);
		} finally {
			await inspectorChannel.bindQueue(
				ACCEPTANCE_QUEUE,
				ACCEPTANCE_EXCHANGE,
				ACCEPTANCE_EVENT_TYPE
			);
		}
		await worker.beforeApplicationShutdown();
		worker = null;
		console.log(
			'CRM Intake real RabbitMQ: owned push consume, confirm+mandatory, duplicate delivery, durable receipts, PG-delayed retry across publisher restart and drain passed'
		);
	}
	console.log(
		'CRM Intake PG18 acceptance: atomic intent/outbox, competing claims, crash/expired completion, partial recovery, tombstones, reviewed restart, CAS and retry passed'
	);
} finally {
	try {
		await worker?.beforeApplicationShutdown();
		await publisher?.beforeApplicationShutdown();
		await rabbit?.onApplicationShutdown();
		await inspectorChannel?.close();
		await inspector?.close();
		await migrator.$transaction(async tx => {
			const where = { workspaceId };
			await tx.acceptanceReceipt.deleteMany({ where });
			await tx.acceptanceOutbox.deleteMany({
				where: { payload: { path: ['workspaceId'], equals: workspaceId } }
			});
			await tx.acceptance.deleteMany({ where });
			await tx.intakeActivity.deleteMany({ where });
			await tx.intakeCommand.deleteMany({ where });
			await tx.inboxEntry.deleteMany({ where });
		});
	} finally {
		await Promise.all([runtime.$disconnect(), migrator.$disconnect()]);
	}
}
async function intent() {
	const entry = await runtime.inboxEntry.create({
		data: {
			workspaceId,
			title: 'PG Inbox',
			name: 'PG contact',
			origin: 'MANUAL',
			createdBySubject: context.subject
		}
	});
	const dto = {
		...command(1),
		contact: { mode: 'CREATE_FROM_ENTRY' },
		deal: {
			title: 'PG acceptance',
			currency: 'RUB',
			amountMinor: 0,
			pipelineId: randomUUID(),
			stageId: randomUUID(),
			nextTask: { title: 'Call', dueAt: '2026-09-01T00:00:00.000Z' }
		}
	};
	const response = await service.accept(context, entry.id, dto);
	return {
		entry,
		dto,
		response,
		event: await initialEvent(response.acceptance.id, 1)
	};
}
async function initialEvent(id, generation) {
	return (
		await runtime.acceptanceOutbox.findUnique({
			where: { deduplicationKey: `${id}:${generation}:initial` }
		})
	).payload;
}
function command(expectedVersion) {
	return {
		schemaVersion: 1,
		workspaceId,
		commandId: randomUUID(),
		expectedVersion
	};
}
function status(code) {
	return error => error?.getStatus?.() === code;
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
		url.searchParams.get('schema') !== 'crm_intake'
	)
		throw new Error('Isolated loopback Intake test database required');
	return `${url.hostname}:${url.port}${url.pathname}`;
}
async function until(check, timeout = 20000, interval = 50) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolve => setTimeout(resolve, interval));
	}
	throw new Error('Acceptance test deadline exceeded');
}

function scopedOutbox(ids) {
	return {
		$queryRaw: runtime.$queryRaw.bind(runtime),
		acceptanceOutbox: {
			findMany: args =>
				runtime.acceptanceOutbox.findMany({
					...args,
					where: { AND: [args.where, { id: { in: ids } }] }
				}),
			updateMany: args =>
				runtime.acceptanceOutbox.updateMany({
					...args,
					where: { AND: [args.where, { id: { in: ids } }] }
				}),
			findUnique: args => {
				assert.ok(ids.includes(args.where.id));
				return runtime.acceptanceOutbox.findUnique(args);
			}
		}
	};
}
async function verifyDelayedPublisher() {
	const [clock] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	const now = clock.now.getTime(),
		ids = [],
		eligibleIds = [],
		waitingIds = [];
	const seed = async (route, attempt, availableAt, extra = {}) => {
		const id = randomUUID(),
			eventId = randomUUID();
		const payload = {
			schemaVersion: 1,
			eventId,
			workspaceId,
			workflowId: randomUUID(),
			generation: 1,
			mode: 'EXECUTE'
		};
		await runtime.acceptanceOutbox.create({
			data: {
				id,
				eventId,
				deduplicationKey: id,
				route,
				retryAttempt: attempt,
				availableAt: new Date(availableAt),
				payload,
				...extra
			}
		});
		ids.push(id);
		return id;
	};
	// More than LIMIT future legacy rows sort before an eligible MAIN. They must not starve it.
	for (let i = 0; i < 25; i++)
		waitingIds.push(await seed('RETRY_3', 3, now - 60000));
	for (const [index, delay] of [30000, 300000, 1800000].entries())
		eligibleIds.push(
			await seed('RETRY_' + (index + 1), index + 1, now - delay - 1000)
		);
	eligibleIds.push(await seed('MAIN', 1, now - 1000));
	eligibleIds.push(
		await seed('MAIN', 0, now - 1000, {
			status: 'PUBLISHING',
			leaseToken: randomUUID(),
			leaseUntil: new Date(now - 100)
		})
	);
	const futureId = await seed('MAIN', 1, now + 60000);
	waitingIds.push(futureId);
	const deliveries = [];
	const publish = async (event, route, attempt) => {
		assert.equal(route, 'MAIN');
		deliveries.push({ eventId: event.eventId, attempt });
	};
	const scoped = scopedOutbox(ids);
	await new AcceptancePublisher(scoped, { publish }).tick();
	assert.equal(deliveries.length, eligibleIds.length);
	for (const id of eligibleIds)
		assert.equal(
			(await runtime.acceptanceOutbox.findUniqueOrThrow({ where: { id } }))
				.status,
			'PUBLISHED'
		);
	for (const id of waitingIds)
		assert.equal(
			(await runtime.acceptanceOutbox.findUniqueOrThrow({ where: { id } }))
				.status,
			'PENDING'
		);
	await new AcceptancePublisher(scoped, { publish }).tick();
	assert.equal(deliveries.length, eligibleIds.length);
	// Advance only a synthetic test envelope, never a saved business retry or the DB/system clock.
	await runtime.acceptanceOutbox.update({
		where: { id: futureId },
		data: { availableAt: clock.now }
	});
	await new AcceptancePublisher(scoped, { publish }).tick();
	assert.equal(deliveries.length, eligibleIds.length + 1);
	// Transport errors remain retryable after arbitrarily many prior attempts, using database time.
	const failureId = await seed('MAIN', 0, now - 1000, {
		attempts: 100000
	});
	const [before] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	await new AcceptancePublisher(scopedOutbox([failureId]), {
		publish: async () => {
			throw new Error('TEST_UNCONFIRMED');
		}
	}).tick();
	const [after] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	const failed = await runtime.acceptanceOutbox.findUniqueOrThrow({
		where: { id: failureId }
	});
	assert.equal(failed.status, 'PENDING');
	assert.equal(failed.attempts, 100001);
	assert.equal(failed.lastErrorCode, 'PUBLICATION_UNCONFIRMED');
	assert.ok(failed.availableAt.getTime() >= before.now.getTime() + 60000);
	assert.ok(failed.availableAt.getTime() <= after.now.getTime() + 60001);
	console.log(
		'Acceptance PG delayed retry: new delay/rollback, legacy MAIN resume, no starvation, expired claim and unbounded transport retry passed'
	);
}
