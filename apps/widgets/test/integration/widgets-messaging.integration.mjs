import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/widgets-client';

const databaseUrl = requiredEnvironment('WIDGETS_TEST_DATABASE_URL');
const migrationDatabaseUrl = requiredEnvironment(
	'WIDGETS_TEST_MIGRATION_DATABASE_URL'
);
const restrictedRabbitUrl = requiredEnvironment(
	'WIDGETS_TEST_RABBITMQ_URL'
);
const adminRabbitUrl = requiredEnvironment(
	'WIDGETS_TEST_RABBITMQ_ADMIN_URL'
);
if (process.env.WIDGETS_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_MUTATION=true is required');
}
if (process.env.WIDGETS_INTEGRATION_ALLOW_PURGE !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_PURGE=true is required');
}
assertLocalTestDatabase(databaseUrl, 'WIDGETS_TEST_DATABASE_URL');
assertLocalTestDatabase(
	migrationDatabaseUrl,
	'WIDGETS_TEST_MIGRATION_DATABASE_URL'
);
assertLocalTestRabbit(restrictedRabbitUrl, 'WIDGETS_TEST_RABBITMQ_URL');
assertLocalTestRabbit(adminRabbitUrl, 'WIDGETS_TEST_RABBITMQ_ADMIN_URL');
if (
	new URL(restrictedRabbitUrl).username ===
	new URL(adminRabbitUrl).username
) {
	throw new Error(
		'Widgets restricted and admin RabbitMQ users must differ'
	);
}

const appRoot = new URL('../../', import.meta.url);
const migration = spawnSync('pnpm', ['run', 'prisma:migrate:deploy'], {
	cwd: appRoot,
	env: {
		...process.env,
		WIDGETS_DATABASE_URL: migrationDatabaseUrl
	},
	encoding: 'utf8',
	timeout: 120_000
});
if (migration.status !== 0) {
	throw new Error(
		redactCredentials(
			`Widgets migration failed:\n${migration.stdout}\n${migration.stderr}`
		)
	);
}

const amqpImported = await import('amqplib');
const connect = amqpImported.connect || amqpImported.default?.connect;
if (!connect) throw new Error('amqplib connect is unavailable');
const projectionContractImported = await import(
	new URL(
		'../../dist/src/projections/widgets-projection.contract.js',
		import.meta.url
	)
);
const projectionPayloadHash =
	projectionContractImported.projectionPayloadHash ||
	projectionContractImported.default?.projectionPayloadHash;
if (!projectionPayloadHash) {
	throw new Error('Compiled Widgets projection contract is unavailable');
}
const rabbitServiceImported = await import(
	new URL(
		'../../dist/src/messaging/widgets-rabbitmq.service.js',
		import.meta.url
	)
);
const WidgetsRabbitMqService =
	rabbitServiceImported.WidgetsRabbitMqService ||
	rabbitServiceImported.default?.WidgetsRabbitMqService;
if (!WidgetsRabbitMqService) {
	throw new Error('Compiled Widgets RabbitMQ service is unavailable');
}

const EVENTS_EXCHANGE = 'winwidget.events';
const RETRY_EXCHANGE = 'winwidget.widgets.retry';
const MANUAL_RETRY_EXCHANGE = 'winwidget.widgets.manual-retry';
const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000];
const QUEUES = {
	identity: 'winwidget.widgets.identity-user',
	entitlement: 'winwidget.widgets.billing-subscription',
	webhook: 'winwidget.lead-integration.webhook',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm'
};
const ROUTING_KEYS = {
	identity: 'identity.user.changed.v1',
	entitlement: 'billing.subscription.changed.v1',
	webhook: 'lead.integration.webhook.v2',
	bitrix24: 'lead.integration.bitrix24.v2',
	'amo-crm': 'lead.integration.amo-crm.v2'
};
const CONSUMERS = {
	identity: 'widgets-owner-projection-v1',
	entitlement: 'widgets-entitlement-projection-v1'
};
const runId = randomUUID();
const trackedEventIds = new Set();
const trackedAggregateIds = new Set();
const trackedOutboxIds = new Set();
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
let service = null;
let fixture = null;

try {
	fixture = await provisionRabbitFixture();
	await assertProjectionTopologyPreservesProviderRetries(fixture);
	const port = await getFreePort();
	service = startService(port);
	await waitForReady(port);
	await assertRestrictedTopology(fixture.restricted);
	await purgeWidgetsQueues(fixture.adminChannel);
	await assertPublisherConfirmAndOwnedTopics(fixture);
	await assertPublisherMandatoryReturn(fixture.adminChannel);
	await assertProjectionLeaseRecoveryUsesLocalRoute(
		fixture.publisher,
		fixture.adminChannel
	);
	await assertConsumerAckAndIdempotency(fixture.publisher);
	await assertConsumerRetry(fixture.publisher, fixture.adminChannel);
	await assertConsumerDeadLetter(fixture.publisher, fixture.adminChannel);
	await assertProviderConsumerAckAndDeadLetter(
		fixture.publisher,
		fixture.adminChannel
	);
	console.log(
		'Widgets restricted RabbitMQ publisher/consumer integration passed'
	);
} finally {
	if (service) await stopService(service).catch(() => undefined);
	if (fixture) {
		await purgeWidgetsQueues(fixture.adminChannel).catch(() => undefined);
		await deleteProviderRetryQueues(fixture.adminChannel).catch(
			() => undefined
		);
		await fixture.close().catch(() => undefined);
	}
	await cleanupDatabaseArtifacts().catch(() => undefined);
	await prisma.$disconnect();
}

