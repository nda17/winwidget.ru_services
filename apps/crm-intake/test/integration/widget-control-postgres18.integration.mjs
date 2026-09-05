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
	WidgetControlProcessor
} = require('../../dist/src/widget-sources/widget-control.processor.js');
const {
	WidgetsControlDependencyError
} = require('../../dist/src/widget-sources/widgets-control.client.js');
const {
	IntakeService
} = require('../../dist/src/intake/intake.service.js');
const {
	IntakeCsvImportService
} = require('../../dist/src/intake/intake-csv-import.service.js');
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
	foreignWorkspace = randomUUID(),
	teamId = randomUUID();
const context = {
	schemaVersion: 1,
	workspaceId,
	subject: 'a'.repeat(256),
	role: 'CRM_ADMIN',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['intake:read', 'intake:write', 'intake:manage-sources']
};
let delegated = true,
	canonicalOwner = 'owner',
	currentActor = context.subject,
	configureHook = null,
	loseResponse = false,
	failRpc = false;
let writes = 0,
	authCalls = 0;
const remote = new Map(),
	remoteReceipts = new Map();
const authorization = {
	authorize: async (_bearer, wsp) => ({
		...context,
		workspaceId: wsp,
		subject: currentActor
	}),
	authorizeWidgetSource: async (wsp, subject) => {
		authCalls++;
		if (!delegated) throw new ForbiddenException();
		assert.equal(subject, context.subject);
		return {
			...context,
			workspaceId: wsp,
			subject,
			ownerSubject: canonicalOwner
		};
	}
};
const widgets = {
	configure: async (id, command) => {
		if (failRpc) throw new ServiceUnavailableException();
		const prior = remoteReceipts.get(command.commandId);
		if (prior) {
			assert.deepEqual(prior.command, command);
			return prior.response;
		}
		const current = remote.get(id);
		if (current && current.controlVersion > command.controlVersion)
			throw new WidgetsControlDependencyError(
				409,
				'widgets_wincrm_control_stale'
			);
		const now = new Date().toISOString();
		const response = {
			schemaVersion: 1,
			connector: {
				id,
				workspaceId: command.workspaceId,
				sourceId: command.sourceId,
				ownerSubject: command.ownerSubject,
				widgetType: command.widgetType,
				widgetId: command.widgetId,
				controlVersion: command.controlVersion,
				generation: command.generation,
				enabled: command.enabled,
				enabledAt: command.enabled ? now : null,
				createdAt: current?.createdAt || now,
				updatedAt: now
			}
		};
		remote.set(id, response.connector);
		remoteReceipts.set(command.commandId, {
			command: structuredClone(command),
			response
		});
		writes++;
		if (configureHook) await configureHook(command);
		if (loseResponse) {
			loseResponse = false;
			throw new ServiceUnavailableException();
		}
		return response;
	},
	candidates: async () => {
		throw new Error('Not used by PG test');
	}
};
const config = { enabled: true };
const service = new WidgetSourceService(
		runtime,
		authorization,
		widgets,
		config
	),
	processor = new WidgetControlProcessor(runtime, authorization, widgets),
	manual = new IntakeService(runtime),
	csv = new IntakeCsvImportService(runtime);
const command = () => ({
	schemaVersion: 1,
	workspaceId,
	commandId: randomUUID()
});
const createCommand = () => ({
	...command(),
	name: 'PG source',
	widgetType: 'QUIZ',
	widgetId: 'widget-' + randomUUID(),
	teamId
});
async function intent(dto = createCommand()) {
	const result = await service.create('Bearer test', dto);
	const source = result.source;
	const row = await runtime.widgetControlJob.findUniqueOrThrow({
		where: { commandId: dto.commandId }
	});
	const event = (
		await runtime.widgetControlOutbox.findUniqueOrThrow({
			where: { deduplicationKey: row.activeEventId + ':main' }
		})
	).payload;
	return { dto, source, event };
}
async function eventFor(commandId) {
	const job = await runtime.widgetControlJob.findUniqueOrThrow({
		where: { commandId }
	});
	return (
		await runtime.widgetControlOutbox.findUniqueOrThrow({
			where: { deduplicationKey: job.activeEventId + ':main' }
		})
	).payload;
}
const http = status => error => error?.getStatus?.() === status;
const state = code => error =>
	error?.meta?.code === code || error?.code === code;
