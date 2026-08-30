import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const amqp = require('amqplib');
const { PrismaClient } = require('@prisma/notification-delivery-client');
const { SMTPServer } = require('smtp-server');

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const allowPurge =
	process.env.NOTIFICATION_DELIVERY_INTEGRATION_ALLOW_PURGE === 'true';
const databaseUrl = process.env.NOTIFICATION_DELIVERY_DATABASE_URL;
const adminRabbitUrl = process.env.RABBITMQ_URL;
const workerRabbitUrl =
	process.env.NOTIFICATION_DELIVERY_TEST_RABBITMQ_URL;
const image = process.env.NOTIFICATION_DELIVERY_TEST_IMAGE?.trim();

if (!allowPurge) {
	throw new Error(
		'NOTIFICATION_DELIVERY_INTEGRATION_ALLOW_PURGE=true is required'
	);
}
if (!databaseUrl || !adminRabbitUrl || !workerRabbitUrl) {
	throw new Error(
		'NOTIFICATION_DELIVERY_DATABASE_URL, RABBITMQ_URL and NOTIFICATION_DELIVERY_TEST_RABBITMQ_URL are required'
	);
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function parseLocalUrl(rawValue, variableName, protocols) {
	let parsed;
	try {
		parsed = new URL(rawValue);
	} catch {
		throw new Error(`${variableName} must be a valid URL`);
	}
	if (
		!protocols.includes(parsed.protocol) ||
		!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
	) {
		throw new Error(
			`${variableName} must point to an allowed loopback test service`
		);
	}
	return parsed;
}

function assertNotProductionValue(rawValue, variableName) {
	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value?.trim() === rawValue.trim()) {
			throw new Error(`${variableName} must not reuse ${key}`);
		}
	}
}

function assertLocalTestDatabase(rawValue, variableName) {
	const parsed = parseLocalUrl(rawValue, variableName, [
		'postgres:',
		'postgresql:'
	]);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\//, '')
	).toLowerCase();
	if (!/(?:_ci|_test)$/.test(databaseName)) {
		throw new Error(
			`${variableName} database name must end with _ci or _test`
		);
	}
	assertNotProductionValue(rawValue, variableName);
}

function assertLocalTestRabbit(rawValue, variableName) {
	const parsed = parseLocalUrl(rawValue, variableName, ['amqp:']);
	if (
		decodeURIComponent(parsed.pathname.replace(/^\//, '')) !==
			'winwidget' ||
		!parsed.username ||
		!parsed.password
	) {
		throw new Error(
			`${variableName} must use authenticated local vhost winwidget`
		);
	}
	assertNotProductionValue(rawValue, variableName);
	return parsed;
}

assertLocalTestDatabase(databaseUrl, 'NOTIFICATION_DELIVERY_DATABASE_URL');
const adminRabbit = assertLocalTestRabbit(adminRabbitUrl, 'RABBITMQ_URL');
const workerRabbit = assertLocalTestRabbit(
	workerRabbitUrl,
	'NOTIFICATION_DELIVERY_TEST_RABBITMQ_URL'
);
if (adminRabbit.username === workerRabbit.username) {
	throw new Error(
		'Notification Delivery admin and restricted RabbitMQ users must differ'
	);
}

const EVENTS_EXCHANGE = 'winwidget.events';
const RETRY_EXCHANGE = 'winwidget.retry';
const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';
const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000];
const INTERNAL_TOKEN = 'notification_delivery_integration_token_32_chars';
const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTED_RETENTION_DETAIL = '[redacted after retention]';
const KINDS = {
	email: {
		queue: 'winwidget.lead-integration.email',
		routingKey: 'lead.integration.email.v2'
	},
	telegram: {
		queue: 'winwidget.lead-integration.telegram',
		routingKey: 'lead.integration.telegram.v2'
	},
	'payment-email': {
		queue: 'winwidget.payment-notification.email',
		routingKey: 'payment.succeeded.v1'
	},
	'payment-telegram': {
		queue: 'winwidget.payment-notification.telegram.v2',
		routingKey: 'payment.notification.telegram.requested.v1'
	},
	'limit-email': {
		queue: 'winwidget.limit-notification.email',
		routingKey: 'lead.limit.reached.email.v2'
	},
	'limit-telegram': {
		queue: 'winwidget.limit-notification.telegram',
		routingKey: 'lead.limit.reached.telegram.v2'
	},
	'campaign-email': {
		queue: 'winwidget.notification.campaign.email.v2',
		routingKey: 'notification.campaign.email.requested.v2'
	},
	'campaign-telegram': {
		queue: 'winwidget.notification.campaign.telegram.v2',
		routingKey: 'notification.campaign.telegram.requested.v2'
	},
	'daily-summary-delivery-telegram': {
		queue: 'winwidget.notification.daily-summary.telegram',
		routingKey: 'notification.daily-summary.telegram.requested.v1'
	},
	'subscription-expiry-email': {
		queue: 'winwidget.notification.subscription-expiry.email',
		routingKey: 'notification.subscription-expiry.email.requested.v1'
	},
	'subscription-expiry-telegram': {
		queue: 'winwidget.notification.subscription-expiry.telegram',
		routingKey: 'notification.subscription-expiry.telegram.requested.v1'
	}
};

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
let rabbitConnection;
let rabbitChannel;
let smtpServer;
let telegramServer;
let serviceProcess;
let containerName;
let serviceLogs = '';
let retentionStartupBlock;

const smtpMessages = [];
const telegramMessages = [];
const rejectedRecipients = new Set();

const sleep = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(label, action, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const result = await action();
			if (result) return result;
		} catch (error) {
			lastError = error;
		}
		await sleep(200);
	}
	throw new Error(
		`${label} timed out${lastError ? `: ${lastError.message}` : ''}`
	);
}

async function startSmtpMock() {
	smtpServer = new SMTPServer({
		authOptional: true,
		disabledCommands: ['STARTTLS'],
		onAuth(auth, session, callback) {
			callback(null, { user: auth.username || 'integration' });
		},
		onRcptTo(address, session, callback) {
			const recipient = address.address.toLowerCase();
			if (rejectedRecipients.has(recipient)) {
				const error = new Error('5.1.1 Mailbox unavailable');
				error.responseCode = 550;
				callback(error);
				return;
			}
			callback();
		},
		onData(stream, session, callback) {
			const chunks = [];
			stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
			stream.on('error', callback);
			stream.on('end', () => {
				smtpMessages.push({
					recipients: session.envelope.rcptTo.map(item =>
						item.address.toLowerCase()
					),
					raw: Buffer.concat(chunks).toString('utf8')
				});
				callback();
			});
		}
	});
	await new Promise((resolve, reject) => {
		smtpServer.once('error', reject);
		smtpServer.listen(0, '127.0.0.1', resolve);
	});
	return smtpServer.server.address().port;
}