async function assertProjectionTopologyPreservesProviderRetries(
	rabbitFixture
) {
	const existingQueues = [];
	for (const [kind, queue] of Object.entries(QUEUES).filter(([kind]) =>
		['webhook', 'bitrix24', 'amo-crm'].includes(kind)
	)) {
		for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
			const retryQueue = `${queue}.retry.${index + 1}`;
			const options = {
				durable: true,
				messageTtl: delay,
				deadLetterExchange: EVENTS_EXCHANGE,
				deadLetterRoutingKey: `lead.integration.${kind}.v1`
			};
			await rabbitFixture.adminChannel.assertQueue(retryQueue, options);
			existingQueues.push({ retryQueue, options });
		}
	}

	const invalidScopeService = createTopologyService('invalid');
	await assert.rejects(
		invalidScopeService.onModuleInit(),
		/WIDGETS_RABBITMQ_TOPOLOGY_SCOPE must be all or projections/
	);
	await invalidScopeService.onApplicationShutdown();
	const unsafeRuntimeService = createTopologyService('projections', {
		workerEnabled: true
	});
	await assert.rejects(
		unsafeRuntimeService.onModuleInit(),
		/Projection-only Widgets RabbitMQ topology is forbidden for worker or publisher runtimes/
	);
	await unsafeRuntimeService.onApplicationShutdown();

	const projectionService = createTopologyService('projections');
	try {
		await projectionService.onModuleInit();
		assert.equal(projectionService.isConnected(), true);
		assert.equal(projectionService.isTopologyReady(), true);
		for (const { retryQueue, options } of existingQueues) {
			await rabbitFixture.adminChannel.assertQueue(retryQueue, options);
		}
		console.log(
			'Widgets projection-only topology preserved provider retry arguments'
		);
	} finally {
		await projectionService.onApplicationShutdown().catch(() => undefined);
		for (const { retryQueue } of existingQueues) {
			await rabbitFixture.adminChannel
				.deleteQueue(retryQueue, { ifEmpty: true, ifUnused: true })
				.catch(() => undefined);
		}
	}
}

function createTopologyService(scope, runtime = {}) {
	return new WidgetsRabbitMqService(
		{
			get(key) {
				if (key === 'RABBITMQ_URL') return restrictedRabbitUrl;
				if (key === 'RABBITMQ_ASSERT_TOPOLOGY') return true;
				if (key === 'RABBITMQ_CONNECTION_NAME') {
					return `widgets-${scope}-topology-${runId}`;
				}
				if (key === 'WIDGETS_RABBITMQ_TOPOLOGY_SCOPE') return scope;
				return undefined;
			}
		},
		{
			role: 'topology',
			rabbitEnabled: true,
			workerEnabled: false,
			publisherEnabled: false,
			...runtime
		}
	);
}

async function provisionRabbitFixture() {
	const admin = await connect(adminRabbitUrl);
	const restricted = await connect(restrictedRabbitUrl);
	const adminChannel = await admin.createChannel();
	const publisher = await admin.createConfirmChannel();
	const queues = [];
	try {
		await adminChannel.assertExchange(EVENTS_EXCHANGE, 'topic', {
			durable: true
		});
		await adminChannel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', {
			durable: true
		});
		for (const [name, routingKey] of [
			['audit', 'admin.audit.widgets.v1'],
			['email', 'lead.integration.email.v2'],
			['telegram', 'lead.integration.telegram.v2']
		]) {
			const queue = `winwidget.integration.widgets-${name}-${runId}`;
			await adminChannel.assertQueue(queue, {
				durable: false,
				exclusive: false,
				autoDelete: false
			});
			await adminChannel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
			queues.push(queue);
		}
		return {
			admin,
			restricted,
			adminChannel,
			publisher,
			sinks: {
				audit: queues[0],
				email: queues[1],
				telegram: queues[2]
			},
			close: async () => {
				for (const queue of queues) {
					await adminChannel.deleteQueue(queue).catch(() => undefined);
				}
				await publisher.close().catch(() => undefined);
				await adminChannel.close().catch(() => undefined);
				await restricted.close().catch(() => undefined);
				await admin.close().catch(() => undefined);
			}
		};
	} catch (error) {
		await publisher.close().catch(() => undefined);
		await adminChannel.close().catch(() => undefined);
		await restricted.close().catch(() => undefined);
		await admin.close().catch(() => undefined);
		throw error;
	}
}

