import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Test-only composition of real service-owned classes. Runtime services retain
// their own databases and call Identity/Billing/Widgets/Access through real HTTP.
// Configuration is passed by the fresh harness, never loaded from private files.
export async function verifyNativeWidgetHttp({
	servicesRoot,
	runId,
	apiUrl,
	widgetsApiUrl,
	account,
	widget,
	widgetsDatabaseUrl,
	intakeDatabaseUrl,
	intakeEnvironment,
	broker,
	registerSecret,
	log
}) {
	let phase = 'configuration';
	let widgetsDb, intakeDb, inspector, inspectorChannel, provisionRabbit;
	let aclProbeConnection;
	let widgetsRabbit, workerRabbit, publisherRabbit;
	let widgetsPublisher, intakePublisher, worker;
	let sinkTag;
	const previous = new Map();
	const deadline = Date.now() + 90_000;
	const setEnvironment = values => {
		for (const [key, value] of Object.entries(values)) {
			if (!previous.has(key)) previous.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const until = async check => {
		while (Date.now() < deadline) {
			const result = await check();
			if (result) return result;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error('Native HTTP proof deadline exceeded');
	};
	const request = async (
		base,
		path,
		{ body, token, expected = 200, headers = {} } = {}
	) => {
		const response = await fetch(base + path, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			throw new Error('Unexpected local HTTP status');
		}
		assert.ok(
			response.headers.get('content-type')?.includes('application/json')
		);
		assert.ok(response.body);
		const reader = response.body.getReader();
		const chunks = [];
		let length = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > 512 * 1024) {
					await reader.cancel();
					throw new Error('Local HTTP response limit');
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(
				Buffer.concat(chunks, length)
			)
		);
	};
	try {
		assert.match(runId, /^[a-f0-9]{10}$/);
		assert.equal(apiUrl, 'http://localhost:4100/api/v1');
		assert.equal(widgetsApiUrl, 'http://127.0.0.1:4700/api/v1');
		assert.equal(account.userId, `wincrm-local-owner-${runId}`);
		assert.equal(widget.ownerSubject, account.userId);
		assert.equal(widget.workspaceId, account.workspaceId);
		assert.equal(widget.widgetType, 'QUIZ');
		assert.equal(widget.controlHttpVerified, true);
		for (const value of [
			widget.workspaceId,
			widget.sourceId,
			widget.connectorId
		])
			assert.match(
				value,
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
			);
		assert.match(widget.publicKey, /^[a-f0-9]{12}$/);
		for (const [raw, schema] of [
			[widgetsDatabaseUrl, 'widgets'],
			[intakeDatabaseUrl, 'crm_intake']
		]) {
			registerSecret(raw);
			const url = new URL(raw);
			assert.ok(
				url.protocol === 'postgresql:' &&
					url.hostname === '127.0.0.1' &&
					url.port === '55440'
			);
			assert.ok(
				url.pathname === `/winwidget_${schema}_test_browser_${runId}_test`
			);
			assert.ok(
				decodeURIComponent(url.username) === `wcrm_${schema}_r_${runId}`
			);
			assert.ok(url.searchParams.get('schema') === schema);
			assert.ok(
				!url.hash &&
					url.searchParams.get('sslmode') === 'disable' &&
					url.searchParams.getAll('schema').length === 1 &&
					url.searchParams.getAll('sslmode').length === 1 &&
					[...url.searchParams.keys()].every(key =>
						['schema', 'sslmode'].includes(key)
					)
			);
		}
		const urls = [
			'provisioner',
			'worker',
			'publisher',
			'widgetsPublisher'
		].map(key => {
			const raw = broker[key];
			registerSecret(raw);
			const url = new URL(raw);
			registerSecret(decodeURIComponent(url.password));
			assert.ok(
				url.protocol === 'amqp:' &&
					url.hostname === '127.0.0.1' &&
					url.port === '5673'
			);
			assert.ok(url.username && url.password && !url.search && !url.hash);
			assert.match(
				decodeURIComponent(url.pathname),
				/^\/[a-z0-9_-]+_(test|ci)$/
			);
			return url;
		});
		assert.ok(urls.every(url => url.pathname === urls[0].pathname));
		assert.equal(
			new Set(urls.map(url => decodeURIComponent(url.username))).size,
			4
		);
		assert.equal(
			intakeEnvironment.CRM_ACCESS_INTERNAL_BASE_URL,
			'http://127.0.0.1:5300'
		);
		assert.equal(
			intakeEnvironment.WIDGETS_INTERNAL_BASE_URL,
			'http://127.0.0.1:4700'
		);
		assert.equal(intakeEnvironment.CRM_INTAKE_WIDGETS_ENABLED, 'true');
		const widgetsRequire = createRequire(
			join(servicesRoot, 'apps/widgets/package.json')
		);
		const intakeRequire = createRequire(
			join(servicesRoot, 'apps/crm-intake/package.json')
		);
		intakeRequire('reflect-metadata');
		const widgetsClass = file =>
			widgetsRequire(
				join(servicesRoot, `apps/widgets/dist/src/${file}.js`)
			);
		const intakeClass = file =>
			intakeRequire(
				join(servicesRoot, `apps/crm-intake/dist/src/${file}.js`)
			);
		widgetsDb = new (widgetsRequire(
			'@prisma/widgets-client'
		).PrismaClient)({
			datasources: { db: { url: widgetsDatabaseUrl } },
			log: []
		});
		intakeDb = new (intakeRequire(
			'@prisma/crm-intake-client'
		).PrismaClient)({
			datasources: { db: { url: intakeDatabaseUrl } },
			log: []
		});
		const {
			WidgetTransferRabbit,
			TRANSFER_QUEUE,
			TRANSFER_DEAD_QUEUE,
			TRANSFER_UPSTREAM_EXCHANGE,
			TRANSFER_EVENT_TYPE
		} = intakeClass('widget-transfers/widget-transfer.messaging');
		const { parseWidgetTransferEvent } = intakeClass(
			'widget-transfers/widget-transfer.contract'
		);
		const { WidgetsRuntimeService } = widgetsClass(
			'runtime/widgets-runtime.service'
		);
		const { WidgetsRabbitMqService } = widgetsClass(
			'messaging/widgets-rabbitmq.service'
		);
		const { WidgetsOutboxPublisherService } = widgetsClass(
			'messaging/widgets-outbox-publisher.service'
		);
		const { WidgetTransferWorker } = intakeClass(
			'widget-transfers/widget-transfer.worker'
		);
		const { WidgetTransferPublisher } = intakeClass(
			'widget-transfers/widget-transfer.publisher'
		);
		const { WidgetTransferProcessor } = intakeClass(
			'widget-transfers/widget-transfer.processor'
		);
		const { WidgetTransferClient } = intakeClass(
			'widget-transfers/widget-transfer.client'
		);
		const { WidgetControlConfig } = intakeClass(
			'widget-sources/widget-control.config'
		);
		const { IntakeAuthorizationClient } = intakeClass(
			'access/intake-authorization.client'
		);
		setEnvironment({
			...intakeEnvironment,
			CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'true'
		});

		phase = 'fresh-owned-fixture';
		const quiz = await widgetsDb.quiz.findUniqueOrThrow({
			where: { id: widget.widgetId }
		});
		assert.equal(quiz.userId, account.userId);
		assert.equal(quiz.publicKey, widget.publicKey);
		assert.equal(quiz.isActive, true);
		assert.equal(quiz.publishedVersion, 1);
		assert.equal(quiz.config.dataType, 'PHONE');
		assert.equal(quiz.config.filterDuplicates, false);
		assert.ok(
			Object.values(quiz.config.integrations).every(
				value => value === '' || value === false
			)
		);
		assert.equal(
			await widgetsDb.quizLead.count({ where: { quizId: quiz.id } }),
			0
		);
		assert.equal(await widgetsDb.widgetsOutboxEvent.count(), 0);
		assert.equal(
			await widgetsDb.wincrmTransferIntent.count({
				where: { connectorId: widget.connectorId }
			}),
			0
		);
		const usage = await widgetsDb.widgetUsageCounter.findUniqueOrThrow({
			where: { userId: account.userId }
		});
		assert.equal(usage.widgetCount, 1);
		assert.equal(usage.leadCount, 0);
		assert.equal(
			usage.entitlementVersion.toString(),
			widget.subscriptionVersion
		);
		assert.equal(usage.leadPeriodKey, widget.expiresAt);
		const source = await intakeDb.managedWidgetSource.findUniqueOrThrow({
			where: { id: widget.sourceId }
		});
		assert.equal(source.workspaceId, widget.workspaceId);
		assert.equal(source.connectorId, widget.connectorId);
		assert.equal(source.ownerSubject, account.userId);
		assert.equal(source.createdBySubject, account.userId);
		assert.equal(source.widgetId, quiz.id);
		assert.equal(source.widgetType, 'QUIZ');
		assert.equal(source.enabled, true);
		assert.equal(source.generation, 1);
		assert.equal(source.syncState, 'SYNCED');
		assert.equal(
			await intakeDb.widgetTransferReceipt.count({
				where: { sourceId: widget.sourceId }
			}),
			0
		);

		phase = 'broker-topology';
		inspector = await intakeRequire('amqplib').connect(broker.provisioner);
		inspectorChannel = await inspector.createConfirmChannel();
		setEnvironment({
			CRM_INTAKE_RABBITMQ_URL: broker.provisioner,
			CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'true'
		});
		provisionRabbit = new WidgetTransferRabbit();
		await provisionRabbit.onModuleInit();
		const queue = await inspectorChannel.checkQueue(TRANSFER_QUEUE);
		assert.equal(queue.messageCount, 0);
		assert.equal(queue.consumerCount, 0);
		const baselineDeadLetters = (
			await inspectorChannel.checkQueue(TRANSFER_DEAD_QUEUE)
		).messageCount;
		const sinkQueue = `winwidget.crm-intake.widget-transfer.http-reporting.${runId}`;
		const sink = await inspectorChannel.assertQueue(sinkQueue, {
			durable: true
		});
		assert.equal(sink.messageCount, 0);
		assert.equal(sink.consumerCount, 0);
		await inspectorChannel.bindQueue(
			sinkQueue,
			TRANSFER_UPSTREAM_EXCHANGE,
			'widgets.lead.changed.v1'
		);
		// Negative checks use their own channels: Rabbit closes the offending
		// channel after ACCESS_REFUSED. No new queue or message is created.
		phase = 'widgets-publisher-acl';
		aclProbeConnection = await intakeRequire('amqplib').connect(
			broker.widgetsPublisher
		);
		aclProbeConnection.on('error', () => {});
		for (const operation of ['configure', 'read']) {
			const channel = await aclProbeConnection.createChannel();
			channel.on('error', () => {});
			await assert.rejects(
				operation === 'configure'
					? channel.assertQueue(sinkQueue, { durable: true })
					: channel.consume(sinkQueue, () => {}, { noAck: false }),
				error => error?.code === 403
			);
		}
		await aclProbeConnection.close();
		aclProbeConnection = null;
		assert.equal(
			(await inspectorChannel.checkQueue(sinkQueue)).consumerCount,
			0
		);
		const reportingMessages = [];
		let invalidReporting = false;
		const sinkRegistration = await inspectorChannel.consume(
			sinkQueue,
			message => {
				if (!message) {
					invalidReporting = true;
					return;
				}
				try {
					assert.ok(message.content.length <= 16_384);
					assert.equal(message.properties.type, 'widgets.lead.changed.v1');
					assert.equal(message.properties.contentType, 'application/json');
					const event = JSON.parse(message.content.toString('utf8'));
					assert.equal(event.eventType, 'widgets.lead.changed.v1');
					assert.equal(event.eventId, message.properties.messageId);
					assert.equal(event.state.widgetId, quiz.id);
					assert.deepEqual(Object.keys(event.state).sort(), [
						'createdAt',
						'id',
						'widgetId',
						'widgetType'
					]);
					reportingMessages.push(event);
					inspectorChannel.ack(message);
				} catch {
					invalidReporting = true;
					// Leave the message unacknowledged until cleanup closes the channel:
					// preserve it for inspection without a hot requeue loop or payload logs.
				}
			},
			{ noAck: false }
		);
		sinkTag = sinkRegistration.consumerTag;
		await provisionRabbit.onApplicationShutdown();
		provisionRabbit = null;

		phase = 'real-worker-start';
		setEnvironment({
			CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'false',
			CRM_INTAKE_RABBITMQ_URL: broker.worker
		});
		workerRabbit = new WidgetTransferRabbit();
		await workerRabbit.onModuleInit();
		setEnvironment({ CRM_INTAKE_RABBITMQ_URL: broker.publisher });
		publisherRabbit = new WidgetTransferRabbit();
		await publisherRabbit.onModuleInit();
		const acknowledgements = new Map();
		const realAck = workerRabbit.ack.bind(workerRabbit);
		workerRabbit.ack = message => {
			// Observation only: acknowledgement still goes through the real delivery channel.
			realAck(message);
			const id = message.properties.messageId;
			acknowledgements.set(id, (acknowledgements.get(id) || 0) + 1);
		};
		const processor = new WidgetTransferProcessor(
			intakeDb,
			new IntakeAuthorizationClient(),
			new WidgetTransferClient(new WidgetControlConfig())
		);
		worker = new WidgetTransferWorker(processor, workerRabbit, intakeDb);
		intakePublisher = new WidgetTransferPublisher(
			intakeDb,
			publisherRabbit
		);
		await worker.onApplicationBootstrap();
		intakePublisher.onApplicationBootstrap();
		assert.equal(workerRabbit.ready(true), true);
		const config = new (widgetsRequire('@nestjs/config').ConfigService)({
			WIDGETS_PROCESS_ROLE: 'publisher',
			RABBITMQ_URL: broker.widgetsPublisher,
			RABBITMQ_ASSERT_TOPOLOGY: 'false',
			WIDGETS_OUTBOX_POLL_INTERVAL_MS: '100',
			WIDGETS_OUTBOX_BATCH_SIZE: '10'
		});
		const runtime = new WidgetsRuntimeService(config);
		widgetsRabbit = new WidgetsRabbitMqService(config, runtime);
		// Transport error details are not a safe harness log format. These are real
		// implementations; only their diagnostic logger is muted in the test driver.
		const quietLogger = { log() {}, warn() {}, error() {} };
		widgetsRabbit.logger = quietLogger;
		await widgetsRabbit.onModuleInit();
		widgetsPublisher = new WidgetsOutboxPublisherService(
			widgetsDb,
			widgetsRabbit,
			runtime,
			config
		);
		widgetsPublisher.logger = quietLogger;

		phase = 'public-quiz-submit';
		const correlationId = randomUUID();
		const phone = '+79000000001';
		const submitted = await request(
			widgetsApiUrl,
			`/quiz/${widget.publicKey}/lead`,
			{
				expected: 201,
				headers: {
					origin: 'http://localhost:3000',
					'x-correlation-id': correlationId
				},
				body: {
					phone,
					answers: [{ questionId: 'q1', optionIds: ['q1o1'] }],
					url: 'http://localhost:3000/native-qa?test=synthetic#fragment'
				}
			}
		);
		assert.equal(submitted.success, true);
		const leadId = submitted.lead.id;
		assert.ok(typeof leadId === 'string' && leadId.length <= 255);
		const intent = await widgetsDb.wincrmTransferIntent.findFirstOrThrow({
			where: { connectorId: widget.connectorId, leadId }
		});
		assert.equal(intent.state, 'READY');
		assert.equal(intent.reason, null);
		assert.equal(intent.originalSubscriptionId, widget.subscriptionId);
		assert.equal(
			intent.originalSubscriptionVersion,
			widget.subscriptionVersion
		);
		assert.equal(
			intent.originalPeriodStartsAt.toISOString(),
			widget.startsAt
		);
		assert.equal(intent.originalDeadline.toISOString(), widget.expiresAt);
		const rows = await widgetsDb.widgetsOutboxEvent.findMany();
		assert.equal(
			rows.length,
			2,
			'Only native transfer and reporting events expected'
		);
		assert.ok(
			rows.every(
				row => row.status === 'PENDING' && row.publishedAt === null
			)
		);
		assert.deepEqual(
			rows.map(row => row.eventType).sort(),
			[TRANSFER_EVENT_TYPE, 'widgets.lead.changed.v1'].sort()
		);
		const native = rows.find(row => row.messageId === intent.eventId);
		assert.ok(native);
		const event = parseWidgetTransferEvent(
			native.payload,
			native.messageId
		);
		assert.equal(event.transferId, intent.id);
		assert.equal(event.sourceId, source.id);
		assert.equal(event.workspaceId, widget.workspaceId);
		assert.equal(event.occurredAt, intent.leadCreatedAt.toISOString());
		assert.equal(
			await intakeDb.widgetTransferReceipt.count({
				where: { eventId: event.eventId }
			}),
			0
		);
		assert.equal(
			(
				await widgetsDb.widgetUsageCounter.findUniqueOrThrow({
					where: { userId: account.userId }
				})
			).leadCount,
			1
		);

		phase = 'real-outbox-to-inbox';
		widgetsPublisher.onModuleInit();
		const receipt = await until(async () => {
			assert.equal(invalidReporting, false);
			const current = await intakeDb.widgetTransferReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: 'crm-intake.widget-transfer.v1'
					}
				}
			});
			return current?.status === 'DELIVERED' && current;
		});
		await until(
			async () =>
				(await widgetsDb.widgetsOutboxEvent.count({
					where: {
						id: { in: rows.map(row => row.id) },
						status: 'PUBLISHED',
						publishedAt: { not: null }
					}
				})) === 2 &&
				reportingMessages.some(message => message.state.id === leadId) &&
				(acknowledgements.get(event.eventId) || 0) >= 1
		);
		assert.equal(receipt.actorSubject, account.userId);
		assert.equal(receipt.ownerSubject, account.userId);
		assert.equal(receipt.sourceId, widget.sourceId);
		assert.equal(receipt.workspaceId, widget.workspaceId);
		const stored = await intakeDb.widgetEntrySnapshot.findUniqueOrThrow({
			where: { entryId: receipt.entryId }
		});
		assert.deepEqual(stored.payload, intent.payload);
		assert.equal(stored.transferId, event.transferId);
		assert.equal(stored.eventId, event.eventId);
		assert.equal(
			await intakeDb.intakeActivity.count({
				where: {
					commandId: receipt.auditCommandId,
					entityId: receipt.entryId,
					workspaceId: widget.workspaceId,
					actorSubject: account.userId,
					action: 'CREATED'
				}
			}),
			1
		);

		phase = 'public-inbox-reader';
		const session = await request(apiUrl, '/auth/login', {
			body: { email: account.email, password: account.password }
		});
		assert.equal(session.user.id, account.userId);
		assert.ok(
			typeof session.accessToken === 'string' &&
				session.accessToken.length > 100
		);
		registerSecret(session.accessToken);
		const token = session.accessToken;
		const suffix = `?workspaceId=${widget.workspaceId}`;
		const detail = await request(
			apiUrl,
			`/crm/intake/inbox/${receipt.entryId}${suffix}`,
			{ token }
		);
		assert.equal(detail.entry.origin, 'WIDGET');
		assert.equal(detail.entry.sourceId, widget.sourceId);
		assert.equal(detail.entry.name, null);
		assert.equal(detail.entry.phone, phone);
		const full = await request(
			apiUrl,
			`/crm/intake/inbox/${receipt.entryId}/widget-details${suffix}`,
			{ token }
		);
		assert.equal(full.workspaceId, widget.workspaceId);
		assert.equal(full.sourceId, widget.sourceId);
		assert.deepEqual(full.payload, stored.payload);
		assert.equal(full.payload.lead.contactName, null);
		assert.equal(full.payload.lead.phoneE164, phone);
		assert.equal(
			full.payload.lead.pageUrl,
			'http://localhost:3000/native-qa'
		);
		assert.deepEqual(full.payload.lead.redactions, [
			'URL_QUERY_REMOVED',
			'URL_FRAGMENT_REMOVED'
		]);
		const transfers = await request(
			apiUrl,
			`/crm/intake/widget-sources/${widget.sourceId}/transfers${suffix}&page=1&pageSize=25`,
			{ token }
		);
		assert.equal(transfers.total, 1);
		assert.equal(transfers.items[0].id, event.transferId);
		assert.equal(transfers.items[0].state, 'DELIVERED');
		assert.equal(transfers.items[0].entryId, receipt.entryId);
		assert.deepEqual(
			Object.keys(transfers.items[0]).sort(),
			[
				'id',
				'workspaceId',
				'sourceId',
				'state',
				'version',
				'reason',
				'entryId',
				'occurredAt',
				'receivedAt',
				'updatedAt',
				'completedAt'
			].sort()
		);

		phase = 'real-broker-duplicate';
		// At-least-once replay of the already-published immutable event, not a new
		// business event and not a mutation of the original Outbox publication proof.
		await widgetsRabbit.publish(
			TRANSFER_UPSTREAM_EXCHANGE,
			TRANSFER_EVENT_TYPE,
			event,
			{ messageId: event.eventId, type: TRANSFER_EVENT_TYPE, headers: {} }
		);
		await until(() => (acknowledgements.get(event.eventId) || 0) >= 2);
		assert.equal(
			await intakeDb.widgetTransferReceipt.count({
				where: { eventId: event.eventId }
			}),
			1
		);
		assert.equal(
			await intakeDb.inboxEntry.count({
				where: {
					workspaceId: widget.workspaceId,
					widgetSourceId: widget.sourceId
				}
			}),
			1
		);
		assert.equal(
			await intakeDb.widgetEntrySnapshot.count({
				where: { transferId: event.transferId }
			}),
			1
		);
		assert.equal(
			(await inspectorChannel.checkQueue(TRANSFER_DEAD_QUEUE))
				.messageCount,
			baselineDeadLetters
		);
		assert.equal(
			await widgetsDb.widgetsOutboxEvent.count({
				where: { status: { not: 'PUBLISHED' } }
			}),
			0
		);
		assert.equal(invalidReporting, false);
		log(
			'Native Quiz HTTP proof passed: public submit, real Widgets Outbox/confirm, scoped Rabbit push, fresh HTTP authorization/context, atomic Inbox and duplicate-safe replay; no external providers'
		);
		return {
			widgetType: 'QUIZ',
			leadId,
			transferId: event.transferId,
			eventId: event.eventId,
			entryId: receipt.entryId,
			widgetsOutboxIds: rows.map(row => row.id),
			publicSubmitVerified: true,
			widgetsOutboxPublisherVerified: true,
			widgetsPublisherNoReadConfigureVerified: true,
			intakeWorkerHttpVerified: true,
			rabbitTransportVerified: true,
			duplicateVerified: true,
			externalProvidersVerified: false
		};
	} catch {
		throw new Error(
			`Native Widget HTTP proof failed during ${phase}; dependency details suppressed`
		);
	} finally {
		const drain = await Promise.allSettled([
			widgetsPublisher?.beforeApplicationShutdown(),
			intakePublisher?.beforeApplicationShutdown(),
			worker?.beforeApplicationShutdown()
		]);
		const close = await Promise.allSettled([
			widgetsRabbit?.onApplicationShutdown(),
			workerRabbit?.onApplicationShutdown(),
			publisherRabbit?.onApplicationShutdown(),
			provisionRabbit?.onApplicationShutdown(),
			...(sinkTag && inspectorChannel
				? [inspectorChannel.cancel(sinkTag)]
				: [])
		]);
		const channels = await Promise.allSettled([inspectorChannel?.close()]);
		const connections = await Promise.allSettled([
			inspector?.close(),
			aclProbeConnection?.close(),
			widgetsDb?.$disconnect(),
			intakeDb?.$disconnect()
		]);
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (
			[...drain, ...close, ...channels, ...connections].some(
				result => result.status === 'rejected'
			)
		)
			throw new Error(
				'Native Widget HTTP proof cleanup failed; connection details suppressed'
			);
	}
}
