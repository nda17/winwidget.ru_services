import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
	nativeWidgetHttpCase,
	NATIVE_WIDGET_HTTP_TYPES
} from './local-native-widget-http.integration.mjs';
import {
	NATIVE_IMAGE_ROLES,
	NATIVE_TRANSFER_EVENT,
	NATIVE_TRANSFER_QUEUE,
	NATIVE_CONTROL_QUEUE,
	NATIVE_CONTROL_EVENT
} from './local-native-images.mjs';
import {
	changeNativeMember,
	verifyNativeInboxScope,
	verifyNativeInboxAcceptance
} from './local-native-inbox-workflow.mjs';

export function assertPendingWidgetControlRetry({
	job,
	receipt,
	outbox,
	original
}) {
	assert.equal(job.status, 'PENDING');
	assert.equal(job.lastErrorCode, 'DEPENDENCY_UNAVAILABLE');
	assert.equal(receipt.status, 'FAILED');
	assert.equal(receipt.retryAttempt, 0);
	assert.equal(receipt.consumer, 'crm-intake.widget-control.v1');
	assert.equal(outbox.status, 'PENDING');
	assert.equal(outbox.route, 'MAIN');
	assert.equal(outbox.retryAttempt, 1);
	assert.equal(outbox.publishedAt, null);
	assert.equal(outbox.lastErrorCode, 'DEPENDENCY_UNAVAILABLE');
	assert.notEqual(outbox.id, original.id);
	assert.deepEqual(outbox.payload, original.payload);
	assert.equal(outbox.eventId, original.eventId);
	assert.equal(outbox.eventId, outbox.payload.eventId);
	assert.equal(job.activeEventId, outbox.eventId);
	assert.equal(receipt.eventId, outbox.eventId);
	for (const field of ['commandId', 'sourceId', 'workspaceId']) {
		assert.equal(job[field], outbox.payload[field]);
		assert.equal(receipt[field], outbox.payload[field]);
	}
	const delay = outbox.availableAt.getTime() - outbox.createdAt.getTime();
	assert.ok(
		delay >= 4000 && delay <= 6000,
		'Real first control retry retains its five-second deadline'
	);
}