function startService(port) {
	return spawn('node', ['dist/src/main.js'], {
		cwd: appRoot,
		env: {
			...process.env,
			NODE_ENV: 'production',
			MODE: 'production',
			APP_REVISION: 'widgets-messaging-integration',
			WIDGETS_DATABASE_URL: databaseUrl,
			WIDGETS_PROCESS_ROLE: 'all',
			WIDGETS_LISTEN_HOST: '127.0.0.1',
			WIDGETS_PORT: String(port),
			WIDGETS_INTERNAL_TOKEN: `widgets-messaging-${runId}`,
			WIDGETS_IDENTITY_TOKEN: 'messaging-widgets-identity-token-20260828',
			WIDGETS_OPERATIONS_TOKEN:
				'messaging-widgets-operations-token-20260828',
			IDENTITY_WIDGETS_TOKEN: 'messaging-identity-widgets-token-20260828',
			WIDGETS_INTERNAL_TIMEOUT_MS: '500',
			WIDGETS_ENTITLEMENT_MAX_STALENESS_MS: '31968000000',
			WIDGETS_PREFETCH: '1',
			WIDGETS_PROVIDER_PREFETCH: '1',
			WIDGETS_OUTBOX_BATCH_SIZE: '50',
			WIDGETS_OUTBOX_POLL_INTERVAL_MS: '100',
			WIDGETS_RECEIPT_RETENTION_DAYS: '7',
			CLOUDFLARE_ACCOUNT_ID: 'messaging_account_123',
			CLOUDFLARE_API_TOKEN: 'messaging-cloudflare-token',
			CLOUDFLARE_AI_GATEWAY_ID: 'messaging-ai-gateway',
			CLOUDFLARE_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
			WIDGETS_AI_SESSION_SECRET:
				'messaging-session-secret-with-at-least-32-bytes',
			WIDGETS_CALLBACK_OTP_SECRET:
				'messaging-callback-otp-secret-at-least-32-bytes',
			CLOUDFLARE_TURNSTILE_SITE_KEY: 'messaging-turnstile-site-key',
			CLOUDFLARE_TURNSTILE_SECRET_KEY: 'messaging-turnstile-secret-key',
			RABBITMQ_URL: restrictedRabbitUrl,
			RABBITMQ_ASSERT_TOPOLOGY: 'true',
			RABBITMQ_CONNECTION_NAME: 'widgets-restricted-integration',
			CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3000'
		},
		stdio: 'inherit'
	});
}

async function assertRestrictedTopology(connection) {
	const channel = await connection.createChannel();
	try {
		for (const queue of Object.values(QUEUES)) {
			const base = await channel.checkQueue(queue);
			assert.equal(
				base.consumerCount,
				1,
				`Widgets base queue must have one push consumer: ${queue}`
			);
			const deadLetter = await channel.checkQueue(`${queue}.dead-letter`);
			assert.equal(deadLetter.consumerCount, 0);
			for (const index of [1, 2, 3]) {
				const retry = await channel.checkQueue(`${queue}.retry.${index}`);
				assert.equal(retry.consumerCount, 0);
			}
		}
		await channel.checkExchange(RETRY_EXCHANGE);
		await channel.checkExchange(MANUAL_RETRY_EXCHANGE);
	} finally {
		await channel.close();
	}

	const foreignQueue = `winwidget.integration.foreign-${runId}`;
	await fixture.adminChannel.assertQueue(foreignQueue, {
		durable: false,
		autoDelete: false
	});
	try {
		await assertForeignQueueDenied(connection, foreignQueue, 'configure');
		await assertForeignQueueDenied(connection, foreignQueue, 'read');
		await assertTopicWriteDenied(connection, 'identity.user.changed.v1');
	} finally {
		await fixture.adminChannel
			.deleteQueue(foreignQueue)
			.catch(() => undefined);
	}
}

async function assertPublisherConfirmAndOwnedTopics(rabbit) {
	const auditEventId = trackEventId(randomUUID());
	const auditPayload = {
		schemaVersion: 1,
		eventType: 'admin.audit.event.v1',
		eventId: auditEventId,
		occurredAt: new Date().toISOString(),
		correlationId: `widgets-rabbit-${runId}`,
		actorId: `widgets-rabbit-${runId}`,
		action: 'WIDGET_DELETE',
		target: {
			widgetId: `widget-${runId}`,
			widgetType: 'WHEEL',
			ownerId: `owner-${runId}`
		},
		metadata: {}
	};
	const auditOutbox = await createOutbox({
		messageId: auditEventId,
		deduplicationKey: `integration:${runId}:publisher-confirm:audit`,
		exchange: 'EVENTS',
		eventType: auditPayload.eventType,
		routingKey: 'admin.audit.widgets.v1',
		payload: auditPayload
	});
	await assertPublishedOutboxAndMessage(
		auditOutbox.id,
		rabbit.adminChannel,
		rabbit.sinks.audit,
		auditEventId,
		payload => payload.action === 'WIDGET_DELETE'
	);

	for (const integration of ['email', 'telegram']) {
		const eventId = trackEventId(randomUUID());
		const payload = leadIntegrationPayload(integration, eventId);
		const outbox = await createOutbox({
			messageId: eventId,
			deduplicationKey: `integration:${runId}:owned-topic:${integration}`,
			exchange: 'EVENTS',
			eventType: payload.eventType,
			routingKey: `lead.integration.${integration}.v2`,
			payload
		});
		await assertPublishedOutboxAndMessage(
			outbox.id,
			rabbit.adminChannel,
			rabbit.sinks[integration],
			eventId,
			body => body.integration === integration
		);
	}
}