async function startTelegramMock() {
	telegramServer = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString('utf8');
		if (
			request.method !== 'POST' ||
			request.url !== '/botintegration-token/sendMessage'
		) {
			response.writeHead(404, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ ok: false }));
			return;
		}
		const payload = JSON.parse(body);
		telegramMessages.push(payload);
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(
			JSON.stringify({
				ok: true,
				result: { message_id: telegramMessages.length }
			})
		);
	});
	await new Promise((resolve, reject) => {
		telegramServer.once('error', reject);
		telegramServer.listen(0, '127.0.0.1', resolve);
	});
	return telegramServer.address().port;
}

async function assertTopologyAndPurge() {
	await rabbitChannel.assertExchange(EVENTS_EXCHANGE, 'topic', {
		durable: true
	});
	await rabbitChannel.assertExchange(RETRY_EXCHANGE, 'direct', {
		durable: true
	});
	await rabbitChannel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', {
		durable: true
	});
	await rabbitChannel.assertExchange(MANUAL_RETRY_EXCHANGE, 'direct', {
		durable: true
	});

	for (const [kind, definition] of Object.entries(KINDS)) {
		const deadLetterQueue = `${definition.queue}.dead-letter`;
		await rabbitChannel.assertQueue(definition.queue, { durable: true });
		await rabbitChannel.bindQueue(
			definition.queue,
			EVENTS_EXCHANGE,
			definition.routingKey
		);
		await rabbitChannel.bindQueue(
			definition.queue,
			EVENTS_EXCHANGE,
			`manual.${kind}`
		);
		await rabbitChannel.bindQueue(
			definition.queue,
			MANUAL_RETRY_EXCHANGE,
			kind
		);
		await rabbitChannel.assertQueue(deadLetterQueue, { durable: true });
		await rabbitChannel.bindQueue(
			deadLetterQueue,
			DEAD_LETTER_EXCHANGE,
			`${kind}.dead-letter`
		);
		await rabbitChannel.bindQueue(
			deadLetterQueue,
			EVENTS_EXCHANGE,
			`${kind}.dead-letter`
		);
		await rabbitChannel.purgeQueue(definition.queue);
		await rabbitChannel.purgeQueue(deadLetterQueue);

		for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
			const retryQueue = `${definition.queue}.retry-v2.${index + 1}`;
			await rabbitChannel.assertQueue(retryQueue, {
				durable: true,
				messageTtl: delay,
				deadLetterExchange: MANUAL_RETRY_EXCHANGE,
				deadLetterRoutingKey: kind
			});
			await rabbitChannel.bindQueue(
				retryQueue,
				RETRY_EXCHANGE,
				`${kind}.retry.${index + 1}`
			);
			await rabbitChannel.purgeQueue(retryQueue);
		}
	}
}

async function cleanupDatabase() {
	await prisma.$transaction([
		prisma.notificationDeliveryControlAction.deleteMany(),
		prisma.notificationDeliveryFailure.deleteMany(),
		prisma.notificationDeliveryReceipt.deleteMany(),
		prisma.notificationDeliveryOutboxEvent.deleteMany(),
		prisma.notificationDeliveryHeartbeat.deleteMany()
	]);
}

async function assertRetentionCatalogContract() {
	const [version] = await prisma.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::int AS version"
	);
	assert.ok(
		Number(version.version) >= 180_000 &&
			Number(version.version) < 190_000,
		`Notification Delivery retention requires PostgreSQL 18, got ${version.version}`
	);

	const indexes = await prisma.$queryRawUnsafe(
		"SELECT indexname FROM pg_indexes WHERE schemaname = 'notification_delivery'"
	);
	const indexNames = new Set(indexes.map(index => index.indexname));
	for (const name of [
		'notification_outbox_events_retention_idx',
		'delivery_receipts_retention_idx',
		'delivery_failures_retention_idx'
	]) {
		assert.ok(indexNames.has(name), `Missing retention index ${name}`);
	}

	const constraints = await prisma.$queryRawUnsafe(`
		SELECT constraint_state.conname,
			constraint_state.contype,
			constraint_state.confdeltype,
			constraint_state.convalidated
		FROM pg_constraint AS constraint_state
		JOIN pg_namespace AS namespace_state
			ON namespace_state.oid = constraint_state.connamespace
		WHERE namespace_state.nspname = 'notification_delivery'
			AND constraint_state.conname IN (
				'control_actions_failure_id_fkey',
				'delivery_receipts_state_check',
				'delivery_failures_resolution_check',
				'control_actions_content_check'
			)
	`);
	const byName = new Map(
		constraints.map(constraint => [constraint.conname, constraint])
	);
	for (const name of [
		'delivery_receipts_state_check',
		'delivery_failures_resolution_check',
		'control_actions_content_check'
	]) {
		assert.equal(byName.get(name)?.contype, 'c');
		assert.equal(byName.get(name)?.convalidated, true);
	}
	assert.equal(
		byName.get('control_actions_failure_id_fkey')?.contype,
		'f'
	);
	assert.equal(
		byName.get('control_actions_failure_id_fkey')?.confdeltype,
		'r'
	);
	assert.equal(
		byName.get('control_actions_failure_id_fkey')?.convalidated,
		true
	);
}