// Business commands go only through actual API images. Prisma below observes
// service-owned test data; no processor/publisher/consumer class is instantiated.
export async function verifyNativeImages({
	runtime,
	servicesRoot,
	runId,
	apiUrl,
	account,
	managerAccount,
	foreignAccount,
	prepareTeamFixtures,
	widgets,
	widgetsDatabaseUrl,
	intakeDatabaseUrl,
	serviceEnvironment
}) {
	const widgetsRequire = createRequire(
		join(servicesRoot, 'apps/widgets/package.json')
	);
	const intakeRequire = createRequire(
		join(servicesRoot, 'apps/crm-intake/package.json')
	);
	const widgetsDb = new (widgetsRequire(
		'@prisma/widgets-client'
	).PrismaClient)({
		datasources: { db: { url: widgetsDatabaseUrl } },
		log: []
	});
	const intakeDb = new (intakeRequire(
		'@prisma/crm-intake-client'
	).PrismaClient)({
		datasources: { db: { url: intakeDatabaseUrl } },
		log: []
	});
	const fixtures = [widgets, ...(widgets.additionalWidgets || [])];
	assert.deepEqual(
		fixtures.map(widget => widget.widgetType),
		NATIVE_WIDGET_HTTP_TYPES
	);
	assert.equal(account.userId, 'wincrm-local-owner-' + runId);
	assert.equal(apiUrl, 'http://localhost:4100/api/v1');
	let phase = 'normal-login';
	let token;
	let managerToken;
	let leadSequence = 0;
	const submissions = [];
	const evidence = [];
	const sourceTokens = new Map();
	const controlConflictRecoveries = [];
	const stage = value => {
		phase = value;
		runtime.stage = value;
		runtime.log('Native image phase: ' + value);
	};
	const request = async (
		path,
		{
			body,
			expected = 200,
			base = apiUrl,
			anonymous = false,
			actorToken = token
		} = {}
	) => {
		const response = await fetch(base + path, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(!anonymous && actorToken
					? { authorization: 'Bearer ' + actorToken }
					: {}),
				...(body?.commandId ? { 'idempotency-key': body.commandId } : {}),
				origin: 'http://localhost:3000'
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			const error = new Error('Native image HTTP contract mismatch');
			error.nativeHttpStatus = response.status;
			throw error;
		}
		const data = await response.text();
		assert.ok(data.length <= 512 * 1024, 'Native HTTP response bound');
		return JSON.parse(data);
	};
	const broker = async callback => {
		const connection = await runtime.amqp.connect(runtime.provisionerUrl, {
			timeout: 5000
		});
		connection.on('error', () => {});
		try {
			const channel = await connection.createConfirmChannel();
			return await callback(channel);
		} finally {
			await connection.close();
		}
	};
	const queueRows = async () =>
		JSON.parse(
			await runtime.ctl([
				'list_queues',
				'-p',
				runtime.vhost,
				'name',
				'messages_ready',
				'messages_unacknowledged',
				'consumers',
				'--formatter=json'
			])
		);
	const settleQueues = async () =>
		runtime.wait(async () => {
			const rows = await queueRows();
			return [NATIVE_TRANSFER_QUEUE, NATIVE_CONTROL_QUEUE].every(name =>
				rows.some(
					row =>
						row.name === name &&
						row.messages_ready === 0 &&
						row.messages_unacknowledged === 0 &&
						row.consumers === 1
				)
			);
		}, 'Native push consumers did not drain');
	const publishReplay = async (payload, messageId = payload.eventId) => {
		// Fault injector repeats an immutable published event using only the real
		// Widgets publisher principal, not Management HTTP or a business mutation.
		const connection = await runtime.amqp.connect(
			runtime.brokerUrls.get('widgets-publisher')
		);
		connection.on('error', () => {});
		try {
			const channel = await connection.createConfirmChannel();
			let returned = false;
			channel.on('return', () => {
				returned = true;
			});
			await new Promise((resolve, reject) =>
				channel.publish(
					'winwidget.events',
					NATIVE_TRANSFER_EVENT,
					Buffer.from(JSON.stringify(payload)),
					{
						persistent: true,
						mandatory: true,
						contentType: 'application/json',
						type: NATIVE_TRANSFER_EVENT,
						messageId
					},
					error =>
						error
							? reject(new Error('Native replay confirm failed'))
							: resolve()
				)
			);
			await channel.waitForConfirms();
			assert.equal(returned, false, 'Native replay was unroutable');
			await channel.close();
		} finally {
			await connection.close();
		}
	};
	const submit = async widget => {
		const definition = nativeWidgetHttpCase(widget.widgetType);
		const phone = '+7900000' + String(++leadSequence).padStart(4, '0');
		const reply = await request(
			'/' + definition.publicApi + '/' + widget.publicKey + '/lead',
			{
				base: 'http://127.0.0.1:4700/api/v1',
				anonymous: true,
				expected: 201,
				body: {
					phone,
					...definition.lead,
					url: 'http://localhost:3000/native-images?synthetic=true#fragment'
				}
			}
		);
		assert.equal(reply.success, true);
		const intent = await widgetsDb.wincrmTransferIntent.findFirstOrThrow({
			where: { connectorId: widget.connectorId, leadId: reply.lead.id }
		});
		assert.equal(intent.state, 'READY');
		const outbox = await widgetsDb.widgetsOutboxEvent.findFirstOrThrow({
			where: {
				messageId: intent.eventId,
				eventType: NATIVE_TRANSFER_EVENT
			}
		});
		assert.equal(outbox.payload.transferId, intent.id);
		assert.equal(outbox.payload.workspaceId, account.workspaceId);
		const result = {
			widget,
			phone,
			definition,
			intent,
			outbox,
			leadId: reply.lead.id
		};
		submissions.push(result);
		return result;
	};
	const delivered = async submission => {
		const receipt = await runtime.wait(async () => {
			const row = await intakeDb.widgetTransferReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: submission.intent.eventId,
						consumer: 'crm-intake.widget-transfer.v1'
					}
				}
			});
			return row?.status === 'DELIVERED' && row;
		}, 'Native image delivery deadline');
		await runtime.wait(
			async () =>
				(
					await widgetsDb.widgetsOutboxEvent.findUniqueOrThrow({
						where: { id: submission.outbox.id }
					})
				).status === 'PUBLISHED',
			'Widgets image did not confirm Outbox publication'
		);
		const snapshot = await intakeDb.widgetEntrySnapshot.findUniqueOrThrow({
			where: { entryId: receipt.entryId }
		});
		assert.deepEqual(snapshot.payload, submission.intent.payload);
		assert.equal(snapshot.transferId, submission.intent.id);
		const suffix = '?workspaceId=' + account.workspaceId;
		const detail = await request(
			'/crm/intake/inbox/' + receipt.entryId + suffix
		);
		assert.equal(detail.entry.origin, 'WIDGET');
		assert.equal(detail.entry.phone, submission.phone);
		assert.equal(detail.entry.sourceId, submission.widget.sourceId);
		assert.equal(detail.entry.name, null);
		const full = await request(
			'/crm/intake/inbox/' + receipt.entryId + '/widget-details' + suffix
		);
		assert.deepEqual(full.payload, snapshot.payload);
		assert.equal(full.payload.widget.type, submission.widget.widgetType);
		assert.equal(full.payload.details.type, submission.widget.widgetType);
		assert.equal(
			full.payload.lead.pageUrl,
			'http://localhost:3000/native-images'
		);
		assert.deepEqual(full.payload.lead.redactions, [
			'URL_QUERY_REMOVED',
			'URL_FRAGMENT_REMOVED'
		]);
		if (submission.widget.widgetType === 'CALCULATOR')
			assert.equal(full.payload.details.calculatedPrice, '1700.00');
		if (submission.widget.widgetType === 'WHEEL')
			assert.equal(
				full.payload.details.bonus,
				submission.definition.lead.bonus
			);
		if (submission.widget.widgetType === 'CALLBACK')
			assert.equal(
				full.payload.details.timeSlot,
				submission.definition.lead.timeSlot
			);
		assert.equal(
			await intakeDb.widgetTransferReceipt.count({
				where: { eventId: submission.intent.eventId }
			}),
			1
		);
		assert.equal(
			await intakeDb.widgetEntrySnapshot.count({
				where: { transferId: submission.intent.id }
			}),
			1
		);
		return receipt;
	};
	const publisherId = () => runtime.processes.get('widgets-publisher').id;
	const restart = async label => {
		const process = runtime.processes.get(label);
		await runtime.inspect(process.id);
		await runtime.docker(['start', process.id]);
		await runtime.docker([
			'update',
			'--restart=unless-stopped',
			process.id
		]);
		await runtime.wait(async () => {
			try {
				const response = await fetch(
					'http://127.0.0.1:' + process.port + '/health/ready',
					{ signal: AbortSignal.timeout(2000) }
				);
				await response.body?.cancel();
				return response.status === 200;
			} catch {
				return false;
			}
		}, 'Native image restart readiness deadline');
	};
	try {
		const session = await request('/auth/login', {
			anonymous: true,
			body: { email: account.email, password: account.password }
		});
		assert.equal(session.user.id, account.userId);
		token = session.accessToken;
		assert.ok(typeof token === 'string' && token.length > 100);
		await prepareTeamFixtures();
		managerToken = (
			await request('/auth/login', {
				anonymous: true,
				body: {
					email: managerAccount.email,
					password: managerAccount.password
				}
			})
		).accessToken;
		assert.ok(
			typeof managerToken === 'string' && managerToken.length > 100
		);
		await changeNativeMember(
			request,
			account.workspaceId,
			managerAccount.crmMemberId,
			{ role: 'CRM_ADMIN' }
		);
		stage('six-explicit-managed-connections');
		const candidates = await request(
			'/crm/intake/widget-sources/candidates?workspaceId=' +
				account.workspaceId +
				'&page=1&pageSize=25'
		);
		assert.equal(candidates.eligibility.plan, 'EASY');
		assert.equal(candidates.items.length, 6);
		for (const [index, widget] of fixtures.entries()) {
			sourceTokens.set(
				widget.widgetType,
				index % 2 ? managerToken : token
			);
			widget.creatorSubject =
				index % 2 ? managerAccount.userId : account.userId;
			const command = {
				schemaVersion: 1,
				workspaceId: account.workspaceId,
				commandId: randomUUID(),
				name: 'Image proof ' + widget.widgetType,
				widgetType: widget.widgetType,
				widgetId: widget.widgetId,
				teamId: managerAccount.crmTeamId
			};
			const created = await request('/crm/intake/widget-sources', {
				body: command,
				actorToken: sourceTokens.get(widget.widgetType),
				expected: 202
			});
			assert.equal(created.command.state, 'QUEUED');
			assert.equal(created.source.syncState, 'PENDING');
			widget.sourceId = created.source.id;
			widget.controlCommand = command;
			widget.queuedResponse = created;
			const job = await intakeDb.widgetControlJob.findUniqueOrThrow({
				where: { commandId: command.commandId }
			});
			widget.connectorId = job.connectorId;
		}
		assert.equal(
			await intakeDb.widgetControlOutbox.count({
				where: { status: 'PENDING' }
			}),
			6
		);
		stage('control-durable-retry-dependency-outage');
		const controlRoles = NATIVE_IMAGE_ROLES.filter(item =>
			item[2].startsWith('widget-control')
		);
		const controlPublisher = controlRoles.find(item =>
			item[2].endsWith('publisher')
		);
		const controlWorker = controlRoles.find(item =>
			item[2].endsWith('worker')
		);
		const initialControlOutbox =
			await intakeDb.widgetControlOutbox.findMany({
				where: { route: 'MAIN', retryAttempt: 0 },
				orderBy: { id: 'asc' }
			});
		assert.equal(initialControlOutbox.length, 6);
		// Publish the six initial commands first, then stop the publisher so the
		// five-second retries remain observable across the controlled restart.
		await runtime.startNativeRole(
			controlPublisher,
			serviceEnvironment('crm-intake')
		);
		await runtime.wait(
			async () =>
				(await intakeDb.widgetControlOutbox.count({
					where: { status: 'PUBLISHED' }
				})) === 6,
			'Initial control commands were not confirmed'
		);
		await runtime.stop(runtime.processes.get(controlPublisher[0]).id);
		await runtime.stop(runtime.processes.get('widgets').id);
		await runtime.startNativeRole(
			controlWorker,
			serviceEnvironment('crm-intake')
		);
		const controlRetries = await runtime.wait(async () => {
			const rows = await intakeDb.widgetControlOutbox.findMany({
				where: { route: 'MAIN', retryAttempt: 1 },
				orderBy: { id: 'asc' }
			});
			return (
				rows.length === 6 &&
				rows.every(row => row.status === 'PENDING') &&
				rows
			);
		}, 'Six control dependency failures did not create durable retries');
		for (const outbox of controlRetries) {
			const job = await intakeDb.widgetControlJob.findUniqueOrThrow({
				where: { commandId: outbox.payload.commandId }
			});
			const receipt =
				await intakeDb.widgetControlReceipt.findUniqueOrThrow({
					where: {
						eventId_consumer: {
							eventId: outbox.eventId,
							consumer: 'crm-intake.widget-control.v1'
						}
					}
				});
			assertPendingWidgetControlRetry({
				job,
				receipt,
				outbox,
				original: initialControlOutbox.find(
					row => row.eventId === outbox.eventId
				)
			});
		}
		assert.equal(await widgetsDb.wincrmConnector.count(), 0);
		stage('control-durable-retry-process-and-broker-restart');
		await runtime.stop(runtime.processes.get(controlWorker[0]).id);
		await runtime.stop(runtime.brokerId);
		for (const outbox of controlRetries)
			assert.deepEqual(
				await intakeDb.widgetControlOutbox.findUniqueOrThrow({
					where: { id: outbox.id }
				}),
				outbox
			);
		await restart('widgets');
		await runtime.docker(['start', runtime.brokerId]);
		await runtime.wait(
			async () =>
				(
					await runtime.command('docker', [
						'--context',
						'colima',
						'exec',
						'--user=rabbitmq',
						runtime.brokerId,
						'rabbitmq-diagnostics',
						'-q',
						'check_port_connectivity'
					])
				).code === 0,
			'Control broker restart deadline'
		);
		await restart(controlWorker[0]);
		await restart(controlPublisher[0]);
		const settledSources = await runtime.wait(async () => {
			const rows = await intakeDb.managedWidgetSource.findMany({
				where: { workspaceId: account.workspaceId }
			});
			return (
				rows.length === 6 &&
				rows.every(row =>
					['SYNCED', 'BLOCKED', 'ERROR'].includes(row.syncState)
				) &&
				rows
			);
		}, 'Initial control commands did not reach an observable outcome');
		for (const source of settledSources.filter(
			row => row.syncState !== 'SYNCED'
		)) {
			assert.equal(source.syncState, 'BLOCKED');
			assert.equal(source.lastErrorCode, 'CONTROL_CONFLICT');
			const command = {
				schemaVersion: 1,
				workspaceId: account.workspaceId,
				commandId: randomUUID(),
				expectedVersion: source.version
			};
			const path = '/crm/intake/widget-sources/' + source.id + '/retry';
			const reply = await request(path, { body: command, expected: 202 });
			assert.equal(reply.command.state, 'QUEUED');
			await runtime.wait(
				async () =>
					(
						await intakeDb.managedWidgetSource.findUniqueOrThrow({
							where: { id: source.id }
						})
					).syncState === 'SYNCED',
				'One explicit versioned control retry did not recover'
			);
			assert.deepEqual(
				await request(path, { body: command, expected: 202 }),
				reply
			);
			controlConflictRecoveries.push(source.currentCommandId);
		}
		await runtime.wait(
			async () =>
				(await intakeDb.managedWidgetSource.count({
					where: {
						workspaceId: account.workspaceId,
						syncState: 'SYNCED',
						enabled: true
					}
				})) === 6,
			'Container control workflow did not synchronize six sources'
		);
		await runtime.wait(
			async () =>
				(await intakeDb.widgetControlOutbox.count({
					where: { status: 'PUBLISHED', route: 'MAIN' }
				})) ===
				6 + controlRetries.length + controlConflictRecoveries.length,
			'Control publisher did not confirm six commands'
		);
		for (const original of controlRetries) {
			const published =
				await intakeDb.widgetControlOutbox.findUniqueOrThrow({
					where: { id: original.id }
				});
			assert.equal(published.status, 'PUBLISHED');
			assert.equal(
				published.availableAt.getTime(),
				original.availableAt.getTime()
			);
			assert.ok(
				published.publishedAt.getTime() >= original.availableAt.getTime()
			);
			assert.deepEqual(published.payload, original.payload);
			assert.equal(published.eventId, original.eventId);
			assert.equal(published.retryAttempt, original.retryAttempt);
			assert.equal(published.route, 'MAIN');
		}
		stage('control-committed-event-replay');
		const controlQuiet = () =>
			runtime.wait(async () => {
				if (
					await intakeDb.widgetControlOutbox.count({
						where: { status: { not: 'PUBLISHED' } }
					})
				)
					return false;
				if (
					await intakeDb.widgetControlJob.count({
						where: { status: { in: ['PENDING', 'PROCESSING'] } }
					})
				)
					return false;
				return (await queueRows()).some(
					row =>
						row.name === NATIVE_CONTROL_QUEUE &&
						row.messages_ready === 0 &&
						row.messages_unacknowledged === 0 &&
						row.consumers === 1
				);
			}, 'Control durable work did not drain');
		await controlQuiet();
		const controlSnapshot = async () => ({
			jobs: await intakeDb.widgetControlJob.findMany({
				orderBy: { commandId: 'asc' }
			}),
			receipts: await intakeDb.widgetControlReceipt.findMany({
				orderBy: { eventId: 'asc' }
			}),
			outbox: await intakeDb.widgetControlOutbox.findMany({
				orderBy: { id: 'asc' }
			}),
			sources: await intakeDb.managedWidgetSource.findMany({
				orderBy: { id: 'asc' }
			}),
			connectors: await widgetsDb.wincrmConnector.findMany({
				orderBy: { id: 'asc' }
			}),
			commands: await widgetsDb.wincrmConnectorCommand.findMany({
				orderBy: { commandId: 'asc' }
			})
		});
		const beforeControlReplay = await controlSnapshot();
		const appliedControlRetries = controlRetries.filter(outbox =>
			beforeControlReplay.receipts.some(
				row =>
					row.eventId === outbox.eventId &&
					row.status === 'DELIVERED' &&
					row.retryAttempt === 1
			)
		);
		assert.ok(
			appliedControlRetries.length > 0,
			'At least one delayed control must be applied without manual conflict recovery'
		);
		const replayConnection = await runtime.amqp.connect(
			runtime.brokerUrls.get(controlPublisher[0])
		);
		replayConnection.on('error', () => {});
		try {
			const channel = await replayConnection.createConfirmChannel();
			let returned = false;
			channel.on('return', () => {
				returned = true;
			});
			for (const outbox of appliedControlRetries)
				for (const retryAttempt of [0, 1])
					channel.publish(
						'winwidget.crm-intake.widget-control.events',
						NATIVE_CONTROL_EVENT,
						Buffer.from(JSON.stringify(outbox.payload)),
						{
							contentType: 'application/json',
							persistent: true,
							mandatory: true,
							messageId: outbox.eventId,
							type: NATIVE_CONTROL_EVENT,
							headers: { 'x-retry-attempt': retryAttempt }
						}
					);
			await channel.waitForConfirms();
			assert.equal(
				returned,
				false,
				'Committed control replay was unroutable'
			);
			await channel.close();
		} finally {
			await replayConnection.close();
		}
		await controlQuiet();
		assert.deepEqual(await controlSnapshot(), beforeControlReplay);
		for (const widget of fixtures) {
			assert.deepEqual(
				await request('/crm/intake/widget-sources', {
					body: widget.controlCommand,
					actorToken: sourceTokens.get(widget.widgetType),
					expected: 202
				}),
				widget.queuedResponse
			);
			assert.equal(
				(
					await widgetsDb.wincrmConnector.findUniqueOrThrow({
						where: { id: widget.connectorId }
					})
				).enabled,
				true
			);
		}
		stage('six-real-public-submissions');
		for (const widget of fixtures) await submit(widget);
		assert.equal(
			await widgetsDb.widgetsOutboxEvent.count({
				where: { status: 'PENDING' }
			}),
			12
		);
		assert.equal(await intakeDb.widgetTransferReceipt.count(), 0);
		for (const spec of NATIVE_IMAGE_ROLES.filter(
			item =>
				item[2].startsWith('widget-transfer') || item[1] === 'widgets'
		))
			await runtime.startNativeRole(spec, serviceEnvironment(spec[1]));
		for (const submission of submissions) {
			const receipt = await delivered(submission);
			evidence.push({
				widgetType: submission.widget.widgetType,
				eventId: submission.intent.eventId,
				transferId: submission.intent.id,
				entryId: receipt.entryId
			});
		}
		await settleQueues();
		const transferOutboxBeforeReplay =
			await intakeDb.widgetTransferOutbox.findMany({
				orderBy: { id: 'asc' }
			});
		assert.ok(
			transferOutboxBeforeReplay.every(
				row => row.route === 'MAIN' && row.status === 'PUBLISHED'
			)
		);
		stage('at-least-once-replay');
		for (const submission of submissions)
			await publishReplay(submission.outbox.payload);
		await settleQueues();
		for (const submission of submissions) await delivered(submission);
		assert.equal(
			await intakeDb.inboxEntry.count({
				where: { workspaceId: account.workspaceId, origin: 'WIDGET' }
			}),
			6
		);
		assert.deepEqual(
			await intakeDb.widgetTransferOutbox.findMany({
				orderBy: { id: 'asc' }
			}),
			transferOutboxBeforeReplay
		);

		stage('mandatory-return-recovery');
		await broker(channel =>
			channel.unbindQueue(
				NATIVE_TRANSFER_QUEUE,
				'winwidget.events',
				NATIVE_TRANSFER_EVENT
			)
		);
		const unroutable = await submit(fixtures[0]);
		await runtime.wait(async () => {
			const row = await widgetsDb.widgetsOutboxEvent.findUniqueOrThrow({
				where: { id: unroutable.outbox.id }
			});
			assert.notEqual(
				row.status,
				'PUBLISHED',
				'Unroutable native event was incorrectly marked published'
			);
			return row.attempts > 0 && row.publishedAt === null;
		}, 'Mandatory return did not leave retryable Outbox evidence');
		await broker(channel =>
			channel.bindQueue(
				NATIVE_TRANSFER_QUEUE,
				'winwidget.events',
				NATIVE_TRANSFER_EVENT
			)
		);
		await delivered(unroutable);
		await settleQueues();

		stage('broker-outage-and-reconnect');
		await runtime.stop(runtime.brokerId);
		const offline = await submit(fixtures[1]);
		assert.notEqual(
			(
				await widgetsDb.widgetsOutboxEvent.findUniqueOrThrow({
					where: { id: offline.outbox.id }
				})
			).status,
			'PUBLISHED'
		);
		await runtime.docker(['start', runtime.brokerId]);
		await runtime.wait(
			async () =>
				(
					await runtime.command('docker', [
						'--context',
						'colima',
						'exec',
						'--user=rabbitmq',
						runtime.brokerId,
						'rabbitmq-diagnostics',
						'-q',
						'check_port_connectivity'
					])
				).code === 0,
			'Broker recovery deadline'
		);
		await delivered(offline);
		await settleQueues();

		stage('worker-crash-during-processing-lease');
		await runtime.stop(publisherId());
		const crashed = await submit(fixtures[2]);
		const widgetsApi = runtime.processes.get('widgets');
		const worker = runtime.processes.get(
			'crm-intake-widget-transfer-worker'
		);
		await runtime.inspect(widgetsApi.id);
		await runtime.docker(['pause', widgetsApi.id]);
		await restart('widgets-publisher');
		const claimed = await runtime.wait(async () => {
			const row = await intakeDb.widgetTransferReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: crashed.intent.eventId,
						consumer: 'crm-intake.widget-transfer.v1'
					}
				}
			});
			return row?.status === 'PROCESSING' && row.leaseToken && row;
		}, 'No real processing claim observed before crash');
		await runtime.inspect(worker.id);
		await runtime.docker(['update', '--restart=no', worker.id]);
		// Intentional fault injection targets only this exact disposable consumer.
		await runtime.docker(['kill', '--signal=KILL', worker.id]);
		assert.equal((await runtime.inspect(worker.id)).State.Running, false);
		await runtime.docker(['unpause', widgetsApi.id]);
		await restart('crm-intake-widget-transfer-worker');
		const recovered = await delivered(crashed);
		assert.ok(
			recovered.version > claimed.version,
			'Lease recovery did not advance CAS version'
		);
		await settleQueues();

		stage('transfer-retry-exhaustion-dlq-and-versioned-http-recovery');
		await runtime.stop(publisherId());
		const retried = await submit(fixtures[4]);
		await runtime.inspect(widgetsApi.id);
		await runtime.docker(['pause', widgetsApi.id]);
		await restart('widgets-publisher');
		const exhausted = await runtime.wait(
			async () => {
				const row = await intakeDb.widgetTransferReceipt.findUnique({
					where: {
						eventId_consumer: {
							eventId: retried.intent.eventId,
							consumer: 'crm-intake.widget-transfer.v1'
						}
					}
				});
				return row?.status === 'ERROR' && row;
			},
			'Real 5/30/120-second retry schedule did not reach ERROR',
			240000
		);
		assert.equal(exhausted.retryAttempt, 3);
		assert.equal(exhausted.retryGeneration, 0);
		assert.equal(exhausted.lastErrorCode, 'DEPENDENCY_UNAVAILABLE');
		const failedOutbox = await runtime.wait(async () => {
			const rows = await intakeDb.widgetTransferOutbox.findMany({
				where: { eventId: retried.intent.eventId },
				orderBy: { retryAttempt: 'asc' }
			});
			return (
				rows.length === 4 &&
				rows.every(row => row.status === 'PUBLISHED') &&
				rows
			);
		}, 'Automatic retry/DLQ Outbox did not confirm');
		assert.deepEqual(
			failedOutbox
				.filter(row => row.route === 'MAIN')
				.map(row => row.retryAttempt),
			[1, 2, 3]
		);
		const deadTransfer = failedOutbox.filter(row => row.route === 'DLQ');
		assert.equal(deadTransfer.length, 1);
		assert.equal(
			await intakeDb.widgetEntrySnapshot.count({
				where: { transferId: retried.intent.id }
			}),
			0
		);
		await runtime.docker(['unpause', widgetsApi.id]);
		const transferPublisher = runtime.processes.get(
			'crm-intake-widget-transfer-publisher'
		);
		await runtime.stop(transferPublisher.id);
		const retryPath =
			'/crm/intake/widget-sources/' +
			retried.widget.sourceId +
			'/transfers/' +
			retried.intent.id +
			'/retry';
		const retryCommand = {
			schemaVersion: 1,
			workspaceId: account.workspaceId,
			commandId: randomUUID(),
			expectedVersion: exhausted.version
		};
		const retryReply = await request(retryPath, {
			body: retryCommand,
			expected: 202
		});
		assert.equal(retryReply.command.state, 'QUEUED');
		assert.equal(retryReply.transfer.state, 'RETRY_PENDING');
		assert.deepEqual(
			await request(retryPath, { body: retryCommand, expected: 202 }),
			retryReply
		);
		await request(retryPath, {
			body: { ...retryCommand, commandId: randomUUID() },
			expected: 409
		});
		const queuedRetry = await intakeDb.widgetTransferOutbox.findMany({
			where: { eventId: retried.intent.eventId, retryGeneration: 1 }
		});
		assert.equal(queuedRetry.length, 1);
		assert.equal(queuedRetry[0].status, 'PENDING');
		assert.equal(queuedRetry[0].route, 'MAIN');
		assert.equal(
			await intakeDb.intakeCommand.count({
				where: { commandId: retryCommand.commandId }
			}),
			1
		);
		assert.equal(
			await intakeDb.intakeActivity.count({
				where: {
					commandId: retryCommand.commandId,
					action: 'WIDGET_TRANSFER_RETRY_QUEUED'
				}
			}),
			1
		);
		await restart('crm-intake-widget-transfer-publisher');
		const retriedReceipt = await delivered(retried);
		assert.equal(retriedReceipt.retryGeneration, 1);
		await settleQueues();
		await publishReplay(retried.outbox.payload);
		await settleQueues();
		assert.equal(
			(await delivered(retried)).entryId,
			retriedReceipt.entryId
		);
		assert.deepEqual(
			await request(retryPath, { body: retryCommand, expected: 202 }),
			retryReply
		);
		await broker(async channel => {
			let observed = false;
			await channel.consume(
				NATIVE_TRANSFER_QUEUE + '.dead-letter',
				message => {
					if (
						message?.properties.messageId === retried.intent.eventId &&
						message.properties.headers?.[
							'x-wincrm-transfer-retry-generation'
						] === 0
					) {
						observed = true;
						channel.ack(message);
					}
				},
				{ noAck: false }
			);
			await runtime.wait(
				async () => observed,
				'Expected exhausted transfer DLQ evidence missing'
			);
			await channel.close();
		});

		stage('explicit-revocation-preserves-received-data');
		await runtime.stop(publisherId());
		const revoked = await submit(fixtures[3]);
		const before = await intakeDb.managedWidgetSource.findUniqueOrThrow({
			where: { id: fixtures[3].sourceId }
		});
		await request(
			'/crm/intake/widget-sources/' + before.id + '/configure',
			{
				expected: 202,
				body: {
					schemaVersion: 1,
					workspaceId: account.workspaceId,
					commandId: randomUUID(),
					expectedVersion: before.version,
					enabled: false
				}
			}
		);
		await runtime.wait(async () => {
			const row = await intakeDb.managedWidgetSource.findUniqueOrThrow({
				where: { id: before.id }
			});
			return row.syncState === 'SYNCED' && row.enabled === false;
		}, 'Revocation control command did not synchronize');
		await restart('widgets-publisher');
		await runtime.wait(async () => {
			const row = await intakeDb.widgetTransferReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: revoked.intent.eventId,
						consumer: 'crm-intake.widget-transfer.v1'
					}
				}
			});
			return (
				row?.status === 'SKIPPED' && row.lastErrorCode === 'LOCAL_DISABLED'
			);
		}, 'Pending lead was not fenced by explicit revocation');
		const original = evidence.find(item => item.widgetType === 'TIMER');
		assert.equal(
			(
				await request(
					'/crm/intake/inbox/' +
						original.entryId +
						'?workspaceId=' +
						account.workspaceId
				)
			).entry.origin,
			'WIDGET'
		);
		assert.equal(
			await intakeDb.widgetEntrySnapshot.count({
				where: { transferId: revoked.intent.id }
			}),
			0
		);
		await settleQueues();

		stage('natural-subscription-expiry-preserves-received-snapshots');
		await runtime.stop(publisherId());
		const expired = await submit(fixtures[5]);
		const deadline = Date.parse(expired.outbox.payload.originalDeadline);
		assert.ok(deadline > Date.now() && deadline <= Date.now() + 8 * 60000);
		await runtime.wait(
			async () => Date.now() > deadline + 50,
			'Natural subscription expiry deadline',
			8 * 60000 + 1000
		);
		await restart('widgets-publisher');
		await runtime.wait(async () => {
			const row = await intakeDb.widgetTransferReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: expired.intent.eventId,
						consumer: 'crm-intake.widget-transfer.v1'
					}
				}
			});
			return (
				row?.status === 'SKIPPED' && row.lastErrorCode === 'PERIOD_EXPIRED'
			);
		}, 'Expired original period did not fence a queued transfer');
		assert.equal(
			await intakeDb.widgetEntrySnapshot.count({
				where: { transferId: expired.intent.id }
			}),
			0
		);
		await settleQueues();
		await runtime.stop(widgetsApi.id);
		for (const submission of submissions.slice(0, 6))
			await delivered(submission);
		await restart('widgets');

		stage('drain-and-evidence');
		await runtime.wait(
			async () =>
				(await intakeDb.widgetTransferOutbox.count({
					where: { status: { not: 'PUBLISHED' } }
				})) === 0 &&
				(await intakeDb.widgetControlOutbox.count({
					where: { status: { not: 'PUBLISHED' } }
				})) === 0,
			'Native Intake Outbox did not drain'
		);
		assert.equal(
			await intakeDb.widgetTransferReceipt.count({
				where: { status: { notIn: ['DELIVERED', 'SKIPPED'] } }
			}),
			0
		);
		await runtime.wait(
			async () =>
				(await widgetsDb.widgetsOutboxEvent.count({
					where: { status: { not: 'PUBLISHED' } }
				})) === 0,
			'Widgets Outbox did not drain'
		);
		if (controlConflictRecoveries.length) {
			const dead = await runtime.wait(async () => {
				const items = await intakeDb.widgetControlOutbox.findMany({
					where: { route: 'DLQ' }
				});
				return (
					items.length === controlConflictRecoveries.length &&
					items.every(row => row.status === 'PUBLISHED') &&
					items
				);
			}, 'Recovered control conflict DLQ evidence missing');
			assert.ok(
				dead.every(row =>
					controlConflictRecoveries.includes(row.payload.commandId)
				)
			);
			await broker(async channel => {
				const observed = new Set();
				await channel.consume(
					NATIVE_CONTROL_QUEUE + '.dead-letter',
					message => {
						if (!message) return;
						const id = message.properties.messageId;
						if (dead.some(row => row.eventId === id)) {
							observed.add(id);
							channel.ack(message);
						}
					},
					{ noAck: false }
				);
				await runtime.wait(
					async () => observed.size === dead.length,
					'Control DLQ observation failed'
				);
				await channel.close();
			});
		}
		const rows = await queueRows();
		assert.ok(
			rows
				.filter(row => row.name.endsWith('.dead-letter'))
				.every(
					row =>
						row.messages_ready === 0 && row.messages_unacknowledged === 0
				)
		);
		const reported = new Set();
		await broker(async channel => {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('Reporting observation deadline')),
					10_000
				);
				channel
					.consume(
						runtime.reportingQueue,
						message => {
							try {
								assert.ok(message && message.content.length < 16384);
								assert.equal(
									message.properties.type,
									'widgets.lead.changed.v1'
								);
								const event = JSON.parse(message.content.toString('utf8'));
								assert.ok(
									submissions.some(item => item.leadId === event.state.id)
								);
								reported.add(event.state.id);
								channel.ack(message);
								if (reported.size === submissions.length) {
									clearTimeout(timer);
									resolve();
								}
							} catch {
								clearTimeout(timer);
								reject(new Error('Reporting observation contract failed'));
							}
						},
						{ noAck: false }
					)
					.catch(() => {
						clearTimeout(timer);
						reject(new Error('Reporting observation consumer failed'));
					});
			});
			await channel.close();
		});
		assert.equal(reported.size, submissions.length);
		// Native delivery is now drained. Retain its immutable snapshots and reuse
		// the exact API images, but stop its five processes before two acceptance
		// processes are started. This is not a production capacity measurement.
		await settleQueues();
		for (const spec of NATIVE_IMAGE_ROLES.filter(
			item => !item[0].includes('-acceptance-')
		))
			await runtime.stop(runtime.processes.get(spec[0]).id);
		await runtime.stop(runtime.processes.get('widgets').id);
		stage('retained-widget-snapshots-own-team-cross-workspace');
		const scopeEvidence = await verifyNativeInboxScope({
			request,
			account,
			managerAccount,
			foreignAccount,
			managerToken,
			evidence,
			fixtures
		});
		stage('unnamed-widget-acceptance-and-retry');
		const acceptanceEvidence = await verifyNativeInboxAcceptance({
			runtime,
			request,
			intakeDb,
			workspaceId: account.workspaceId,
			evidence,
			serviceEnvironment,
			restart,
			existingSubmission: submissions[6]
		});
		for (const [label, process] of runtime.processes) {
			const item = await runtime.inspect(process.id);
			assert.equal(item.Image, runtime.images.get(process.app));
			assert.equal(item.State.OOMKilled, false);
			assert.equal(
				item.RestartCount,
				0,
				'Unexpected runtime restart: ' + label
			);
		}
		return {
			schemaVersion: 1,
			kind: 'winwidget.native-image-proof.v1',
			revision: runtime.revision,
			images: Object.fromEntries(runtime.images),
			apiImages: 8,
			backgroundProcesses: 7,
			widgetTypes: evidence,
			controlConflictRecoveries: controlConflictRecoveries.length,
			submittedLeads: submissions.length,
			reportedLeads: reported.size,
			managedControlImagesVerified: true,
			controlDurableRetryRestartVerified: true,
			controlCommittedReplayVerified: true,
			controlDurableRetryCount: controlRetries.length,
			controlAppliedReplayCount: appliedControlRetries.length,
			outboxToInboxImagesVerified: true,
			atLeastOnceReplayVerified: true,
			mandatoryReturnRecoveryVerified: true,
			brokerRecoveryVerified: true,
			crashedClaimRecoveryVerified: true,
			explicitRevocationVerified: true,
			expiryVerified: true,
			retryDlqVerified: true,
			...scopeEvidence,
			...acceptanceEvidence,
			browserVerified: false,
			externalProvidersVerified: false,
			capacityVerified: false,
			logicalDatabases: 7,
			postgresInstances: 1,
			postgresAuthentication: 'local-test-trust'
		};
	} catch (error) {
		try {
			await runtime.failureEvidence(phase);
		} catch {
			runtime.log(
				'Bounded native failure diagnostics could not be recorded'
			);
		}
		// Report only bounded status/driver codes and this test's line number.
		// Never expose provider bodies, Prisma diagnostics, tokens or credentials.
		const status = Number.isInteger(error?.nativeHttpStatus)
			? '; HTTP=' + error.nativeHttpStatus
			: '';
		const code = /^P\d{4}$/.test(error?.code)
			? '; code=' + error.code
			: '';
		const stack = String(error?.stack || '');
		const location =
			stack.match(/(local-native-inbox-workflow\.mjs):(\d+):\d+/) ||
			stack.match(/(local-native-images-workflow\.mjs):(\d+):\d+/);
		throw new Error(
			'Native release-image workflow failed during ' +
				phase +
				status +
				code +
				(location
					? '; testLocation=' + location[1] + ':' + location[2]
					: '') +
				'; dependency details suppressed'
		);
	} finally {
		await Promise.allSettled([
			widgetsDb.$disconnect(),
			intakeDb.$disconnect()
		]);
	}
}