async function assertPublisherMandatoryReturn(adminChannel) {
	const queue = `${QUEUES.identity}.retry.1`;
	const routingKey = 'identity.retry.1';
	await adminChannel.unbindQueue(queue, RETRY_EXCHANGE, routingKey);
	try {
		const event = identityEvent({
			aggregateId: trackAggregateId(`mandatory-${runId}`),
			aggregateVersion: '1',
			sourceSequence: '1'
		});
		const eventId = trackEventId(event.eventId);
		const outbox = await createOutbox({
			messageId: eventId,
			deduplicationKey: `integration:${runId}:mandatory-return`,
			exchange: 'RETRY',
			eventType: event.eventType,
			routingKey,
			payload: event,
			headers: {
				'x-retry-attempt': 1,
				'x-manual-retry-cycle': 0
			},
			attempts: 8
		});
		await waitFor('mandatory return persisted for retry', async () => {
			const current = await prisma.widgetsOutboxEvent.findUnique({
				where: { id: outbox.id }
			});
			return (
				current?.status === 'PENDING' &&
				current.attempts === 9 &&
				current.publishedAt === null &&
				/RabbitMQ returned mandatory publication/i.test(
					current.lastError || ''
				)
			);
		});
		await prisma.widgetsOutboxEvent.delete({ where: { id: outbox.id } });
		trackedOutboxIds.delete(outbox.id);
	} finally {
		await adminChannel.bindQueue(queue, RETRY_EXCHANGE, routingKey);
	}
}

async function assertProjectionLeaseRecoveryUsesLocalRoute(
	publisher,
	adminChannel
) {
	const aggregateId = trackAggregateId(`lease-recovery-${runId}`);
	const event = identityEvent({
		aggregateId,
		aggregateVersion: '1',
		sourceSequence: '1'
	});
	const eventId = trackEventId(event.eventId);
	const leaseExpiresAt = new Date(Date.now() + 1_500);
	await prisma.widgetsConsumerReceipt.create({
		data: {
			eventId,
			consumer: CONSUMERS.identity,
			payloadHash: projectionPayloadHash(event),
			status: 'PROCESSING',
			lockedAt: new Date(),
			lockedBy: `integration-fixture-${runId}`,
			lockToken: randomUUID(),
			leaseExpiresAt,
			retryCycle: 0
		}
	});
	await publishProjection(publisher, event);
	let recoveryOutbox;
	await waitFor('local projection lease-recovery intent', async () => {
		recoveryOutbox = await prisma.widgetsOutboxEvent.findFirst({
			where: {
				deduplicationKey: {
					startsWith: `projection-active-recovery:${CONSUMERS.identity}:${eventId}:0:`
				}
			}
		});
		return Boolean(recoveryOutbox);
	});
	trackedOutboxIds.add(recoveryOutbox.id);
	assert.equal(recoveryOutbox.exchange, 'MANUAL_RETRY');
	assert.equal(recoveryOutbox.routingKey, 'identity.manual-retry');
	try {
		await waitFor(
			'local projection lease recovery delivered',
			async () => {
				const [receipt, outbox] = await Promise.all([
					prisma.widgetsConsumerReceipt.findUnique({
						where: {
							eventId_consumer: {
								eventId,
								consumer: CONSUMERS.identity
							}
						}
					}),
					prisma.widgetsOutboxEvent.findUnique({
						where: { id: recoveryOutbox.id }
					})
				]);
				return (
					receipt?.status === 'DELIVERED' && outbox?.status === 'PUBLISHED'
				);
			},
			20_000
		);
	} catch (error) {
		const [receipt, outbox, ...queues] = await Promise.all([
			prisma.widgetsConsumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: CONSUMERS.identity
					}
				}
			}),
			prisma.widgetsOutboxEvent.findUnique({
				where: { id: recoveryOutbox.id }
			}),
			...[
				QUEUES.identity,
				`${QUEUES.identity}.retry.1`,
				`${QUEUES.identity}.retry.2`,
				`${QUEUES.identity}.retry.3`,
				`${QUEUES.identity}.dead-letter`
			].map(name => adminChannel.checkQueue(name))
		]);
		const safeLastError = value =>
			redactCredentials(String(value || '')).slice(0, 500);
		throw new Error(
			`${error.message}; receiptStatus=${receipt?.status}; receiptRetryAttempt=${receipt?.retryAttempt}; receiptLastError=${safeLastError(receipt?.lastError)}; outboxStatus=${outbox?.status}; outboxAttempts=${outbox?.attempts}; outboxLastError=${safeLastError(outbox?.lastError)}; queueCounts=${queues.map(queue => `${queue.queue}:${queue.messageCount}/${queue.consumerCount}`).join(',')}`
		);
	}
}