const count = () =>
	Promise.all([
		runtime.managedWidgetSource.count({ where: { workspaceId } }),
		runtime.widgetControlJob.count({ where: { workspaceId } }),
		runtime.intakeCommand.count({ where: { workspaceId } }),
		runtime.intakeActivity.count({ where: { workspaceId } }),
		runtime.widgetControlOutbox.count({
			where: { payload: { path: ['workspaceId'], equals: workspaceId } }
		})
	]);
let rabbit, worker, publisher, inspector, inspectorChannel;
let phase = 'acl';
try {
	const [role] = await runtime.$queryRawUnsafe(
		"SELECT current_user AS name,current_setting('server_version_num')::integer AS version,NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AS restricted FROM pg_roles WHERE rolname=current_user"
	);
	assert.equal(role.name, runtimeRole);
	assert.equal(role.restricted, true);
	assert.equal(Math.floor(role.version / 10000), 18);
	for (const table of [
		'managed_widget_sources',
		'widget_control_jobs',
		'widget_control_receipts'
	]) {
		const [acl] = await runtime.$queryRawUnsafe(
			"SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete,has_table_privilege(current_user,$1,'TRUNCATE') AS truncate",
			'crm_intake.' + table
		);
		assert.deepEqual(acl, {
			read: true,
			insert: true,
			update: true,
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
	phase = 'atomic-parallel-intent';
	const same = createCommand();
	const settled = await Promise.allSettled(
		Array.from({ length: 6 }, () => service.create('Bearer test', same))
	);
	const failed = settled.find(row => row.status === 'rejected');
	if (failed) throw failed.reason;
	const results = settled.map(row => row.value);
	for (const row of results) assert.deepEqual(row, results[0]);
	assert.deepEqual(await count(), [1, 1, 1, 1, 1]);
	const first = {
		source: results[0].source,
		event: await eventFor(same.commandId)
	};
	phase = 'global-command-namespace';
	await assert.rejects(
		manual.createManual(context, {
			...same,
			title: 'Manual',
			name: 'Name'
		}),
		http(409)
	);
	await assert.rejects(
		csv.create(context, {
			...same,
			label: 'CSV',
			teamId: null,
			rows: [
				{
					title: 'Row',
					name: 'Name',
					phone: null,
					email: null,
					message: null
				}
			]
		}),
		http(409)
	);
	const manualId = randomUUID();
	await manual.createManual(context, {
		schemaVersion: 1,
		workspaceId,
		commandId: manualId,
		title: 'Manual',
		name: 'Name'
	});
	await assert.rejects(
		service.create('Bearer test', {
			...createCommand(),
			commandId: manualId
		}),
		http(409)
	);
	phase = 'lease-and-replay';
	const initial = await processor.claim(first.event, 0);
	assert.equal(initial.state, 'CLAIMED');
	await assert.rejects(processor.claim(first.event, 0), http(503));
	await processor.run(first.event, initial.token);
	assert.equal(
		(await service.get('Bearer test', workspaceId, first.source.id)).source
			.syncState,
		'SYNCED'
	);
	const beforeWrites = writes;
	assert.equal((await processor.claim(first.event, 0)).state, 'DONE');
	assert.equal(writes, beforeWrites);
	const historic = await service.create('Bearer test', same);
	assert.equal(historic.source.syncState, 'PENDING');
	phase = 'tenant-scope';
	await assert.rejects(
		service.get('Bearer test', foreignWorkspace, first.source.id),
		http(404)
	);
	phase = 'historical-ack-race';
	const racing = await intent();
	const claim = await processor.claim(racing.event, 0);
	let disableCommand;
	configureHook = async () => {
		configureHook = null;
		disableCommand = { ...command(), expectedVersion: 1, enabled: false };
		await service.configure(
			'Bearer test',
			racing.source.id,
			disableCommand
		);
	};
	await processor.run(racing.event, claim.token);
	let localSource = await runtime.managedWidgetSource.findUniqueOrThrow({
		where: { id: racing.source.id }
	});
	assert.equal(localSource.enabled, false);
	assert.equal(localSource.controlVersion, 2);
	assert.equal(localSource.syncState, 'PENDING');
	assert.equal(localSource.appliedControlVersion, null);
	const disabling = await eventFor(disableCommand.commandId);
	delegated = false;
	const disabledClaim = await processor.claim(disabling, 0);
	const beforeAuth = authCalls;
	await processor.run(disabling, disabledClaim.token);
	assert.equal(authCalls, beforeAuth);
	assert.equal(remote.get(localSource.connectorId).enabled, false);
	delegated = true;
	phase = 'reenable-generation';
	currentActor = 'another-admin';
	await service.configure('Bearer test', racing.source.id, {
		...command(),
		expectedVersion: 2,
		enabled: true
	});
	currentActor = context.subject;
	localSource = await runtime.managedWidgetSource.findUniqueOrThrow({
		where: { id: racing.source.id }
	});
	assert.equal(localSource.generation, 2);
	assert.equal(localSource.createdBySubject, context.subject);
	phase = 'revoked-enable';
	const blocked = await intent();
	const blockedClaim = await processor.claim(blocked.event, 0);
	delegated = false;
	await assert.rejects(
		processor.run(blocked.event, blockedClaim.token),
		http(403)
	);
	await processor.fail(
		blocked.event,
		blockedClaim.token,
		0,
		new ForbiddenException()
	);
	assert.equal(
		(
			await runtime.managedWidgetSource.findUniqueOrThrow({
				where: { id: blocked.source.id }
			})
		).syncState,
		'BLOCKED'
	);
	delegated = true;
	phase = 'retry-same-command';
	const retryCommand = { ...command(), expectedVersion: 1 };
	await service.retry('Bearer test', blocked.source.id, retryCommand);
	const replayEvent = await eventFor(blocked.dto.commandId);
	assert.notEqual(replayEvent.eventId, blocked.event.eventId);
	assert.equal(replayEvent.commandId, blocked.event.commandId);
	const replayClaim = await processor.claim(replayEvent, 0);
	await processor.run(replayEvent, replayClaim.token);
	phase = 'lost-http-response';
	const lost = await intent();
	loseResponse = true;
	const lostClaim = await processor.claim(lost.event, 0);
	await assert.rejects(
		processor.run(lost.event, lostClaim.token),
		http(503)
	);
	const writesAfterLoss = writes;
	await processor.fail(
		lost.event,
		lostClaim.token,
		0,
		new ServiceUnavailableException()
	);
	const retried = await processor.claim(lost.event, 1);
	await processor.run(lost.event, retried.token);
	assert.equal(writes, writesAfterLoss);
	phase = 'expired-lease';
	const crashed = await intent();
	const crashedClaim = await processor.claim(crashed.event, 0);
	await runtime.$transaction(async tx => {
		await tx.widgetControlJob.update({
			where: { commandId: crashed.dto.commandId },
			data: { leaseUntil: new Date(Date.now() - 1000) }
		});
		await tx.widgetControlReceipt.update({
			where: {
				eventId_consumer: {
					eventId: crashed.event.eventId,
					consumer: 'crm-intake.widget-control.v1'
				}
			},
			data: { leaseUntil: new Date(Date.now() - 1000) }
		});
	});
	const recovered = await processor.claim(crashed.event, 0);
	assert.notEqual(recovered.token, crashedClaim.token);
	await assert.rejects(
		processor.run(crashed.event, crashedClaim.token),
		http(409)
	);
	await processor.run(crashed.event, recovered.token);
	phase = 'fault-rollback';
	for (const delegate of [
		'managedWidgetSource',
		'widgetControlJob',
		'widgetControlOutbox',
		'intakeCommand'
	]) {
		let reached = false;
		const before = await count();
		const faulty = new Proxy(runtime, {
			get(target, key) {
				if (key !== '$transaction') return target[key];
				return (callback, options) =>
					target.$transaction(
						tx =>
							callback(
								new Proxy(tx, {
									get(current, property) {
										if (property !== delegate) return current[property];
										return new Proxy(current[property], {
											get(model, method) {
												if (method !== 'create') return model[method];
												return async args => {
													await model.create(args);
													reached = true;
													throw new Error('INJECTED_AFTER_ACTUAL_INSERT');
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
			new WidgetSourceService(
				faulty,
				authorization,
				widgets,
				config
			).create('Bearer test', createCommand()),
			http(503)
		);
		assert.equal(reached, true);
		assert.deepEqual(await count(), before);
	}
	phase = 'immutable-bindings';
	await assert.rejects(
		runtime.managedWidgetSource.update({
			where: { id: localSource.id },
			data: { appliedGeneration: null }
		})
	);
	await assert.rejects(
		runtime.managedWidgetSource.update({
			where: { id: first.source.id },
			data: { ownerSubject: 'different' }
		})
	);
	await assert.rejects(
		runtime.widgetControlJob.update({
			where: { commandId: same.commandId },
			data: { actorSubject: 'different' }
		})
	);
	await assert.rejects(
		runtime.widgetControlReceipt.update({
			where: {
				eventId_consumer: {
					eventId: first.event.eventId,
					consumer: 'crm-intake.widget-control.v1'
				}
			},
			data: { status: 'FAILED' }
		})
	);
	await assert.rejects(
		runtime.managedWidgetSource.update({
			where: { id: first.source.id },
			data: {
				appliedControlVersion: null,
				appliedGeneration: null,
				syncedAt: null
			}
		})
	);
	const broker = process.env.CRM_INTAKE_WIDGET_CONTROL_TEST_RABBITMQ_URL;
	if (broker) {
		phase = 'real-rabbit';
		const url = new URL(broker);
		assert.ok(['amqp:', 'amqps:'].includes(url.protocol));
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.match(
			decodeURIComponent(url.pathname),
			/^\/[a-z0-9_-]+_(test|ci)$/
		);
		assert.ok(url.username && url.password);
		const { connect } = require('amqplib');
		const {
			WidgetControlRabbit,
			CONTROL_QUEUE,
			CONTROL_DEAD_QUEUE,
			CONTROL_EXCHANGE,
			CONTROL_EVENT_TYPE
		} = require('../../dist/src/widget-sources/widget-control.messaging.js');
		const {
			WidgetControlWorker
		} = require('../../dist/src/widget-sources/widget-control.worker.js');
		const {
			WidgetControlPublisher
		} = require('../../dist/src/widget-sources/widget-control.publisher.js');
		inspector = await connect(broker);
		inspectorChannel = await inspector.createChannel();
		process.env.CRM_INTAKE_RABBITMQ_URL = broker;
		process.env.CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY = 'true';
		rabbit = new WidgetControlRabbit();
		await rabbit.onModuleInit();
		for (const queue of [
			CONTROL_QUEUE,
			CONTROL_DEAD_QUEUE,
			...[1, 2, 3].map(i => CONTROL_QUEUE + '.retry.' + i)
		]) {
			const status = await inspectorChannel.checkQueue(queue);
			assert.equal(status.messageCount, 0);
			assert.equal(status.consumerCount, 0);
		}
		// Only already-exercised envelopes of this random test workspace are retired before the push phase.
		await runtime.widgetControlOutbox.updateMany({
			where: { payload: { path: ['workspaceId'], equals: workspaceId } },
			data: {
				status: 'PUBLISHED',
				publishedAt: new Date(),
				leaseToken: null,
				leaseUntil: null
			}
		});
		const live = await intent();
		worker = new WidgetControlWorker(processor, rabbit, runtime);
		publisher = new WidgetControlPublisher(runtime, rabbit);
		await worker.onApplicationBootstrap();
		assert.equal(rabbit.ready(true), true);
		await publisher.tick();
		await until(
			async () =>
				(
					await runtime.widgetControlJob.findUniqueOrThrow({
						where: { commandId: live.dto.commandId }
					})
				).status === 'APPLIED'
		);
		const writesBeforeDuplicate = writes;
		await rabbit.publish(live.event, 'MAIN', 0);
		await until(
			async () =>
				(await inspectorChannel.checkQueue(CONTROL_QUEUE)).messageCount ===
				0
		);
		assert.equal(writes, writesBeforeDuplicate);
		await inspectorChannel.unbindQueue(
			CONTROL_QUEUE,
			CONTROL_EXCHANGE,
			CONTROL_EVENT_TYPE
		);
		try {
			await assert.rejects(
				rabbit.publish(live.event, 'MAIN', 0),
				/MANDATORY_RETURN/
			);
		} finally {
			await inspectorChannel.bindQueue(
				CONTROL_QUEUE,
				CONTROL_EXCHANGE,
				CONTROL_EVENT_TYPE
			);
		}
		await worker.beforeApplicationShutdown();
		worker = null;
		console.log(
			'Intake widget control real RabbitMQ: push consume, confirm+mandatory, replay, receipt and drain passed'
		);
	}
	console.log(
		'Intake widget control PG18: atomic source/receipt/outbox, namespace, CAS, late ack, disable, generation, fresh authority, HTTP replay, lease recovery and rollback passed'
	);
} catch (error) {
	console.error(
		'Intake widget control PG18 failed safely',
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
		await inspectorChannel?.close();
		await inspector?.close();
		await migrator.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
				await tx.widgetControlReceipt.deleteMany({
					where: { workspaceId }
				});
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
				await tx.inboxEntry.deleteMany({ where: { workspaceId } });
			},
			{ timeout: 10000 }
		);
	} catch (error) {
		console.error(
			'Intake widget control cleanup failed safely',
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
	throw new Error('Widget control integration deadline exceeded');
}