async function seedRetentionStartupFixture() {
	const runId = randomUUID();
	const now = Date.now();
	const atAge = days => new Date(now - days * DAY_MS);
	const future = new Date(now + DAY_MS);
	const lockedAt = new Date(now - 60_000);

	const createOutbox = async (label, status, days, overrides = {}) => {
		const timestamp = atAge(days);
		return prisma.notificationDeliveryOutboxEvent.create({
			data: {
				messageId: randomUUID(),
				deduplicationKey: `retention:${runId}:outbox:${label}`,
				exchange: 'EVENTS',
				eventType: 'notification.retention.fixture.v1',
				routingKey: 'manual.email',
				payload: { runId, label, detail: 'retention fixture' },
				headers: { source: 'retention-integration' },
				status,
				availableAt: timestamp,
				publishedAt: status === 'PUBLISHED' ? timestamp : null,
				lastError:
					status === 'FAILED' ? 'active failure must remain' : null,
				createdAt: timestamp,
				updatedAt: timestamp,
				...overrides
			}
		});
	};

	const createReceipt = async (label, status, days, overrides = {}) => {
		const timestamp = atAge(days);
		return prisma.notificationDeliveryReceipt.create({
			data: {
				eventId: randomUUID(),
				consumer: 'email',
				status,
				deliveredAt: status === 'DELIVERED' ? timestamp : null,
				checkpoint: { runId, label, detail: 'retention fixture' },
				createdAt: timestamp,
				updatedAt: timestamp,
				...overrides
			}
		});
	};

	const createFailure = async (
		label,
		resolution,
		days,
		overrides = {}
	) => {
		const timestamp = atAge(days);
		return prisma.notificationDeliveryFailure.create({
			data: {
				eventId: randomUUID(),
				consumer: 'email',
				routingKey: 'manual.email',
				payload: {
					runId,
					label,
					contact: 'retention-fixture@example.test'
				},
				headers: { source: 'retention-integration' },
				attempts: 3,
				lastError: `retention detail ${label}`,
				category: 'PERMANENT',
				normalizedCode: 'RETENTION_INTEGRATION',
				safeReason: `safe retention detail ${label}`,
				httpStatus: 422,
				providerCode: 'RETENTION_PROVIDER_CODE',
				retryable: false,
				classificationVersion: 1,
				firstFailedAt: timestamp,
				failedAt: timestamp,
				resolvedAt: resolution ? timestamp : null,
				resolution,
				resolutionComment:
					resolution === 'CLOSED_NO_RETRY'
						? `retention resolution ${label}`
						: null,
				resolvedById:
					resolution === 'CLOSED_NO_RETRY'
						? `retention-actor-${runId}`
						: null,
				createdAt: timestamp,
				updatedAt: timestamp,
				...overrides
			}
		});
	};

	const createAction = (failure, action, comment = null) =>
		prisma.notificationDeliveryControlAction.create({
			data: {
				action,
				failureId: failure.id,
				eventId: failure.eventId,
				kind: failure.consumer,
				actorId: `retention-actor-${runId}`,
				comment,
				createdAt: failure.resolvedAt || failure.failedAt
			}
		});

	const outbox = {
		oldPublished: await createOutbox('old-published', 'PUBLISHED', 8),
		freshPublished: await createOutbox('fresh-published', 'PUBLISHED', 6),
		pending: await createOutbox('old-pending', 'PENDING', 400, {
			availableAt: future
		}),
		publishing: await createOutbox('old-publishing', 'PUBLISHING', 400, {
			lockedAt,
			lockedBy: `retention-lock-${runId}`,
			lockToken: randomUUID(),
			leaseExpiresAt: future
		}),
		failed: await createOutbox('old-failed', 'FAILED', 400)
	};

	const receipts = {
		oldDelivered: await createReceipt('old-delivered', 'DELIVERED', 91),
		freshDelivered: await createReceipt(
			'fresh-delivered',
			'DELIVERED',
			89
		),
		processing: await createReceipt('old-processing', 'PROCESSING', 400, {
			lockedAt,
			lockedBy: `retention-lock-${runId}`,
			lockToken: randomUUID(),
			leaseExpiresAt: future
		}),
		retryScheduled: await createReceipt(
			'old-retry-scheduled',
			'RETRY_SCHEDULED',
			400,
			{
				retryAttempt: 2,
				retryAvailableAt: future,
				retryToken: randomUUID()
			}
		),
		deadLettered: await createReceipt(
			'old-dead-lettered',
			'DEAD_LETTERED',
			400
		),
		closedNoRetry: await createReceipt(
			'old-closed-no-retry',
			'CLOSED_NO_RETRY',
			400
		)
	};

	const failures = {
		redactedDelivered: await createFailure(
			'redacted-delivered',
			'DELIVERED',
			31
		),
		redactedClosed: await createFailure(
			'redacted-closed',
			'CLOSED_NO_RETRY',
			31
		),
		freshClosed: await createFailure(
			'fresh-closed',
			'CLOSED_NO_RETRY',
			29
		),
		nearExpiryDelivered: await createFailure(
			'near-expiry-delivered',
			'DELIVERED',
			364
		),
		expiredDelivered: await createFailure(
			'expired-delivered',
			'DELIVERED',
			366
		),
		expiredClosed: await createFailure(
			'expired-closed',
			'CLOSED_NO_RETRY',
			366
		),
		unresolved: await createFailure('unresolved', null, 400),
		retrying: await createFailure('retrying', null, 400, {
			retryingAt: atAge(1),
			activeRetryToken: randomUUID()
		})
	};

	const actions = {
		redactedDelivered: await createAction(
			failures.redactedDelivered,
			'RETRY'
		),
		redactedClosed: await createAction(
			failures.redactedClosed,
			'CLOSE',
			'redact this operator comment'
		),
		freshClosed: await createAction(
			failures.freshClosed,
			'CLOSE',
			'keep this fresh operator comment'
		),
		nearExpiryDelivered: await createAction(
			failures.nearExpiryDelivered,
			'RETRY'
		),
		expiredDelivered: await createAction(
			failures.expiredDelivered,
			'RETRY'
		),
		expiredClosed: await createAction(
			failures.expiredClosed,
			'CLOSE',
			'delete this child before its parent'
		)
	};

	const heartbeats = {
		old: await prisma.notificationDeliveryHeartbeat.create({
			data: {
				service: 'retention-integration-old',
				instanceId: runId,
				metadata: { runId, state: 'old' },
				lastSeenAt: atAge(8),
				createdAt: atAge(8),
				updatedAt: atAge(8)
			}
		}),
		fresh: await prisma.notificationDeliveryHeartbeat.create({
			data: {
				service: 'retention-integration-fresh',
				instanceId: runId,
				metadata: { runId, state: 'fresh' },
				lastSeenAt: atAge(6),
				createdAt: atAge(6),
				updatedAt: atAge(6)
			}
		})
	};

	return { runId, outbox, receipts, failures, actions, heartbeats };
}