async function assertConsumerAckAndIdempotency(publisher) {
	const aggregateId = trackAggregateId(`idempotency-${runId}`);
	const event = identityEvent({
		aggregateId,
		aggregateVersion: '1',
		sourceSequence: '10'
	});
	const eventId = trackEventId(event.eventId);
	await publishProjection(publisher, event);
	await waitForReceipt(eventId, CONSUMERS.identity, 'DELIVERED');
	const firstProjection = await prisma.widgetOwnerProjection.findUnique({
		where: { userId: aggregateId }
	});
	assert(firstProjection, 'Identity projection was not created');

	await publishProjection(publisher, event);
	const barrier = identityEvent({
		aggregateId: trackAggregateId(`idempotency-barrier-${runId}`),
		aggregateVersion: '1',
		sourceSequence: '11'
	});
	trackEventId(barrier.eventId);
	await publishProjection(publisher, barrier);
	await waitForReceipt(barrier.eventId, CONSUMERS.identity, 'DELIVERED');
	const [receiptCount, projection] = await Promise.all([
		prisma.widgetsConsumerReceipt.count({
			where: { eventId, consumer: CONSUMERS.identity }
		}),
		prisma.widgetOwnerProjection.findUnique({
			where: { userId: aggregateId }
		})
	]);
	assert.equal(receiptCount, 1);
	assert.equal(
		projection?.updatedAt.toISOString(),
		firstProjection.updatedAt.toISOString(),
		'Duplicate projection mutated service-local state'
	);
}

async function assertConsumerRetry(publisher, adminChannel) {
	const aggregateId = trackAggregateId(`retry-${runId}`);
	const base = identityEvent({
		aggregateId,
		aggregateVersion: '1',
		sourceSequence: '20'
	});
	trackEventId(base.eventId);
	await publishProjection(publisher, base);
	await waitForReceipt(base.eventId, CONSUMERS.identity, 'DELIVERED');

	const conflict = identityEvent({
		aggregateId,
		aggregateVersion: '1',
		sourceSequence: '21',
		hasPhoneIdentity: true
	});
	trackEventId(conflict.eventId);
	await publishProjection(publisher, conflict);
	const deduplicationKey = `projection-retry:${CONSUMERS.identity}:${conflict.eventId}:0:1`;
	let retryOutbox;
	await waitFor('transactional projection retry publication', async () => {
		const [receipt, outbox, queue] = await Promise.all([
			prisma.widgetsConsumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: conflict.eventId,
						consumer: CONSUMERS.identity
					}
				}
			}),
			prisma.widgetsOutboxEvent.findUnique({
				where: { deduplicationKey }
			}),
			adminChannel.checkQueue(`${QUEUES.identity}.retry.1`)
		]);
		retryOutbox = outbox;
		return (
			receipt?.status === 'RETRY_SCHEDULED' &&
			receipt.retryAttempt === 1 &&
			outbox?.exchange === 'RETRY' &&
			outbox.routingKey === 'identity.retry.1' &&
			outbox.status === 'PUBLISHED' &&
			queue.messageCount >= 1
		);
	});
	trackedOutboxIds.add(retryOutbox.id);
	await adminChannel.purgeQueue(`${QUEUES.identity}.retry.1`);

	const barrier = identityEvent({
		aggregateId: trackAggregateId(`retry-barrier-${runId}`),
		aggregateVersion: '1',
		sourceSequence: '22'
	});
	trackEventId(barrier.eventId);
	await publishProjection(publisher, barrier);
	await waitForReceipt(barrier.eventId, CONSUMERS.identity, 'DELIVERED');
}

async function assertConsumerDeadLetter(publisher, adminChannel) {
	const deadQueue = `${QUEUES.identity}.dead-letter`;
	await adminChannel.purgeQueue(deadQueue);
	const poisonId = trackEventId(randomUUID());
	await publishConfirmed(
		publisher,
		EVENTS_EXCHANGE,
		ROUTING_KEYS.identity,
		Buffer.from('{not-json'),
		{
			messageId: poisonId,
			type: ROUTING_KEYS.identity,
			correlationId: poisonId,
			headers: {
				'x-retry-attempt': 0,
				'x-manual-retry-cycle': 0
			}
		}
	);
	let poisonMessage;
	await waitFor('projection poison dead-letter', async () => {
		poisonMessage = await adminChannel.get(deadQueue, { noAck: false });
		return Boolean(poisonMessage);
	});
	const poisonPayload = JSON.parse(poisonMessage.content.toString('utf8'));
	assert.equal(poisonPayload.eventType, 'widgets.poison.v1');
	assert.equal(poisonPayload.poisonId, poisonId);
	adminChannel.ack(poisonMessage);

	const barrier = identityEvent({
		aggregateId: trackAggregateId(`dead-letter-barrier-${runId}`),
		aggregateVersion: '1',
		sourceSequence: '30'
	});
	trackEventId(barrier.eventId);
	await publishProjection(publisher, barrier);
	await waitForReceipt(barrier.eventId, CONSUMERS.identity, 'DELIVERED');
}

