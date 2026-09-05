import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-intake-client');
const {
	ForbiddenException,
	ServiceUnavailableException
} = require('@nestjs/common');
const {
	WidgetSourceService
} = require('../../dist/src/widget-sources/widget-source.service.js');
const {
	WidgetTransferProcessor,
	TransferOutcome,
	transferConstraints
} = require('../../dist/src/widget-transfers/widget-transfer.processor.js');
const {
	WidgetTransferService
} = require('../../dist/src/widget-transfers/widget-transfer.service.js');
const {
	WidgetTransferPublisher
} = require('../../dist/src/widget-transfers/widget-transfer.publisher.js');
const {
	IntakeService
} = require('../../dist/src/intake/intake.service.js');
const {
	IntakeExportService
} = require('../../dist/src/exports/export.service.js');
const {
	TRANSFER_CONSUMER,
	WINCRM_TRANSFER_EVENT
} = require('../../dist/src/widget-transfers/widget-transfer.contract.js');
const required = name => {
	const value = process.env[name];
	assert.ok(value, name + ' required');
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
assert.equal(process.env.CRM_INTAKE_INTEGRATION_ALLOW_MUTATION, 'true');
const runtimeUrl = required('CRM_INTAKE_TEST_DATABASE_URL'),
	migrationUrl = required('CRM_INTAKE_TEST_MIGRATION_DATABASE_URL'),
	runtimeRole = required('CRM_INTAKE_TEST_RUNTIME_ROLE');
assert.equal(local(runtimeUrl), local(migrationUrl));
assert.equal(
	decodeURIComponent(new URL(runtimeUrl).username),
	runtimeRole
);
assert.notEqual(
	new URL(runtimeUrl).username,
	new URL(migrationUrl).username
);
const runtime = new PrismaClient({
		datasources: { db: { url: runtimeUrl } }
	}),
	migrator = new PrismaClient({
		datasources: { db: { url: migrationUrl } }
	});
const workspaceId = randomUUID(),
	teamId = randomUUID(),
	foreignWorkspace = randomUUID();
const context = {
	schemaVersion: 1,
	workspaceId,
	subject: 'a'.repeat(256),
	role: 'CRM_ADMIN',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: [
		'intake:read',
		'intake:write',
		'intake:manage-sources',
		'intake:export'
	]
};
let delegated = true,
	owner = 'owner',
	contextHook = null,
	contextCalls = 0;
const authorization = {
	authorize: async (_token, wsp) => ({ ...context, workspaceId: wsp }),
	authorizeWidgetSource: async (wsp, subject) => {
		if (!delegated || context.state === 'READ_ONLY')
			throw new ForbiddenException();
		assert.equal(subject, context.subject);
		return { ...context, workspaceId: wsp, subject, ownerSubject: owner };
	}
};
const widgets = {
	context: async (event, source) => {
		contextCalls++;
		if (contextHook) await contextHook();
		return {
			schemaVersion: 1,
			eventId: event.eventId,
			transferId: event.transferId,
			workspaceId: event.workspaceId,
			sourceId: event.sourceId,
			connectorId: event.connectorId,
			generation: event.generation,
			deliver: true,
			reason: 'READY',
			checkedAt: new Date().toISOString(),
			validUntil: new Date(Date.now() + 4000).toISOString(),
			payload: {
				schemaVersion: 1,
				widget: {
					type: source.widgetType,
					id: source.widgetId,
					name: 'PG Quiz',
					publishedVersion: 1
				},
				lead: {
					id: 'lead-' + event.transferId,
					createdAt: event.occurredAt,
					contactName: null,
					contactRaw: 'Unmodified contact',
					phoneRaw: '+79000000001',
					phoneE164: '+79000000001',
					email: 'not-an-email',
					pageUrl: null,
					redactions: []
				},
				details: { type: 'QUIZ', result: 'Typed result', answers: [] }
			}
		};
	}
};
const sources = new WidgetSourceService(
	runtime,
	authorization,
	{},
	{ enabled: true }
);
const processor = new WidgetTransferProcessor(
		runtime,
		authorization,
		widgets
	),
	service = new WidgetTransferService(runtime, authorization),
	intake = new IntakeService(runtime);
const command = () => ({
	schemaVersion: 1,
	workspaceId,
	commandId: randomUUID()
});
async function source() {
	const dto = {
		...command(),
		name: 'Transfer source',
		widgetType: 'QUIZ',
		widgetId: 'widget-' + randomUUID(),
		teamId
	};
	const result = await sources.create('Bearer test', dto);
	return runtime.managedWidgetSource.findUniqueOrThrow({
		where: { id: result.source.id }
	});
}
const eventFor = source => ({
	schemaVersion: 1,
	eventType: WINCRM_TRANSFER_EVENT,
	eventId: randomUUID(),
	occurredAt: new Date(Date.now() - 1000).toISOString(),
	transferId: randomUUID(),
	connectorId: source.connectorId,
	generation: source.generation,
	workspaceId,
	sourceId: source.id,
	originalSubscriptionId: 'subscription',
	originalSubscriptionVersion: '1',
	originalPeriodStartsAt: new Date(Date.now() - 60000).toISOString(),
	originalDeadline: new Date(Date.now() + 60000).toISOString()
});
const receipt = event =>
	runtime.widgetTransferReceipt.findUniqueOrThrow({
		where: {
			eventId_consumer: {
				eventId: event.eventId,
				consumer: TRANSFER_CONSUMER
			}
		}
	});
const http = status => error => error?.getStatus?.() === status;
const state = code => error =>
	error?.meta?.code === code || error?.code === code;
const counts = () =>
	Promise.all([
		runtime.inboxEntry.count({ where: { workspaceId } }),
		runtime.widgetEntrySnapshot.count({ where: { workspaceId } }),
		runtime.intakeActivity.count({ where: { workspaceId } })
	]);
async function deliver(event) {
	const claim = await processor.claim(event);
	assert.equal(claim.state, 'CLAIMED');
	await processor.run(event, claim.token);
	return receipt(event);
}
let phase = 'acl',
	rabbit,
	publisherRabbit,
	provisionRabbit,
	worker,
	publisher,
	inspector,
	inspectorChannel;
try {
	const [role] = await runtime.$queryRawUnsafe(
		"SELECT current_user AS name,current_setting('server_version_num')::integer AS version,NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname=current_user"
	);
	assert.equal(role.name, runtimeRole);
	assert.equal(role.restricted, true);
	assert.equal(Math.floor(role.version / 10000), 18);
	for (const table of [
		'widget_transfer_receipts',
		'widget_transfer_outbox',
		'widget_entry_snapshots'
	]) {
		const [acl] = await runtime.$queryRawUnsafe(
			"SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
			'crm_intake.' + table
		);
		assert.deepEqual(acl, {
			read: true,
			insert: true,
			update: table !== 'widget_entry_snapshots',
			delete: false,
			truncate: false
		});
	}
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT * FROM foreign_service_guard.sentinel'
		),
		state('42501')
	);
	phase = 'parallel-claim';
	const firstSource = await source(),
		first = eventFor(firstSource);
	const parallel = await Promise.allSettled(
		Array.from({ length: 6 }, () => processor.claim(first))
	);
	const winners = parallel.filter(
		result =>
			result.status === 'fulfilled' && result.value.state === 'CLAIMED'
	);
	assert.equal(winners.length, 1);
	for (const result of parallel)
		if (result.status === 'rejected')
			assert.ok(
				result.reason?.getStatus?.() === 503 ||
					['P2002', 'P2034'].includes(result.reason?.code)
			);
	await processor.run(first, winners[0].value.token);
	const delivered = await receipt(first);
	assert.equal(delivered.status, 'DELIVERED');
	assert.ok(delivered.entryId);
	assert.equal(
		await runtime.widgetTransferReceipt.count({
			where: { eventId: first.eventId }
		}),
		1
	);
	const calls = contextCalls;
	assert.deepEqual(await processor.claim(first), { state: 'DONE' });
	await assert.rejects(
		processor.claim({ ...first, eventId: randomUUID() }),
		http(409)
	);
	assert.equal(contextCalls, calls);
	await assert.rejects(
		processor.claim({ ...first, originalSubscriptionVersion: '2' }),
		http(409)
	);
	const entry = await runtime.inboxEntry.findUniqueOrThrow({
		where: { id: delivered.entryId }
	});
	assert.equal(entry.origin, 'WIDGET');
	assert.equal(entry.name, null);
	assert.equal(entry.email, null);
	assert.equal(entry.sourceId, null);
	assert.equal(entry.widgetSourceId, firstSource.id);
	assert.equal(entry.status, 'NEW');
	assert.equal(
		await runtime.acceptance.count({ where: { workspaceId } }),
		0
	);
	phase = 'read-after-disable-and-expiry';
	await sources.configure('Bearer test', firstSource.id, {
		...command(),
		expectedVersion: 1,
		enabled: false
	});
	delegated = false;
	context.state = 'READ_ONLY';
	const detail = await intake.widgetDetails(
		context,
		workspaceId,
		entry.id
	);
	assert.equal(detail.sourceId, firstSource.id);
	assert.equal(detail.payload.lead.contactName, null);
	assert.equal(detail.payload.lead.email, 'not-an-email');
	assert.equal(contextCalls, calls);
	await assert.rejects(
		intake.widgetDetails(
			{ ...context, workspaceId: foreignWorkspace },
			foreignWorkspace,
			entry.id
		),
		http(404)
	);
	await assert.rejects(
		intake.widgetDetails(
			{ ...context, subject: 'other', dataScope: 'OWN' },
			workspaceId,
			entry.id
		),
		http(404)
	);
	assert.equal(
		(
			await intake.widgetDetails(
				{ ...context, subject: 'teammate', dataScope: 'TEAM' },
				workspaceId,
				entry.id
			)
		).entryId,
		entry.id
	);
	phase = 'summary-export';
	context.role = 'OWNER';
	const exporter = new IntakeExportService(runtime, authorization);
	const file = await exporter.prepare(
		'Bearer test',
		workspaceId,
		'inbox',
		'json'
	);
	const exported = JSON.parse(file.body.toString());
	assert.equal(exported.items[0].name, null);
	assert.equal(exported.items[0].sourceId, firstSource.id);
	assert.equal(Object.keys(exported.items[0]).length, 20);
	assert.equal(file.body.toString().includes('Typed result'), false);
	context.role = 'CRM_ADMIN';
	context.state = 'ACTIVE';
	delegated = true;
	phase = 'disable-race';
	const racingSource = await source(),
		racing = eventFor(racingSource),
		claim = await processor.claim(racing);
	contextHook = async () => {
		contextHook = null;
		await sources.configure('Bearer test', racingSource.id, {
			...command(),
			expectedVersion: 1,
			enabled: false
		});
	};
	let raceError;
	try {
		await processor.run(racing, claim.token);
	} catch (error) {
		raceError = error;
	}
	assert.equal(raceError?.code, 'LOCAL_DISABLED');
	await processor.fail(racing, claim.token, 0, raceError);
	assert.equal((await receipt(racing)).status, 'SKIPPED');
	assert.equal((await receipt(racing)).entryId, null);
	await sources.configure('Bearer test', racingSource.id, {
		...command(),
		expectedVersion: 2,
		enabled: true
	});
	const previous = eventFor(racingSource),
		oldClaim = await processor.claim(previous);
	await assert.rejects(
		processor.run(previous, oldClaim.token),
		error => error?.code === 'GENERATION_CHANGED'
	);
	await processor.fail(
		previous,
		oldClaim.token,
		0,
		new TransferOutcome('SKIPPED', 'GENERATION_CHANGED')
	);
	phase = 'revoke-retry-original-actor';
	const blockedSource = await source(),
		blocked = eventFor(blockedSource),
		blockedClaim = await processor.claim(blocked);
	delegated = false;
	await assert.rejects(
		processor.run(blocked, blockedClaim.token),
		http(403)
	);
	await processor.fail(
		blocked,
		blockedClaim.token,
		0,
		new ForbiddenException()
	);
	assert.equal((await receipt(blocked)).status, 'BLOCKED');
	delegated = true;
	process.env.CRM_INTAKE_WIDGETS_ENABLED = 'true';
	process.env.CRM_INTAKE_WIDGET_TRANSFERS_ENABLED = 'true';
	const retryDto = {
		...command(),
		expectedVersion: (await receipt(blocked)).version
	};
	const queued = await service.retry(
		'Bearer test',
		blockedSource.id,
		blocked.transferId,
		retryDto
	);
	assert.equal(queued.transfer.state, 'RETRY_PENDING');
	assert.equal(queued.transfer.version, retryDto.expectedVersion + 1);
	const again = await service.retry(
		'Bearer test',
		blockedSource.id,
		blocked.transferId,
		retryDto
	);
	assert.deepEqual(again, queued);
	await assert.rejects(
		service.retry('Bearer test', blockedSource.id, blocked.transferId, {
			...retryDto,
			expectedVersion: retryDto.expectedVersion + 1
		}),
		http(409)
	);
	assert.deepEqual(await processor.claim(blocked, 0, 0), {
		state: 'DONE'
	});
	const retryClaim = await processor.claim(blocked, 0, 1);
	await processor.run(blocked, retryClaim.token);
	assert.equal((await receipt(blocked)).actorSubject, context.subject);
	assert.equal((await receipt(blocked)).status, 'DELIVERED');
	await assert.rejects(
		intake.createManual(context, {
			...retryDto,
			title: 'Manual',
			name: 'Name'
		}),
		http(409)
	);
	phase = 'expired-period';
	const expired = eventFor(blockedSource);
	expired.originalDeadline = new Date(Date.now() - 1).toISOString();
	const expiredClaim = await processor.claim(expired);
	const before = contextCalls;
	await assert.rejects(
		processor.run(expired, expiredClaim.token),
		error => error?.code === 'PERIOD_EXPIRED'
	);
	assert.equal(contextCalls, before);
	await processor.fail(
		expired,
		expiredClaim.token,
		0,
		new TransferOutcome('SKIPPED', 'PERIOD_EXPIRED')
	);
	phase = 'expired-lease';
	const crashed = eventFor(blockedSource),
		crashedClaim = await processor.claim(crashed);
	await runtime.$transaction(async tx => {
		await tx.widgetTransferReceipt.update({
			where: {
				eventId_consumer: {
					eventId: crashed.eventId,
					consumer: TRANSFER_CONSUMER
				}
			},
			data: {
				leaseUntil: new Date(Date.now() - 1000),
				version: { increment: 1 }
			}
		});
		await transferConstraints(tx);
	});
	const reclaimed = await processor.claim(crashed);
	assert.notEqual(reclaimed.token, crashedClaim.token);
	await assert.rejects(
		processor.run(crashed, crashedClaim.token),
		http(409)
	);
	await processor.run(crashed, reclaimed.token);
	phase = 'automatic-retry';
	const transient = eventFor(blockedSource),
		transientClaim = await processor.claim(transient);
	const [beforeRetry] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	await processor.fail(
		transient,
		transientClaim.token,
		0,
		new ServiceUnavailableException()
	);
	const scheduled = await runtime.widgetTransferOutbox.findFirstOrThrow({
		where: { eventId: transient.eventId, route: 'MAIN', retryAttempt: 1 }
	});
	const [afterRetry] =
		await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
	assert.ok(
		scheduled.availableAt.getTime() >= beforeRetry.now.getTime() + 5000
	);
	assert.ok(
		scheduled.availableAt.getTime() <= afterRetry.now.getTime() + 5000
	);
	const publications = [];
	const capture = {
		publish: async (event, route, attempt, generation) => {
			publications.push({
				eventId: event.eventId,
				route,
				attempt,
				generation
			});
		}
	};
	await new WidgetTransferPublisher(runtime, capture).tick();
	assert.equal(
		publications.some(item => item.eventId === transient.eventId),
		false
	);
	assert.equal(
		(
			await runtime.widgetTransferOutbox.findUniqueOrThrow({
				where: { id: scheduled.id }
			})
		).status,
		'PENDING'
	);
	// Persist a publisher-crash claim; a fresh publisher must not recover it before the due time.
	await runtime.widgetTransferOutbox.update({
		where: { id: scheduled.id },
		data: {
			status: 'PUBLISHING',
			leaseToken: randomUUID(),
			leaseUntil: new Date(beforeRetry.now.getTime() - 1000)
		}
	});
	await new WidgetTransferPublisher(runtime, capture).tick();
	assert.equal(
		publications.some(item => item.eventId === transient.eventId),
		false
	);
	await until(async () => {
		const [clock] =
			await runtime.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
		return clock.now >= scheduled.availableAt;
	});
	await new WidgetTransferPublisher(runtime, capture).tick();
	assert.deepEqual(
		publications.filter(item => item.eventId === transient.eventId),
		[
			{
				eventId: transient.eventId,
				route: 'MAIN',
				attempt: 1,
				generation: 0
			}
		]
	);
	assert.equal(
		(
			await runtime.widgetTransferOutbox.findUniqueOrThrow({
				where: { id: scheduled.id }
			})
		).status,
		'PUBLISHED'
	);
	const automatic = await processor.claim(transient, 1, 0);
	await processor.run(transient, automatic.token);
	assert.equal((await receipt(transient)).status, 'DELIVERED');
	phase = 'fault-after-actual-insert';
	for (const targetDelegate of [
		'inboxEntry',
		'widgetEntrySnapshot',
		'intakeActivity',
		'widgetTransferReceipt'
	]) {
		const event = eventFor(blockedSource),
			claimed = await processor.claim(event),
			before = await counts();
		let reached = false;
		const faulty = new Proxy(runtime, {
			get(target, key) {
				if (key !== '$transaction') return target[key];
				return (callback, options) =>
					target.$transaction(
						tx =>
							callback(
								new Proxy(tx, {
									get(current, property) {
										if (property !== targetDelegate)
											return current[property];
										return new Proxy(current[property], {
											get(delegate, method) {
												const intercepted =
													targetDelegate === 'widgetTransferReceipt'
														? 'updateMany'
														: 'create';
												if (method !== intercepted)
													return delegate[method];
												return async args => {
													const result = await delegate[method](args);
													if (
														targetDelegate !== 'widgetTransferReceipt' ||
														args.data.status === 'DELIVERED'
													) {
														reached = true;
														throw new Error('INJECTED_AFTER_ACTUAL_WRITE');
													}
													return result;
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
		await assert.rejects(
			new WidgetTransferProcessor(faulty, authorization, widgets).run(
				event,
				claimed.token
			)
		);
		assert.equal(reached, true);
		assert.deepEqual(await counts(), before);
		assert.equal((await receipt(event)).status, 'PROCESSING');
	}
	phase = 'database-invariants-snapshot-update-acl';
	await assert.rejects(
		runtime.$executeRaw`UPDATE crm_intake.widget_entry_snapshots SET payload='{}'::jsonb WHERE entry_id=${entry.id}::uuid AND workspace_id=${workspaceId}::uuid`,
		state('42501')
	);
	phase = 'database-invariants-terminal-receipt';
	await assert.rejects(
		runtime.widgetTransferReceipt.update({
			where: {
				eventId_consumer: {
					eventId: first.eventId,
					consumer: TRANSFER_CONSUMER
				}
			},
			data: {
				status: 'BLOCKED',
				entryId: null,
				auditCommandId: null,
				completedAt: null,
				version: { increment: 1 }
			}
		})
	);
	phase = 'database-invariants-immutable-projection';
	await assert.rejects(
		runtime.inboxEntry.update({
			where: { id: entry.id },
			data: { name: 'Invented' }
		})
	);
	phase = 'database-invariants-missing-native-proof';
	await assert.rejects(
		runtime.$transaction(async tx => {
			await tx.inboxEntry.create({
				data: {
					workspaceId,
					title: 'Fake',
					name: null,
					origin: 'WIDGET',
					widgetSourceId: blockedSource.id,
					createdBySubject: context.subject
				}
			});
			await transferConstraints(tx);
		})
	);
	phase = 'database-invariants-legacy-null-name';
	await assert.rejects(
		runtime.inboxEntry.create({
			data: {
				workspaceId,
				title: 'Legacy',
				name: null,
				origin: 'MANUAL',
				createdBySubject: context.subject
			}
		})
	);
	const broker = process.env.CRM_INTAKE_WIDGET_TRANSFER_TEST_RABBITMQ_URL;
	if (broker) {
		phase = 'real-rabbit';
		const url = new URL(broker);
		assert.ok(['amqp:', 'amqps:'].includes(url.protocol));
		assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
		assert.match(
			decodeURIComponent(url.pathname),
			/^\/[a-z0-9_-]+_(test|ci)$/
		);
		assert.ok(url.username && url.password);
		const workerBroker = required(
			'CRM_INTAKE_WIDGET_TRANSFER_TEST_WORKER_RABBITMQ_URL'
		);
		const publisherBroker = required(
			'CRM_INTAKE_WIDGET_TRANSFER_TEST_PUBLISHER_RABBITMQ_URL'
		);
		const identities = new Set([url.username]);
		for (const value of [workerBroker, publisherBroker]) {
			const peer = new URL(value);
			assert.equal(peer.protocol, url.protocol);
			assert.equal(peer.host, url.host);
			assert.equal(peer.pathname, url.pathname);
			assert.ok(peer.username && peer.password);
			identities.add(peer.username);
		}
		assert.equal(
			identities.size,
			3,
			'Separate scoped broker principals required'
		);
		const { connect } = require('amqplib');
		const {
			WidgetTransferRabbit,
			TRANSFER_QUEUE,
			TRANSFER_DEAD_QUEUE,
			TRANSFER_UPSTREAM_EXCHANGE,
			TRANSFER_EVENT_TYPE
		} = require('../../dist/src/widget-transfers/widget-transfer.messaging.js');
		const {
			WidgetTransferWorker
		} = require('../../dist/src/widget-transfers/widget-transfer.worker.js');
		inspector = await connect(broker);
		inspectorChannel = await inspector.createConfirmChannel();
		process.env.CRM_INTAKE_RABBITMQ_URL = broker;
		process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'true';
		provisionRabbit = new WidgetTransferRabbit();
		await provisionRabbit.onModuleInit();
		for (const queue of [TRANSFER_QUEUE, TRANSFER_DEAD_QUEUE]) {
			const result = await inspectorChannel.checkQueue(queue);
			assert.equal(result.messageCount, 0);
			assert.equal(result.consumerCount, 0);
		}
		await provisionRabbit.onApplicationShutdown();
		provisionRabbit = null;
		process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'false';
		process.env.CRM_INTAKE_RABBITMQ_URL = workerBroker;
		rabbit = new WidgetTransferRabbit();
		await rabbit.onModuleInit();
		process.env.CRM_INTAKE_RABBITMQ_URL = publisherBroker;
		publisherRabbit = new WidgetTransferRabbit();
		await publisherRabbit.onModuleInit();
		// Retire only our already-exercised test envelopes; production never performs this fixture setup.
		await runtime.widgetTransferOutbox.updateMany({
			where: { payload: { path: ['workspaceId'], equals: workspaceId } },
			data: {
				status: 'PUBLISHED',
				publishedAt: new Date(),
				leaseToken: null,
				leaseUntil: null
			}
		});
		worker = new WidgetTransferWorker(processor, rabbit, runtime);
		publisher = new WidgetTransferPublisher(runtime, publisherRabbit);
		await worker.onApplicationBootstrap();
		const live = eventFor(blockedSource);
		inspectorChannel.publish(
			TRANSFER_UPSTREAM_EXCHANGE,
			TRANSFER_EVENT_TYPE,
			Buffer.from(JSON.stringify(live)),
			{
				contentType: 'application/json',
				persistent: true,
				mandatory: true,
				type: TRANSFER_EVENT_TYPE,
				messageId: live.eventId,
				headers: {}
			}
		);
		await inspectorChannel.waitForConfirms();
		await until(
			async () =>
				(
					await runtime.widgetTransferReceipt.findFirst({
						where: { eventId: live.eventId }
					})
				)?.status === 'DELIVERED'
		);
		const calls = contextCalls;
		await publisherRabbit.publish(live, 'MAIN', 0, 0);
		await until(
			async () =>
				(await inspectorChannel.checkQueue(TRANSFER_QUEUE))
					.messageCount === 0
		);
		assert.equal(contextCalls, calls);
		const automaticLive = eventFor(blockedSource);
		contextHook = async () => {
			contextHook = null;
			throw new ServiceUnavailableException();
		};
		await publisherRabbit.publish(automaticLive, 'MAIN', 0, 0);
		await until(
			async () =>
				(
					await runtime.widgetTransferReceipt.findFirst({
						where: { eventId: automaticLive.eventId }
					})
				)?.status === 'RETRY_PENDING'
		);
		const delayedLive =
			await runtime.widgetTransferOutbox.findFirstOrThrow({
				where: {
					eventId: automaticLive.eventId,
					route: 'MAIN',
					retryAttempt: 1
				}
			});
		const beforeAutomaticCalls = contextCalls;
		await publisher.tick();
		assert.equal(contextCalls, beforeAutomaticCalls);
		assert.equal(
			(
				await runtime.widgetTransferOutbox.findUniqueOrThrow({
					where: { id: delayedLive.id }
				})
			).status,
			'PENDING'
		);
		// A fresh publisher sees the durable due time and publishes directly under its write-only credential.
		await publisher.beforeApplicationShutdown();
		publisher = new WidgetTransferPublisher(runtime, publisherRabbit);
		await until(async () => {
			await publisher.tick();
			return (await receipt(automaticLive)).status === 'DELIVERED';
		});
		assert.equal((await receipt(automaticLive)).retryAttempt, 1);
		const blockedLive = eventFor(blockedSource);
		delegated = false;
		await publisherRabbit.publish(blockedLive, 'MAIN', 0, 0);
		await until(
			async () =>
				(
					await runtime.widgetTransferReceipt.findFirst({
						where: { eventId: blockedLive.eventId }
					})
				)?.status === 'BLOCKED'
		);
		await publisher.tick();
		await until(
			async () =>
				(await inspectorChannel.checkQueue(TRANSFER_DEAD_QUEUE))
					.messageCount === 1
		);
		delegated = true;
		const retry = {
			...command(),
			expectedVersion: (await receipt(blockedLive)).version
		};
		await service.retry(
			'Bearer test',
			blockedSource.id,
			blockedLive.transferId,
			retry
		);
		await publisher.tick();
		await until(
			async () => (await receipt(blockedLive)).status === 'DELIVERED'
		);
		await inspectorChannel.unbindQueue(
			TRANSFER_QUEUE,
			require('../../dist/src/widget-transfers/widget-transfer.messaging.js')
				.TRANSFER_EXCHANGE,
			TRANSFER_EVENT_TYPE
		);
		try {
			await assert.rejects(
				publisherRabbit.publish(live, 'MAIN', 0, 0),
				/MANDATORY_RETURN/
			);
		} finally {
			await inspectorChannel.bindQueue(
				TRANSFER_QUEUE,
				require('../../dist/src/widget-transfers/widget-transfer.messaging.js')
					.TRANSFER_EXCHANGE,
				TRANSFER_EVENT_TYPE
			);
		}
		await worker.beforeApplicationShutdown();
		worker = null;
		console.log(
			'Intake transfer RabbitMQ: upstream push, confirm/mandatory, durable database-delayed retry after publisher restart, duplicate proof, independent DLQ/manual retry and drain passed'
		);
	}
	console.log(
		'Intake transfer PG18: nullable WIDGET, atomic Inbox/snapshot/audit/receipt, scopes, export, revoke/disable/period/epoch, leases/retries, fault rollback and ACL passed'
	);
} catch (error) {
	console.error(
		'Intake transfer PG18 failed safely',
		JSON.stringify({
			phase,
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
		await worker?.beforeApplicationShutdown();
		await publisher?.beforeApplicationShutdown();
		await rabbit?.onApplicationShutdown();
		await publisherRabbit?.onApplicationShutdown();
		await provisionRabbit?.onApplicationShutdown();
		await inspectorChannel?.close();
		await inspector?.close();
		await migrator.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
				await tx.widgetEntrySnapshot.deleteMany({
					where: { workspaceId }
				});
				await tx.widgetTransferReceipt.deleteMany({
					where: { workspaceId }
				});
				await tx.widgetTransferOutbox.deleteMany({
					where: {
						payload: { path: ['workspaceId'], equals: workspaceId }
					}
				});
				await tx.exportAudit.deleteMany({ where: { workspaceId } });
				await tx.inboxEntry.deleteMany({ where: { workspaceId } });
				await tx.widgetControlOutbox.deleteMany({
					where: {
						payload: { path: ['workspaceId'], equals: workspaceId }
					}
				});
				await tx.widgetControlJob.deleteMany({ where: { workspaceId } });
				await tx.managedWidgetSource.deleteMany({
					where: { workspaceId }
				});
				await tx.intakeActivity.deleteMany({ where: { workspaceId } });
				await tx.intakeCommand.deleteMany({ where: { workspaceId } });
			},
			{ timeout: 10000 }
		);
	} catch (error) {
		console.error(
			'Intake transfer cleanup failed safely',
			JSON.stringify({ code: error?.code, sqlState: error?.meta?.code })
		);
		process.exitCode = 1;
	}
	await runtime.$disconnect();
	await migrator.$disconnect();
}
async function until(check) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('Widget transfer integration deadline exceeded');
}