async function assertRetentionForeignKey(fixture) {
	await assert.rejects(
		prisma.notificationDeliveryFailure.delete({
			where: { id: fixture.failures.expiredClosed.id }
		}),
		error =>
			error?.code === 'P2003' ||
			error?.code === 'P2014' ||
			String(error).includes('control_actions_failure_id_fkey')
	);
	assert.ok(
		await prisma.notificationDeliveryControlAction.findUnique({
			where: { id: fixture.actions.expiredClosed.id }
		})
	);
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function acquireRetentionStartupBlock() {
	const locked = deferred();
	const released = deferred();
	let didRelease = false;
	const completed = prisma.$transaction(
		async transaction => {
			await transaction.$executeRawUnsafe(
				'LOCK TABLE "notification_delivery"."delivery_failures" IN ACCESS EXCLUSIVE MODE'
			);
			locked.resolve();
			await released.promise;
		},
		{ maxWait: 10_000, timeout: 90_000 }
	);
	void completed.catch(error => locked.reject(error));
	await locked.promise;
	return {
		completed,
		release() {
			if (didRelease) return;
			didRelease = true;
			released.resolve();
		}
	};
}

async function releaseRetentionStartupBlock() {
	if (!retentionStartupBlock) return;
	const block = retentionStartupBlock;
	retentionStartupBlock = undefined;
	block.release();
	await block.completed;
}

async function retentionReachedFailureStage(fixture) {
	const [oldOutbox, oldReceipt] = await Promise.all([
		prisma.notificationDeliveryOutboxEvent.findUnique({
			where: { id: fixture.outbox.oldPublished.id }
		}),
		prisma.notificationDeliveryReceipt.findUnique({
			where: { id: fixture.receipts.oldDelivered.id }
		})
	]);
	return (
		oldOutbox === null &&
		oldReceipt?.detailsRedactedAt instanceof Date &&
		oldReceipt.checkpoint === null
	);
}

async function assertRetentionStartupFixture(fixture) {
	await assertOutboxRetentionFixture(fixture);
	await assertReceiptRetentionFixture(fixture);
	await assertFailureRetentionFixture(fixture);
	await assertHeartbeatRetentionFixture(fixture);
}

async function assertOutboxRetentionFixture(fixture) {
	const expected = [
		fixture.outbox.oldPublished,
		fixture.outbox.freshPublished,
		fixture.outbox.pending,
		fixture.outbox.publishing,
		fixture.outbox.failed
	];
	const rows = await prisma.notificationDeliveryOutboxEvent.findMany({
		where: { id: { in: expected.map(row => row.id) } }
	});
	const byId = new Map(rows.map(row => [row.id, row]));
	assert.equal(byId.has(fixture.outbox.oldPublished.id), false);
	for (const [name, status] of [
		['freshPublished', 'PUBLISHED'],
		['pending', 'PENDING'],
		['publishing', 'PUBLISHING'],
		['failed', 'FAILED']
	]) {
		assert.equal(byId.get(fixture.outbox[name].id)?.status, status);
		assert.equal(
			byId.get(fixture.outbox[name].id)?.payload?.label,
			fixture.outbox[name].payload.label
		);
	}
}

async function assertReceiptRetentionFixture(fixture) {
	const expected = Object.values(fixture.receipts);
	const rows = await prisma.notificationDeliveryReceipt.findMany({
		where: { id: { in: expected.map(row => row.id) } }
	});
	assert.equal(rows.length, expected.length);
	const byId = new Map(rows.map(row => [row.id, row]));
	const oldDelivered = byId.get(fixture.receipts.oldDelivered.id);
	assert.equal(
		oldDelivered.eventId,
		fixture.receipts.oldDelivered.eventId
	);
	assert.equal(oldDelivered.consumer, 'email');
	assert.equal(oldDelivered.status, 'DELIVERED');
	assert.equal(
		oldDelivered.deliveredAt.toISOString(),
		fixture.receipts.oldDelivered.deliveredAt.toISOString()
	);
	assert.equal(oldDelivered.checkpoint, null);
	assert.ok(oldDelivered.detailsRedactedAt instanceof Date);

	const freshDelivered = byId.get(fixture.receipts.freshDelivered.id);
	assert.deepEqual(
		freshDelivered.checkpoint,
		fixture.receipts.freshDelivered.checkpoint
	);
	assert.equal(freshDelivered.detailsRedactedAt, null);

	for (const name of [
		'processing',
		'retryScheduled',
		'deadLettered',
		'closedNoRetry'
	]) {
		const row = byId.get(fixture.receipts[name].id);
		assert.equal(row.status, fixture.receipts[name].status);
		assert.deepEqual(row.checkpoint, fixture.receipts[name].checkpoint);
		assert.equal(row.detailsRedactedAt, null);
	}

	await assert.rejects(
		prisma.notificationDeliveryReceipt.create({
			data: {
				eventId: oldDelivered.eventId,
				consumer: oldDelivered.consumer,
				status: 'DELIVERED',
				deliveredAt: new Date(),
				checkpoint: { duplicate: true }
			}
		}),
		error => error?.code === 'P2002'
	);
}

function assertRedactedFailure(actual, original) {
	assert.equal(actual.eventId, original.eventId);
	assert.equal(actual.consumer, original.consumer);
	assert.equal(actual.resolution, original.resolution);
	assert.equal(
		actual.resolvedAt.toISOString(),
		original.resolvedAt.toISOString()
	);
	assert.equal(actual.attempts, original.attempts);
	assert.equal(actual.category, original.category);
	assert.equal(actual.normalizedCode, original.normalizedCode);
	assert.equal(
		actual.classificationVersion,
		original.classificationVersion
	);
	assert.deepEqual(actual.payload, {});
	assert.deepEqual(actual.headers, {});
	assert.equal(actual.lastError, REDACTED_RETENTION_DETAIL);
	assert.equal(actual.safeReason, REDACTED_RETENTION_DETAIL);
	assert.equal(actual.httpStatus, null);
	assert.equal(actual.providerCode, null);
	assert.ok(actual.detailsRedactedAt instanceof Date);
	if (actual.resolution === 'CLOSED_NO_RETRY') {
		assert.equal(actual.resolutionComment, REDACTED_RETENTION_DETAIL);
		assert.equal(actual.resolvedById, original.resolvedById);
	} else {
		assert.equal(actual.resolutionComment, null);
		assert.equal(actual.resolvedById, null);
	}
}

async function assertFailureRetentionFixture(fixture) {
	const retainedNames = [
		'redactedDelivered',
		'redactedClosed',
		'freshClosed',
		'nearExpiryDelivered',
		'unresolved',
		'retrying'
	];
	const retained = await prisma.notificationDeliveryFailure.findMany({
		where: {
			id: {
				in: retainedNames.map(name => fixture.failures[name].id)
			}
		}
	});
	assert.equal(retained.length, retainedNames.length);
	const byId = new Map(retained.map(row => [row.id, row]));
	for (const name of [
		'redactedDelivered',
		'redactedClosed',
		'nearExpiryDelivered'
	]) {
		assertRedactedFailure(
			byId.get(fixture.failures[name].id),
			fixture.failures[name]
		);
	}

	const fresh = byId.get(fixture.failures.freshClosed.id);
	assert.deepEqual(fresh.payload, fixture.failures.freshClosed.payload);
	assert.deepEqual(fresh.headers, fixture.failures.freshClosed.headers);
	assert.equal(fresh.lastError, fixture.failures.freshClosed.lastError);
	assert.equal(fresh.safeReason, fixture.failures.freshClosed.safeReason);
	assert.equal(fresh.httpStatus, fixture.failures.freshClosed.httpStatus);
	assert.equal(
		fresh.providerCode,
		fixture.failures.freshClosed.providerCode
	);
	assert.equal(fresh.detailsRedactedAt, null);
	assert.equal(
		fresh.resolutionComment,
		fixture.failures.freshClosed.resolutionComment
	);

	for (const name of ['unresolved', 'retrying']) {
		const actual = byId.get(fixture.failures[name].id);
		const original = fixture.failures[name];
		assert.deepEqual(actual.payload, original.payload);
		assert.deepEqual(actual.headers, original.headers);
		assert.equal(actual.lastError, original.lastError);
		assert.equal(actual.safeReason, original.safeReason);
		assert.equal(actual.detailsRedactedAt, null);
		assert.equal(actual.resolvedAt, null);
		assert.equal(actual.resolution, null);
		assert.equal(actual.activeRetryToken, original.activeRetryToken);
		assert.equal(
			actual.retryingAt?.toISOString(),
			original.retryingAt?.toISOString()
		);
	}

	for (const name of ['expiredDelivered', 'expiredClosed']) {
		assert.equal(
			await prisma.notificationDeliveryFailure.findUnique({
				where: { id: fixture.failures[name].id }
			}),
			null
		);
		assert.equal(
			await prisma.notificationDeliveryControlAction.findUnique({
				where: { id: fixture.actions[name].id }
			}),
			null
		);
	}

	const redactedDeliveredAction =
		await prisma.notificationDeliveryControlAction.findUniqueOrThrow({
			where: { id: fixture.actions.redactedDelivered.id }
		});
	assert.equal(redactedDeliveredAction.comment, null);
	const redactedClosedAction =
		await prisma.notificationDeliveryControlAction.findUniqueOrThrow({
			where: { id: fixture.actions.redactedClosed.id }
		});
	assert.equal(redactedClosedAction.comment, REDACTED_RETENTION_DETAIL);
	const freshClosedAction =
		await prisma.notificationDeliveryControlAction.findUniqueOrThrow({
			where: { id: fixture.actions.freshClosed.id }
		});
	assert.equal(
		freshClosedAction.comment,
		fixture.actions.freshClosed.comment
	);
}

async function assertHeartbeatRetentionFixture(fixture) {
	assert.equal(
		await prisma.notificationDeliveryHeartbeat.findUnique({
			where: { id: fixture.heartbeats.old.id }
		}),
		null
	);
	const fresh =
		await prisma.notificationDeliveryHeartbeat.findUniqueOrThrow({
			where: { id: fixture.heartbeats.fresh.id }
		});
	assert.deepEqual(fresh.metadata, fixture.heartbeats.fresh.metadata);
	assert.equal(
		fresh.lastSeenAt.toISOString(),
		fixture.heartbeats.fresh.lastSeenAt.toISOString()
	);
}

async function assertOutcomeConstraintMatrix() {
	const probePrefix = `integration-outcome-constraint:${randomUUID()}`;
	const createProbe = (eventType, routingKey, suffix, sourceKind) =>
		prisma.notificationDeliveryOutboxEvent.create({
			data: {
				messageId: randomUUID(),
				deduplicationKey: `${probePrefix}:${suffix}`,
				exchange: 'EVENTS',
				eventType,
				routingKey,
				payload: { probe: true, sourceKind },
				headers: {}
			}
		});

	try {
		await createProbe(
			'notification.delivery.outcome.v1',
			'notification.delivery.outcome.v1',
			'v1',
			'subscription-expiry-email'
		);
		await createProbe(
			'notification.delivery.outcome.v2',
			'notification.delivery.outcome.v2',
			'v2',
			'campaign-email'
		);
		await createProbe(
			'reporting.notification.delivery.outcome.v1',
			'reporting.notification.delivery.outcome.v1',
			'reporting-v1',
			'daily-summary-delivery-telegram'
		);

		let mismatchRejected = false;
		try {
			await createProbe(
				'notification.delivery.outcome.v1',
				'notification.delivery.outcome.v2',
				'mismatch',
				'subscription-expiry-email'
			);
		} catch (error) {
			if (
				!String(error).includes(
					'notification_outbox_events_identity_check'
				)
			) {
				throw error;
			}
			mismatchRejected = true;
		}
		if (!mismatchRejected) {
			throw new Error(
				'Notification Delivery outcome constraint accepted a mismatched version'
			);
		}
	} finally {
		await prisma.notificationDeliveryOutboxEvent.deleteMany({
			where: {
				deduplicationKey: { startsWith: probePrefix }
			}
		});
	}
}

function appendServiceLog(chunk) {
	serviceLogs = `${serviceLogs}${chunk.toString('utf8')}`.slice(-20_000);
}

async function startService({ smtpPort, telegramPort, healthPort }) {
	const runtimeEnv = {
		...process.env,
		NODE_ENV: 'production',
		// The production image is under test, but external providers are local mocks.
		MODE: 'test',
		APP_REVISION: 'notification-delivery-integration',
		NOTIFICATION_DELIVERY_DATABASE_URL: databaseUrl,
		NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: INTERNAL_TOKEN,
		NOTIFICATION_DELIVERY_LISTEN_HOST: '127.0.0.1',
		NOTIFICATION_DELIVERY_HEALTH_PORT: String(healthPort),
		NOTIFICATION_DELIVERY_PREFETCH: '5',
		NOTIFICATION_DELIVERY_OUTBOX_POLL_INTERVAL_MS: '100',
		NOTIFICATION_DELIVERY_HEARTBEAT_INTERVAL_MS: '500',
		NOTIFICATION_DELIVERY_OUTBOX_RETENTION_DAYS: '7',
		NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS: '90',
		NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS: '30',
		RABBITMQ_URL: workerRabbitUrl,
		RABBITMQ_ASSERT_TOPOLOGY: 'false',
		RABBITMQ_CONNECTION_NAME: 'notification-delivery-integration',
		SMTP_SERVER: '127.0.0.1',
		SMTP_PORT: String(smtpPort),
		SMTP_SECURE: 'false',
		SMTP_LOGIN: 'integration',
		SMTP_PASSWORD: 'integration',
		SMTP_CONNECTION_TIMEOUT_MS: '3000',
		SMTP_GREETING_TIMEOUT_MS: '3000',
		SMTP_SOCKET_TIMEOUT_MS: '5000',
		TELEGRAM_INFO_BOT_TOKEN: 'integration-token',
		TELEGRAM_API_BASE_URL: `http://127.0.0.1:${telegramPort}`
	};

	if (image) {
		containerName = `winwidget-notification-delivery-integration-${process.pid}`;
		const envNames = [
			'NODE_ENV',
			'MODE',
			'APP_REVISION',
			'NOTIFICATION_DELIVERY_DATABASE_URL',
			'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
			'NOTIFICATION_DELIVERY_LISTEN_HOST',
			'NOTIFICATION_DELIVERY_HEALTH_PORT',
			'NOTIFICATION_DELIVERY_PREFETCH',
			'NOTIFICATION_DELIVERY_OUTBOX_POLL_INTERVAL_MS',
			'NOTIFICATION_DELIVERY_HEARTBEAT_INTERVAL_MS',
			'NOTIFICATION_DELIVERY_OUTBOX_RETENTION_DAYS',
			'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS',
			'NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS',
			'RABBITMQ_URL',
			'RABBITMQ_ASSERT_TOPOLOGY',
			'RABBITMQ_CONNECTION_NAME',
			'SMTP_SERVER',
			'SMTP_PORT',
			'SMTP_SECURE',
			'SMTP_LOGIN',
			'SMTP_PASSWORD',
			'SMTP_CONNECTION_TIMEOUT_MS',
			'SMTP_GREETING_TIMEOUT_MS',
			'SMTP_SOCKET_TIMEOUT_MS',
			'TELEGRAM_INFO_BOT_TOKEN',
			'TELEGRAM_API_BASE_URL'
		];
		serviceProcess = spawn(
			'docker',
			[
				'run',
				'--rm',
				'--name',
				containerName,
				'--network',
				'host',
				...envNames.flatMap(name => ['--env', name]),
				image
			],
			{
				cwd: appRoot,
				env: runtimeEnv,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
	} else {
		serviceProcess = spawn(
			process.execPath,
			[path.join(appRoot, 'dist/src/main.js')],
			{
				cwd: appRoot,
				env: runtimeEnv,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
	}
	serviceProcess.stdout.on('data', appendServiceLog);
	serviceProcess.stderr.on('data', appendServiceLog);
}

async function stopService() {
	if (!serviceProcess) return;
	if (containerName) {
		await new Promise(resolve => {
			const stop = spawn(
				'docker',
				['stop', '--time', '10', containerName],
				{ stdio: 'ignore' }
			);
			stop.once('exit', resolve);
			stop.once('error', resolve);
		});
	} else if (serviceProcess.exitCode === null) {
		serviceProcess.kill('SIGTERM');
	}
	await Promise.race([
		new Promise(resolve => serviceProcess.once('exit', resolve)),
		sleep(12_000)
	]);
}

async function getFreePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function requestJson(baseUrl, route, options = {}) {
	const response = await fetch(`${baseUrl}${route}`, {
		...options,
		headers: {
			...(options.body ? { 'Content-Type': 'application/json' } : {}),
			...(options.token
				? {
						'x-winwidget-internal-token': options.token,
						'x-winwidget-service': 'operations'
					}
				: {}),
			...(options.headers || {})
		}
	});
	const body = await response.json().catch(() => null);
	return { status: response.status, body };
}

async function publish(kind, eventId, payload) {
	const definition = KINDS[kind];
	rabbitChannel.publish(
		EVENTS_EXCHANGE,
		definition.routingKey,
		Buffer.from(JSON.stringify(payload)),
		{
			contentType: 'application/json',
			contentEncoding: 'utf-8',
			deliveryMode: 2,
			mandatory: true,
			messageId: eventId,
			type: payload.eventType,
			correlationId: eventId,
			headers: {
				'x-correlation-id': eventId,
				'x-request-id': eventId
			}
		}
	);
	await rabbitChannel.waitForConfirms();
}

async function waitForReceipt(eventId, consumer, status) {
	return waitFor(`${consumer} receipt ${status}`, async () => {
		const receipt = await prisma.notificationDeliveryReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		return receipt?.status === status ? receipt : null;
	});
}

const paymentPayload = (email, suffix) => ({
	schemaVersion: 1,
	eventType: 'payment.succeeded.v1',
	payment: {
		id: `payment-${suffix}`,
		yookassaId: `yookassa-${suffix}`,
		amount: '1000',
		plan: 'EASY',
		billingPeriod: 'MONTHLY',
		succeededAt: new Date().toISOString()
	},
	user: {
		id: `user-${suffix}`,
		name: 'Integration User',
		email,
		phone: null
	},
	subscription: {
		expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
	}
});

async function main() {
	const smtpPort = await startSmtpMock();
	const telegramPort = await startTelegramMock();
	const healthPort = await getFreePort();
	const baseUrl = `http://127.0.0.1:${healthPort}`;

	await prisma.$connect();
	await cleanupDatabase();
	await assertRetentionCatalogContract();
	await assertOutcomeConstraintMatrix();
	rabbitConnection = await amqp.connect(adminRabbitUrl);
	rabbitChannel = await rabbitConnection.createConfirmChannel();
	await assertTopologyAndPurge();

	const { queue: probeQueue } = await rabbitChannel.assertQueue('', {
		exclusive: true,
		autoDelete: true
	});
	await rabbitChannel.bindQueue(
		probeQueue,
		DEAD_LETTER_EXCHANGE,
		'payment-email.dead-letter'
	);
	const deadLetters = [];
	await rabbitChannel.consume(
		probeQueue,
		message => {
			if (message) deadLetters.push(message);
		},
		{ noAck: true }
	);
	const { queue: outcomeProbeQueue } = await rabbitChannel.assertQueue(
		'',
		{
			exclusive: true,
			autoDelete: true
		}
	);
	await rabbitChannel.bindQueue(
		outcomeProbeQueue,
		EVENTS_EXCHANGE,
		'notification.delivery.outcome.v2'
	);
	const campaignOutcomes = [];
	await rabbitChannel.consume(
		outcomeProbeQueue,
		message => {
			if (!message) return;
			campaignOutcomes.push(JSON.parse(message.content.toString('utf8')));
		},
		{ noAck: true }
	);
	const { queue: reportingOutcomeProbeQueue } =
		await rabbitChannel.assertQueue('', {
			exclusive: true,
			autoDelete: true
		});
	await rabbitChannel.bindQueue(
		reportingOutcomeProbeQueue,
		EVENTS_EXCHANGE,
		'reporting.notification.delivery.outcome.v1'
	);
	const reportingOutcomes = [];
	await rabbitChannel.consume(
		reportingOutcomeProbeQueue,
		message => {
			if (!message) return;
			reportingOutcomes.push(JSON.parse(message.content.toString('utf8')));
		},
		{ noAck: true }
	);
	const retentionFixture = await seedRetentionStartupFixture();
	await assertRetentionForeignKey(retentionFixture);
	retentionStartupBlock = await acquireRetentionStartupBlock();

	await startService({ smtpPort, telegramPort, healthPort });
	await waitFor('service liveness', async () => {
		if (serviceProcess.exitCode !== null) {
			throw new Error(
				`service exited with ${serviceProcess.exitCode}\n${serviceLogs}`
			);
		}
		const result = await requestJson(baseUrl, '/health/live');
		return result.status === 200 && result.body?.status === 'ok';
	});
	await waitFor('retention reaches the failure stage', () =>
		retentionReachedFailureStage(retentionFixture)
	);
	await waitFor('initial retention readiness gate', async () => {
		const result = await requestJson(baseUrl, '/health/ready');
		return result.status === 503 &&
			result.body?.message ===
				'Notification delivery retention is not ready'
			? result
			: null;
	});
	await releaseRetentionStartupBlock();
	await waitFor('service readiness', async () => {
		const result = await requestJson(baseUrl, '/health/ready');
		return result.status === 200 && result.body?.status === 'ready';
	});
	await assertRetentionStartupFixture(retentionFixture);

	const unauthorized = await requestJson(
		baseUrl,
		'/internal/notification-delivery/overview'
	);
	if (unauthorized.status !== 403) {
		throw new Error(
			`control API without token returned ${unauthorized.status}`
		);
	}

	const leadEmailId = randomUUID();
	const leadEmailRecipient = 'lead-success@example.test';
	const leadEmailPayload = {
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		integration: 'email',
		source: 'widget',
		entity: { id: 'widget-integration', name: 'Integration Widget' },
		lead: {
			id: 'lead-integration',
			name: 'Иван',
			phone: '+79990000000',
			createdAt: new Date().toISOString()
		},
		destination: { email: leadEmailRecipient }
	};
	await publish('email', leadEmailId, leadEmailPayload);
	await waitForReceipt(leadEmailId, 'email', 'DELIVERED');
	await waitFor('lead SMTP delivery', () =>
		smtpMessages.some(message =>
			message.recipients.includes(leadEmailRecipient)
		)
	);
	const leadDeliveryCount = smtpMessages.filter(message =>
		message.recipients.includes(leadEmailRecipient)
	).length;
	await publish('email', leadEmailId, leadEmailPayload);
	await waitFor('duplicate email queue drain', async () => {
		const queue = await rabbitChannel.checkQueue(KINDS.email.queue);
		return queue.messageCount === 0;
	});
	await sleep(500);
	if (
		smtpMessages.filter(message =>
			message.recipients.includes(leadEmailRecipient)
		).length !== leadDeliveryCount
	) {
		throw new Error('duplicate lead event was delivered twice');
	}

	const campaignEmailId = randomUUID();
	const campaignId = randomUUID();
	const campaignDeliveryId = randomUUID();
	const campaignCorrelationId = randomUUID();
	const campaignRecipient = 'campaign-success@example.test';
	await publish('campaign-email', campaignEmailId, {
		schemaVersion: 2,
		eventType: 'notification.campaign.email.requested.v2',
		eventId: campaignEmailId,
		occurredAt: new Date().toISOString(),
		correlationId: campaignCorrelationId,
		campaignId,
		deliveryId: campaignDeliveryId,
		dispatchGeneration: 1,
		reference: {
			type: 'campaign-delivery',
			id: campaignDeliveryId,
			aggregateId: campaignId,
			dispatchGeneration: 1
		},
		destination: { email: campaignRecipient },
		content: {
			subject: 'Campaign integration',
			message: 'Campaign delivery outcome v2'
		}
	});
	await waitForReceipt(campaignEmailId, 'campaign-email', 'DELIVERED');
	await waitFor('campaign SMTP delivery', () =>
		smtpMessages.some(message =>
			message.recipients.includes(campaignRecipient)
		)
	);
	await waitFor('campaign delivery outcome v2', () =>
		campaignOutcomes.find(
			outcome =>
				outcome?.schemaVersion === 2 &&
				outcome?.eventType === 'notification.delivery.outcome.v2' &&
				outcome?.sourceEventId === campaignEmailId &&
				outcome?.sourceKind === 'campaign-email' &&
				outcome?.campaignId === campaignId &&
				outcome?.deliveryId === campaignDeliveryId &&
				outcome?.dispatchGeneration === 1 &&
				outcome?.status === 'DELIVERED' &&
				outcome?.failure === null
		)
	);

	const telegramId = randomUUID();
	await publish('telegram', telegramId, {
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		integration: 'telegram',
		source: 'calculator',
		entity: { id: 'calculator-integration', name: 'Calculator' },
		lead: {
			id: 'telegram-lead',
			calculatedPrice: '5000',
			currency: '₽',
			createdAt: new Date().toISOString()
		},
		destination: { telegramChatId: '123456' }
	});
	await waitForReceipt(telegramId, 'telegram', 'DELIVERED');
	await waitFor('Telegram delivery', () =>
		telegramMessages.find(message => message.chat_id === '123456')
	);

	const paymentTelegramId = randomUUID();
	await publish('payment-telegram', paymentTelegramId, {
		schemaVersion: 1,
		eventType: 'payment.notification.telegram.requested.v1',
		payment: {
			id: 'payment-telegram-integration',
			yookassaId: 'yookassa-telegram-integration',
			amount: '1000',
			plan: 'EASY',
			billingPeriod: 'MONTHLY',
			succeededAt: new Date().toISOString()
		},
		user: {
			id: 'user-telegram-integration',
			name: 'Integration User',
			email: 'integration@example.test',
			phone: null
		},
		destination: {
			telegramChatId: '-1001234567890',
			messageThreadId: 42
		}
	});
	await waitForReceipt(paymentTelegramId, 'payment-telegram', 'DELIVERED');
	await waitFor('payment Telegram delivery', () =>
		telegramMessages.find(
			message =>
				message.chat_id === '-1001234567890' &&
				message.message_thread_id === 42 &&
				message.text.includes('Новый успешный платёж')
		)
	);

	const dailySummaryId = randomUUID();
	await publish('daily-summary-delivery-telegram', dailySummaryId, {
		schemaVersion: 1,
		eventType: 'notification.daily-summary.telegram.requested.v1',
		reference: {
			type: 'daily-summary-job',
			id: dailySummaryId
		},
		destination: {
			telegramChatId: '-1009876543210',
			messageThreadId: 2024
		},
		content: { text: '<b>Reporting integration summary</b>' }
	});
	await waitForReceipt(
		dailySummaryId,
		'daily-summary-delivery-telegram',
		'DELIVERED'
	);
	await waitFor('Reporting delivery outcome v1', () =>
		reportingOutcomes.find(
			outcome =>
				outcome?.schemaVersion === 1 &&
				outcome?.eventType ===
					'reporting.notification.delivery.outcome.v1' &&
				outcome?.sourceEventId === dailySummaryId &&
				outcome?.sourceKind === 'daily-summary-delivery-telegram' &&
				outcome?.reference?.type === 'daily-summary-job' &&
				outcome?.reference?.id === dailySummaryId &&
				outcome?.status === 'DELIVERED' &&
				outcome?.failure === null
		)
	);

	const limitId = randomUUID();
	const limitRecipient = 'limit-success@example.test';
	await publish('limit-email', limitId, {
		schemaVersion: 2,
		eventType: 'lead.limit.reached.email.v2',
		entity: {
			id: 'widget-limit-integration',
			name: 'Limited Widget',
			type: 'widget'
		},
		limit: 10,
		destination: { email: limitRecipient }
	});
	await waitForReceipt(limitId, 'limit-email', 'DELIVERED');
	await waitFor('limit SMTP delivery', () =>
		smtpMessages.some(message =>
			message.recipients.includes(limitRecipient)
		)
	);

	const limitTelegramId = randomUUID();
	await publish('limit-telegram', limitTelegramId, {
		schemaVersion: 2,
		eventType: 'lead.limit.reached.telegram.v2',
		entity: {
			id: 'widget-limit-telegram-integration',
			name: 'Limited Telegram Widget',
			type: 'widget'
		},
		limit: 10,
		destination: { telegramChatId: '654321' }
	});
	await waitForReceipt(limitTelegramId, 'limit-telegram', 'DELIVERED');
	await waitFor('limit Telegram delivery', () =>
		telegramMessages.find(
			message =>
				message.chat_id === '654321' &&
				message.text.includes('Лимит заявок исчерпан')
		)
	);

	const retryId = randomUUID();
	const retryRecipient = 'retry-failure@example.test';
	rejectedRecipients.add(retryRecipient);
	await publish(
		'payment-email',
		retryId,
		paymentPayload(retryRecipient, 'retry')
	);
	await waitForReceipt(retryId, 'payment-email', 'DEAD_LETTERED');
	const retryFailure = await waitFor('retry failure persistence', () =>
		prisma.notificationDeliveryFailure.findUnique({
			where: {
				eventId_consumer: {
					eventId: retryId,
					consumer: 'payment-email'
				}
			}
		})
	);
	await waitFor('dead-letter publication', () =>
		deadLetters.some(message => message.properties.messageId === retryId)
	);

	const failuresResponse = await requestJson(
		baseUrl,
		'/internal/notification-delivery/failures?status=FAILED',
		{ token: INTERNAL_TOKEN }
	);
	if (
		failuresResponse.status !== 200 ||
		!failuresResponse.body?.items?.some(
			item => item.id === retryFailure.id
		)
	) {
		throw new Error('control API did not return the persisted failure');
	}

	rejectedRecipients.delete(retryRecipient);
	const retryResponse = await requestJson(
		baseUrl,
		`/internal/notification-delivery/failures/${retryFailure.id}/retry`,
		{
			method: 'POST',
			token: INTERNAL_TOKEN,
			body: JSON.stringify({ actorId: 'ci-integration' })
		}
	);
	if (retryResponse.status !== 200) {
		throw new Error(
			`manual retry returned ${retryResponse.status}: ${JSON.stringify(retryResponse.body)}`
		);
	}
	await waitForReceipt(retryId, 'payment-email', 'DELIVERED');
	await waitFor('manual retry resolution', async () => {
		const failure = await prisma.notificationDeliveryFailure.findUnique({
			where: { id: retryFailure.id }
		});
		return failure?.resolution === 'DELIVERED';
	});
	await waitFor('retried SMTP delivery', () =>
		smtpMessages.some(message =>
			message.recipients.includes(retryRecipient)
		)
	);

	const closeId = randomUUID();
	const closeRecipient = 'close-failure@example.test';
	rejectedRecipients.add(closeRecipient);
	await publish(
		'payment-email',
		closeId,
		paymentPayload(closeRecipient, 'close')
	);
	await waitForReceipt(closeId, 'payment-email', 'DEAD_LETTERED');
	const closeFailure = await waitFor('close failure persistence', () =>
		prisma.notificationDeliveryFailure.findUnique({
			where: {
				eventId_consumer: {
					eventId: closeId,
					consumer: 'payment-email'
				}
			}
		})
	);
	const closeResponse = await requestJson(
		baseUrl,
		`/internal/notification-delivery/failures/${closeFailure.id}/close`,
		{
			method: 'POST',
			token: INTERNAL_TOKEN,
			body: JSON.stringify({
				actorId: 'ci-integration',
				comment: 'Integration test verified permanent failure'
			})
		}
	);
	if (closeResponse.status !== 200) {
		throw new Error(
			`failure close returned ${closeResponse.status}: ${JSON.stringify(closeResponse.body)}`
		);
	}
	await waitForReceipt(closeId, 'payment-email', 'CLOSED_NO_RETRY');
	const closedFailure =
		await prisma.notificationDeliveryFailure.findUnique({
			where: { id: closeFailure.id }
		});
	if (closedFailure?.resolution !== 'CLOSED_NO_RETRY') {
		throw new Error('closed failure has an invalid resolution');
	}

	const overview = await requestJson(
		baseUrl,
		'/internal/notification-delivery/overview',
		{ token: INTERNAL_TOKEN }
	);
	if (
		overview.status !== 200 ||
		overview.body?.heartbeat?.status !== 'ok' ||
		overview.body?.deliveredLast24Hours < 6
	) {
		throw new Error(
			`invalid control overview: ${JSON.stringify(overview.body)}`
		);
	}

	console.log(
		JSON.stringify({
			status: 'ok',
			image: image || 'local-dist',
			checked: [
				'health',
				'retention-startup-readiness',
				'retention-7-90-30-365',
				'retention-fk-and-constraints',
				'internal-token',
				'email',
				'telegram',
				'payment-email',
				'payment-telegram',
				'limit-email',
				'limit-telegram',
				'campaign-email',
				'campaign-outcome-v2',
				'reporting-outcome-v1',
				'outcome-constraint-matrix',
				'idempotency',
				'dead-letter',
				'manual-retry',
				'manual-close',
				'control-overview'
			]
		})
	);
}

let failure;
try {
	await main();
} catch (error) {
	failure = error;
	console.error(error instanceof Error ? error.stack : String(error));
	if (serviceLogs) {
		console.error('Notification Delivery logs:\n' + serviceLogs);
	}
} finally {
	await releaseRetentionStartupBlock().catch(() => undefined);
	await stopService().catch(() => undefined);
	if (rabbitChannel) {
		await assertTopologyAndPurge().catch(() => undefined);
		await rabbitChannel.close().catch(() => undefined);
	}
	if (rabbitConnection) {
		await rabbitConnection.close().catch(() => undefined);
	}
	await cleanupDatabase().catch(() => undefined);
	await prisma.$disconnect().catch(() => undefined);
	if (smtpServer) {
		await new Promise(resolve => smtpServer.close(resolve));
	}
	if (telegramServer) {
		await new Promise(resolve => telegramServer.close(resolve));
	}
}

if (failure) process.exitCode = 1;