async function assertProviderConsumerAckAndDeadLetter(
	publisher,
	adminChannel
) {
	const deadQueue = `${QUEUES.webhook}.dead-letter`;
	await adminChannel.purgeQueue(deadQueue);
	for (let index = 0; index < 2; index += 1) {
		const poisonId = trackEventId(randomUUID());
		await publishConfirmed(
			publisher,
			EVENTS_EXCHANGE,
			ROUTING_KEYS.webhook,
			Buffer.from('{not-json'),
			{
				messageId: poisonId,
				type: 'lead.integration.requested.v2',
				correlationId: poisonId,
				headers: {
					'x-retry-attempt': 0,
					'x-manual-retry-cycle': 0
				}
			}
		);
		let poisonMessage;
		await waitFor('provider poison dead-letter', async () => {
			poisonMessage = await adminChannel.get(deadQueue, {
				noAck: false
			});
			return Boolean(poisonMessage);
		});
		try {
			const poisonPayload = JSON.parse(
				poisonMessage.content.toString('utf8')
			);
			assert.equal(
				poisonPayload.eventType,
				'widgets.integration.poison.v1'
			);
			assert.equal(poisonPayload.poisonId, poisonId);
		} finally {
			adminChannel.ack(poisonMessage);
		}
	}
}

async function createOutbox(data) {
	const outbox = await prisma.widgetsOutboxEvent.create({
		data: {
			...data,
			headers: data.headers || {
				'x-correlation-id': data.messageId
			},
			attempts: data.attempts || 0,
			status: 'PENDING'
		}
	});
	trackedOutboxIds.add(outbox.id);
	return outbox;
}

async function assertPublishedOutboxAndMessage(
	outboxId,
	channel,
	queue,
	messageId,
	payloadAssertion
) {
	let message;
	await waitFor('confirmed Outbox publication', async () => {
		const outbox = await prisma.widgetsOutboxEvent.findUnique({
			where: { id: outboxId }
		});
		if (outbox?.status !== 'PUBLISHED' || outbox.attempts !== 1) {
			return false;
		}
		message = await channel.get(queue, { noAck: false });
		return Boolean(message);
	});
	try {
		assert.equal(message.properties.messageId, messageId);
		assert(payloadAssertion(JSON.parse(message.content.toString('utf8'))));
	} finally {
		channel.ack(message);
	}
}

function identityEvent({
	aggregateId,
	aggregateVersion,
	sourceSequence,
	hasPhoneIdentity = false
}) {
	const eventId = randomUUID();
	return {
		schemaVersion: 1,
		eventType: ROUTING_KEYS.identity,
		eventId,
		aggregateId,
		aggregateVersion,
		sourceSequence,
		occurredAt: new Date().toISOString(),
		tombstone: false,
		state: {
			id: aggregateId,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: new Date().toISOString(),
			deletedAt: null,
			status: 'ACTIVE',
			roles: ['USER'],
			hasEmailIdentity: true,
			hasPhoneIdentity,
			hasTelegramIdentity: false,
			loginMethodCount: 1
		}
	};
}

function leadIntegrationPayload(integration, eventId) {
	return {
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		integration,
		source: 'widget',
		entity: {
			id: `entity-${runId}`,
			name: 'Widgets Rabbit CI'
		},
		lead: {
			id: eventId,
			createdAt: new Date().toISOString()
		},
		destination:
			integration === 'email'
				? { email: 'widgets-rabbit-ci@example.test' }
				: { telegramChatId: 'widgets-rabbit-ci' }
	};
}

async function publishProjection(channel, event) {
	await publishConfirmed(
		channel,
		EVENTS_EXCHANGE,
		event.eventType,
		Buffer.from(JSON.stringify(event, null, 2)),
		{
			messageId: event.eventId,
			type: event.eventType,
			correlationId: event.eventId,
			headers: {
				'x-retry-attempt': 0,
				'x-manual-retry-cycle': 0
			}
		}
	);
}

async function publishConfirmed(
	channel,
	exchange,
	routingKey,
	content,
	options
) {
	const token = randomUUID();
	let returned = null;
	const onReturn = message => {
		if (message.properties.headers?.['x-widgets-ci-token'] === token) {
			returned = message;
		}
	};
	channel.on('return', onReturn);
	try {
		channel.publish(exchange, routingKey, content, {
			mandatory: true,
			persistent: true,
			contentType: 'application/json',
			...options,
			headers: {
				...(options.headers || {}),
				'x-widgets-ci-token': token
			}
		});
		await channel.waitForConfirms();
		await new Promise(resolve => setImmediate(resolve));
		if (returned) {
			throw new Error(
				`Admin AMQP fixture publication was returned routingKey=${routingKey}`
			);
		}
	} finally {
		channel.off('return', onReturn);
	}
}

async function waitForReceipt(eventId, consumer, status) {
	await waitFor(`receipt ${eventId} ${status}`, async () => {
		const receipt = await prisma.widgetsConsumerReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		return receipt?.status === status;
	});
}

async function assertForeignQueueDenied(connection, queue, operation) {
	const channel = await connection.createChannel();
	const expectedMethod =
		operation === 'configure'
			? { classId: 50, methodId: 10 }
			: { classId: 60, methodId: 70 };
	const channelErrors = [];
	let channelClosed = false;
	let resolveChannelClosed;
	const channelClosedPromise = new Promise(resolve => {
		resolveChannelClosed = resolve;
	});
	const captureChannelError = error => channelErrors.push(error);
	channel.on('error', captureChannelError);
	channel.once('close', () => {
		channelClosed = true;
		resolveChannelClosed();
	});
	let failure = null;
	try {
		let operationError = null;
		try {
			if (operation === 'configure') {
				await channel.checkQueue(queue);
			} else {
				await channel.get(queue, { noAck: true });
			}
		} catch (error) {
			operationError = error;
		}
		if (!operationError) {
			throw new Error(
				`Widgets RabbitMQ user has forbidden ${operation} access to ${queue}`
			);
		}
		assertRabbitAccessRefused(
			operationError,
			expectedMethod,
			`${operation} RPC`
		);
		await withTimeout(
			channelClosedPromise,
			2_000,
			`RabbitMQ did not close the denied ${operation} channel`
		);
		assert.equal(channelErrors.length, 1);
		assertRabbitAccessRefused(
			channelErrors[0],
			expectedMethod,
			`${operation} channel`
		);
	} catch (error) {
		failure = error;
	}
	if (!channelClosed) {
		await channel.close().catch(error => {
			if (!failure) failure = error;
		});
	}
	channel.off('error', captureChannelError);
	if (failure) throw failure;
}

async function assertTopicWriteDenied(connection, routingKey) {
	const channel = await connection.createConfirmChannel();
	const expectedMethod = { classId: 60, methodId: 40 };
	const channelErrors = [];
	let channelClosed = false;
	let resolveChannelClosed;
	const channelClosedPromise = new Promise(resolve => {
		resolveChannelClosed = resolve;
	});
	channel.on('error', error => channelErrors.push(error));
	channel.once('close', () => {
		channelClosed = true;
		resolveChannelClosed();
	});
	let operationError = null;
	try {
		channel.publish(EVENTS_EXCHANGE, routingKey, Buffer.from('{}'), {
			mandatory: true,
			messageId: randomUUID(),
			type: routingKey
		});
		await channel.waitForConfirms();
	} catch (error) {
		operationError = error;
	}
	if (!operationError) {
		if (!channelClosed) await channel.close().catch(() => undefined);
		throw new Error(
			`Widgets RabbitMQ user can impersonate upstream topic ${routingKey}`
		);
	}
	assert.ok(
		operationError instanceof Error,
		'topic write RPC must reject the pending publisher confirm'
	);
	await withTimeout(
		channelClosedPromise,
		2_000,
		'RabbitMQ did not close the denied topic-write channel'
	);
	assert.equal(channelErrors.length, 1);
	assertRabbitAccessRefused(
		channelErrors[0],
		expectedMethod,
		'topic write channel'
	);
}

function assertRabbitAccessRefused(error, expectedMethod, source) {
	const normalized = normalizeRabbitChannelClose(error, source);
	assert.equal(normalized.code, 403, `${source} must fail with AMQP 403`);
	assert.equal(normalized.classId, expectedMethod.classId);
	assert.equal(normalized.methodId, expectedMethod.methodId);
	assert.match(normalized.reason, /ACCESS[_-]REFUSED/i);
}

function normalizeRabbitChannelClose(error, source) {
	if (error instanceof Error) {
		return {
			code: error.code,
			reason: String(error.message),
			classId: error.classId,
			methodId: error.methodId
		};
	}
	if (
		error &&
		typeof error === 'object' &&
		error.fields &&
		typeof error.fields === 'object' &&
		!Array.isArray(error.fields)
	) {
		return {
			code: error.fields.replyCode,
			reason: String(error.fields.replyText),
			classId: error.fields.classId,
			methodId: error.fields.methodId
		};
	}
	assert.fail(`${source} has an unexpected amqplib channel-close shape`);
}

async function purgeWidgetsQueues(channel) {
	for (const queue of Object.values(QUEUES)) {
		for (const name of [
			queue,
			`${queue}.dead-letter`,
			`${queue}.retry.1`,
			`${queue}.retry.2`,
			`${queue}.retry.3`
		]) {
			await channel.purgeQueue(name);
		}
	}
}

async function deleteProviderRetryQueues(channel) {
	for (const kind of ['webhook', 'bitrix24', 'amo-crm']) {
		for (const index of [1, 2, 3]) {
			await channel.deleteQueue(`${QUEUES[kind]}.retry.${index}`, {
				ifEmpty: true,
				ifUnused: true
			});
		}
	}
}

async function cleanupDatabaseArtifacts() {
	const eventIds = [...trackedEventIds];
	const aggregateIds = [...trackedAggregateIds];
	const outboxIds = [...trackedOutboxIds];
	if (eventIds.length) {
		await prisma.widgetsConsumerFailure.deleteMany({
			where: { eventId: { in: eventIds } }
		});
		await prisma.widgetsConsumerReceipt.deleteMany({
			where: { eventId: { in: eventIds } }
		});
	}
	if (outboxIds.length || eventIds.length) {
		await prisma.widgetsOutboxEvent.deleteMany({
			where: {
				OR: [
					...(outboxIds.length ? [{ id: { in: outboxIds } }] : []),
					...(eventIds.length ? [{ messageId: { in: eventIds } }] : [])
				]
			}
		});
	}
	if (aggregateIds.length) {
		await prisma.widgetAggregateVersion.deleteMany({
			where: { aggregateId: { in: aggregateIds } }
		});
		await prisma.widgetOwnerProjection.deleteMany({
			where: { userId: { in: aggregateIds } }
		});
	}
}

function trackEventId(value) {
	trackedEventIds.add(value);
	return value;
}

function trackAggregateId(value) {
	trackedAggregateIds.add(value);
	return value;
}

async function waitForReady(port) {
	await waitFor(
		'Widgets messaging readiness',
		async () => {
			if (service.exitCode !== null) {
				throw new Error(
					`Widgets messaging process exited with ${service.exitCode}`
				);
			}
			const response = await fetch(
				`http://127.0.0.1:${port}/health/ready`,
				{ signal: AbortSignal.timeout(2_000) }
			);
			return response.ok;
		},
		30_000
	);
	const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
		signal: AbortSignal.timeout(2_000)
	});
	const raw = await response.text();
	if (
		!response.ok ||
		/postgres(?:ql)?:\/\//i.test(raw) ||
		/amqps?:\/\//i.test(raw)
	) {
		throw new Error('Widgets readiness exposed a credential or URL');
	}
	const payload = JSON.parse(raw);
	assert.deepEqual(
		{
			status: payload.status,
			service: payload.service,
			role: payload.role,
			revision: payload.revision
		},
		{
			status: 'ready',
			service: 'widgets',
			role: 'all',
			revision: 'widgets-messaging-integration'
		}
	);
}

async function waitFor(label, action, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			if (await action()) return;
		} catch (error) {
			lastError = error;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(
		`${label} timed out${lastError ? `: ${lastError.message}` : ''}`
	);
}

async function stopService(child) {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	if (await waitForProcessExit(child, 10_000)) return;
	child.kill('SIGKILL');
	if (!(await waitForProcessExit(child, 5_000))) {
		throw new Error('Widgets messaging child did not exit after SIGKILL');
	}
}

function waitForProcessExit(child, timeoutMs) {
	if (child.exitCode !== null) return Promise.resolve(true);
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			child.off('exit', onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once('exit', onExit);
	});
}

async function getFreePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not allocate a local port');
	}
	const port = address.port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

function requiredEnvironment(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function assertLocalTestDatabase(value, variableName) {
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\/+/, '')
	).toLowerCase();
	if (
		parsed.protocol !== 'postgresql:' ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!(databaseName.includes('test') || databaseName.endsWith('_ci'))
	) {
		throw new Error(
			`${variableName} must point to a local test or CI database`
		);
	}
	assertNotProductionValue(value, variableName);
}

function assertLocalTestRabbit(value, variableName) {
	const parsed = new URL(value);
	if (
		!['amqp:', 'amqps:'].includes(parsed.protocol) ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!parsed.username ||
		!parsed.password ||
		decodeURIComponent(parsed.pathname) !== '/winwidget'
	) {
		throw new Error(
			`${variableName} must use explicit credentials for the local winwidget test vhost`
		);
	}
	assertNotProductionValue(value, variableName);
}

function assertNotProductionValue(value, variableName) {
	for (const [name, configured] of Object.entries(process.env)) {
		if (name.includes('PRODUCTION') && configured?.trim() === value) {
			throw new Error(`${variableName} must not reuse ${name}`);
		}
	}
}

function redactCredentials(value) {
	return value.replace(
		/\b(postgresql|amqps?):\/\/[^\s/@]+:[^\s/@]+@/gi,
		'$1://[REDACTED]@'
	);
}

function withTimeout(promise, timeoutMs, message) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		})
	]);
}
