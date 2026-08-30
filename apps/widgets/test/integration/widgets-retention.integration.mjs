import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/widgets-client';

const databaseUrl = process.env.WIDGETS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	console.log(
		'SKIP Widgets retention: WIDGETS_TEST_DATABASE_URL is not set'
	);
	process.exit(0);
}
if (process.env.WIDGETS_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_MUTATION=true is required');
}
if (process.env.WIDGETS_INTEGRATION_ALLOW_PURGE !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_PURGE=true is required');
}
assertLocalTestDatabase(databaseUrl);

const retentionImported = await import(
	new URL(
		'../../dist/src/retention/widgets-retention.service.js',
		import.meta.url
	)
);
const runWidgetsRetentionCleanup =
	retentionImported.runWidgetsRetentionCleanup ||
	retentionImported.default?.runWidgetsRetentionCleanup;
if (!runWidgetsRetentionCleanup) {
	throw new Error('Compiled Widgets retention cleanup is unavailable');
}
const deliveryFailuresImported = await import(
	new URL(
		'../../dist/src/delivery-failures/widgets-delivery-failures.service.js',
		import.meta.url
	)
);
const WidgetsDeliveryFailuresService =
	deliveryFailuresImported.WidgetsDeliveryFailuresService ||
	deliveryFailuresImported.default?.WidgetsDeliveryFailuresService;
if (!WidgetsDeliveryFailuresService) {
	throw new Error(
		'Compiled Widgets delivery failure service is unavailable'
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-08-06T12:00:00.000Z');
const old = new Date(now.getTime() - 60 * DAY_MS);
const boundary = new Date(now.getTime() - 30 * DAY_MS);
const runId = randomUUID();
const tracked = {
	callbacks: [],
	outbox: [],
	consumerReceipts: [],
	consumerFailures: [],
	snapshots: [],
	integrationReceipts: [],
	integrationFailures: []
};
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});

try {
	await prisma.$connect();
	await assertPostgreSql18();
	await assertRetentionIndexes();
	const fixture = await seedFixture();

	const first = await runWidgetsRetentionCleanup(prisma, {
		outboxDays: 30,
		receiptDays: 30,
		failureDetailDays: 30,
		cleanupOutbox: true,
		cleanupOtpState: true,
		cleanupWorkerState: true,
		now,
		batchSize: 1,
		maxBatches: 10
	});
	assert.deepEqual(first, {
		consentPendingDeleted: 0,
		consentVerifiedDeleted: 0,
		callbackOtpChallengesDeleted: 1,
		callbackOtpChallengesRedacted: 1,
		callbackOtpRateBucketsDeleted: 0,
		publishedOutboxDeleted: 1,
		credentialSnapshotsDeleted: 2,
		integrationReceiptsCompacted: 2,
		consumerReceiptsCompacted: 1,
		integrationFailureDetailsRedacted: 2,
		consumerFailureDetailsRedacted: 1
	});

	await assertOutboxRetention(fixture);
	await assertCallbackOtpRetention(fixture);
	await assertConsumerRetention(fixture);
	await assertIntegrationRetention(fixture);
	await assertReceiptTombstones(fixture);
	await assertResolvedFailureActionCompatibility(fixture);

	const second = await runWidgetsRetentionCleanup(prisma, {
		outboxDays: 30,
		receiptDays: 30,
		failureDetailDays: 30,
		cleanupOutbox: true,
		cleanupOtpState: true,
		cleanupWorkerState: true,
		now,
		batchSize: 1,
		maxBatches: 10
	});
	assert.deepEqual(second, {
		consentPendingDeleted: 0,
		consentVerifiedDeleted: 0,
		callbackOtpChallengesDeleted: 0,
		callbackOtpChallengesRedacted: 0,
		callbackOtpRateBucketsDeleted: 0,
		publishedOutboxDeleted: 0,
		credentialSnapshotsDeleted: 0,
		integrationReceiptsCompacted: 0,
		consumerReceiptsCompacted: 0,
		integrationFailureDetailsRedacted: 0,
		consumerFailureDetailsRedacted: 0
	});

	console.log('Widgets PostgreSQL 18 retention integration passed');
} finally {
	await cleanupFixture().catch(() => undefined);
	await prisma.$disconnect();
}

async function seedFixture() {
	const callbackOtp = await createCallbackOtpFixture();
	const oldPublished = await createOutbox('PUBLISHED', old);
	const boundaryPublished = await createOutbox('PUBLISHED', boundary);
	const pending = await createOutbox('PENDING', old);
	const quarantined = await createOutbox('QUARANTINED', old);
	const processing = await createOutbox('PUBLISHING', old, {
		lockedAt: boundary,
		lockedBy: `retention-${runId}`,
		lockToken: randomUUID(),
		leaseExpiresAt: new Date(now.getTime() + DAY_MS)
	});

	const oldConsumer = await createConsumerReceipt('DELIVERED', old);
	const boundaryConsumer = await createConsumerReceipt(
		'DELIVERED',
		boundary
	);
	const deadConsumer = await createConsumerReceipt('DEAD_LETTERED', old);
	const oldConsumerFailure = await createConsumerFailure(
		oldConsumer,
		'RESOLVED',
		old
	);
	const boundaryConsumerFailure = await createConsumerFailure(
		boundaryConsumer,
		'RESOLVED',
		boundary
	);
	const openConsumerFailure = await createConsumerFailure(
		deadConsumer,
		'OPEN',
		old
	);

	const oldDelivered = await createIntegrationReceipt('DELIVERED', old);
	const oldClosed = await createIntegrationReceipt('CLOSED_NO_RETRY', old);
	const boundaryDelivered = await createIntegrationReceipt(
		'DELIVERED',
		boundary
	);
	const deadIntegration = await createIntegrationReceipt(
		'DEAD_LETTERED',
		old
	);
	const blockedDelivered = await createIntegrationReceipt(
		'DELIVERED',
		old
	);
	const oldDeliveredSnapshot = await createSnapshot(oldDelivered, old);
	const oldClosedSnapshot = await createSnapshot(oldClosed, old);
	const boundarySnapshot = await createSnapshot(
		boundaryDelivered,
		boundary
	);
	const deadSnapshot = await createSnapshot(deadIntegration, old);
	const blockedSnapshot = await createSnapshot(blockedDelivered, old);
	const oldDeliveredFailure = await createIntegrationFailure(
		oldDelivered,
		'DELIVERED',
		old
	);
	const oldClosedFailure = await createIntegrationFailure(
		oldClosed,
		'CLOSED_NO_RETRY',
		old
	);
	const boundaryFailure = await createIntegrationFailure(
		boundaryDelivered,
		'DELIVERED',
		boundary
	);
	const openIntegrationFailure = await createIntegrationFailure(
		deadIntegration,
		null,
		old
	);
	const blockedOpenFailure = await createIntegrationFailure(
		blockedDelivered,
		null,
		old
	);

	return {
		...callbackOtp,
		oldPublished,
		boundaryPublished,
		pending,
		quarantined,
		processing,
		oldConsumer,
		boundaryConsumer,
		deadConsumer,
		oldConsumerFailure,
		boundaryConsumerFailure,
		openConsumerFailure,
		oldDelivered,
		oldClosed,
		boundaryDelivered,
		deadIntegration,
		blockedDelivered,
		oldDeliveredSnapshot,
		oldClosedSnapshot,
		boundarySnapshot,
		deadSnapshot,
		blockedSnapshot,
		oldDeliveredFailure,
		oldClosedFailure,
		boundaryFailure,
		openIntegrationFailure,
		blockedOpenFailure
	};
}

async function createCallbackOtpFixture() {
	const callback = await prisma.callback.create({
		data: {
			id: `retention-callback-${runId}`,
			userId: `retention-owner-${runId}`,
			publicKey: hash(`retention-callback:${runId}`).slice(0, 32),
			installDomain: 'example.test',
			config: { verificationMode: 'EMAIL', launcherEnabled: true },
			publishedVersion: 1,
			publishedAt: old,
			createdAt: old,
			updatedAt: old
		}
	});
	tracked.callbacks.push(callback.id);
	const expiresAt = new Date(old.getTime() + 5 * 60 * 1000);
	const resendAvailableAt = new Date(old.getTime() + 60 * 1000);
	const sentAt = new Date(old.getTime() + 30 * 1000);
	const consumedAt = new Date(old.getTime() + 2 * 60 * 1000);
	const consumedChallenge = await prisma.callbackOtpChallenge.create({
		data: {
			id: randomUUID(),
			callbackId: callback.id,
			ownerId: callback.userId,
			publishedVersion: 1,
			channel: 'EMAIL',
			destinationHash: hash(`retention-destination:${runId}`),
			ipHash: hash(`retention-ip:${runId}`),
			codeHash: hash(`retention-code:${runId}`),
			expiresAt,
			resendAvailableAt,
			sentAt,
			consumedAt,
			createdAt: old,
			updatedAt: consumedAt
		}
	});
	const lead = await prisma.callbackLead.create({
		data: {
			callbackId: callback.id,
			phone: '+79991234567',
			timeSlot: '11:00–13:00',
			timezone: 'Europe/Moscow',
			url: 'https://example.test/callback',
			verificationMode: 'EMAIL',
			verificationChallengeId: consumedChallenge.id,
			createdAt: consumedAt
		}
	});
	const unconsumedChallenge = await prisma.callbackOtpChallenge.create({
		data: {
			id: randomUUID(),
			callbackId: callback.id,
			ownerId: callback.userId,
			publishedVersion: 1,
			channel: 'EMAIL',
			destinationHash: hash(`retention-unused-destination:${runId}`),
			ipHash: hash(`retention-unused-ip:${runId}`),
			codeHash: hash(`retention-unused-code:${runId}`),
			expiresAt,
			resendAvailableAt,
			sentAt,
			createdAt: old,
			updatedAt: sentAt
		}
	});
	return { callback, consumedChallenge, unconsumedChallenge, lead };
}

async function createOutbox(status, timestamp, overrides = {}) {
	const id = randomUUID();
	tracked.outbox.push(id);
	return prisma.widgetsOutboxEvent.create({
		data: {
			id,
			messageId: randomUUID(),
			deduplicationKey: `retention:${runId}:outbox:${id}`,
			eventType: 'widgets.retention.test.v1',
			routingKey: 'widgets.retention.test.v1',
			payload: { runId },
			headers: {},
			status,
			availableAt: timestamp,
			publishedAt: status === 'PUBLISHED' ? timestamp : null,
			lastError: status === 'QUARANTINED' ? 'manual review' : null,
			createdAt: timestamp,
			updatedAt: timestamp,
			...overrides
		}
	});
}

async function createConsumerReceipt(status, timestamp) {
	const id = randomUUID();
	const eventId = randomUUID();
	const consumer = `retention-${runId}`;
	tracked.consumerReceipts.push(id);
	return prisma.widgetsConsumerReceipt.create({
		data: {
			id,
			eventId,
			consumer,
			payloadHash: hash(`${eventId}:${consumer}`),
			status,
			deliveredAt: status === 'DELIVERED' ? timestamp : null,
			lastError: status === 'DEAD_LETTERED' ? 'manual retry detail' : null,
			createdAt: timestamp,
			updatedAt: timestamp
		}
	});
}

async function createConsumerFailure(receipt, status, timestamp) {
	const id = randomUUID();
	tracked.consumerFailures.push(id);
	return prisma.widgetsConsumerFailure.create({
		data: {
			id,
			eventId: receipt.eventId,
			consumer: receipt.consumer,
			eventType: 'widgets.retention.test.v1',
			routingKey: 'widgets.retention.test.v1',
			payload: { runId, contact: 'retention-test@example.test' },
			headers: { source: 'retention-test' },
			payloadHash: receipt.payloadHash,
			correlationId: `retention-${runId}`,
			status,
			manualRetryCount: 2,
			lastError: 'consumer detail to purge',
			lastFailedAt: timestamp,
			resolvedAt: status === 'RESOLVED' ? timestamp : null,
			createdAt: timestamp,
			updatedAt: timestamp
		}
	});
}

async function createIntegrationReceipt(status, timestamp) {
	const id = randomUUID();
	const eventId = randomUUID();
	tracked.integrationReceipts.push(id);
	return prisma.integrationDeliveryReceipt.create({
		data: {
			id,
			eventId,
			integration: 'webhook',
			payloadHash: hash(`${eventId}:webhook`),
			status,
			deliveredAt: status === 'DELIVERED' ? timestamp : null,
			lastError:
				status === 'DEAD_LETTERED'
					? 'provider detail for manual retry'
					: null,
			createdAt: timestamp,
			updatedAt: timestamp
		}
	});
}

async function createSnapshot(receipt, timestamp) {
	const id = randomUUID();
	tracked.snapshots.push(id);
	return prisma.integrationCredentialSnapshot.create({
		data: {
			id,
			eventId: receipt.eventId,
			integration: receipt.integration,
			source: 'widget',
			entityId: `retention-${runId}`,
			targetFingerprint: `retention-${receipt.eventId}`,
			credentials: { token: 'integration-test-only' },
			createdAt: timestamp,
			updatedAt: timestamp
		}
	});
}

async function createIntegrationFailure(receipt, resolution, timestamp) {
	const id = randomUUID();
	tracked.integrationFailures.push(id);
	return prisma.integrationDeliveryFailure.create({
		data: {
			id,
			eventId: receipt.eventId,
			integration: receipt.integration,
			routingKey: 'lead.integration.webhook.v2',
			payload: { runId, contact: 'retention-test@example.test' },
			headers: { source: 'retention-test' },
			attempts: 3,
			lastError: 'provider detail to purge',
			category: 'PERMANENT',
			normalizedCode: 'RETENTION_TEST',
			safeReason: 'safe provider detail to purge',
			httpStatus: 422,
			providerCode: 'TEST_PROVIDER_CODE',
			retryable: false,
			classificationVersion: 1,
			firstFailedAt: timestamp,
			failedAt: timestamp,
			manualRetryCount: 2,
			resolvedAt: resolution ? timestamp : null,
			resolution,
			resolutionComment:
				resolution === 'CLOSED_NO_RETRY'
					? 'operator retention test comment'
					: null,
			resolvedById:
				resolution === 'CLOSED_NO_RETRY' ? `actor-${runId}` : null,
			createdAt: timestamp,
			updatedAt: timestamp
		}
	});
}

async function assertOutboxRetention(fixture) {
	const rows = await prisma.widgetsOutboxEvent.findMany({
		where: {
			id: {
				in: [
					fixture.oldPublished.id,
					fixture.boundaryPublished.id,
					fixture.pending.id,
					fixture.quarantined.id,
					fixture.processing.id
				]
			}
		},
		select: { id: true, status: true }
	});
	assert.equal(
		rows.some(row => row.id === fixture.oldPublished.id),
		false
	);
	assert.deepEqual(
		new Set(rows.map(row => row.id)),
		new Set([
			fixture.boundaryPublished.id,
			fixture.pending.id,
			fixture.quarantined.id,
			fixture.processing.id
		])
	);
}

async function assertCallbackOtpRetention(fixture) {
	const consumed = await prisma.callbackOtpChallenge.findUniqueOrThrow({
		where: { id: fixture.consumedChallenge.id }
	});
	assert.equal(consumed.destinationHash, '0'.repeat(64));
	assert.equal(consumed.ipHash, '1'.repeat(64));
	assert.equal(consumed.codeHash, '2'.repeat(64));
	assert.equal(consumed.callbackId, fixture.callback.id);
	assert.equal(consumed.ownerId, fixture.callback.userId);
	assert.equal(consumed.publishedVersion, 1);
	assert.equal(consumed.channel, 'EMAIL');
	assert.ok(consumed.consumedAt);
	const lead = await prisma.callbackLead.findUniqueOrThrow({
		where: { id: fixture.lead.id }
	});
	assert.equal(lead.verificationMode, 'EMAIL');
	assert.equal(lead.verificationChallengeId, consumed.id);
	assert.equal(
		await prisma.callbackOtpChallenge.findUnique({
			where: { id: fixture.unconsumedChallenge.id }
		}),
		null
	);
}

async function assertConsumerRetention(fixture) {
	const receipts = await prisma.widgetsConsumerReceipt.findMany({
		where: {
			id: {
				in: [
					fixture.oldConsumer.id,
					fixture.boundaryConsumer.id,
					fixture.deadConsumer.id
				]
			}
		}
	});
	assert.equal(receipts.length, 3);
	assert.ok(
		receipts.find(row => row.id === fixture.oldConsumer.id)
			?.detailsPurgedAt
	);
	assert.equal(
		receipts.find(row => row.id === fixture.boundaryConsumer.id)
			?.detailsPurgedAt,
		null
	);
	assert.equal(
		receipts.find(row => row.id === fixture.deadConsumer.id)?.lastError,
		'manual retry detail'
	);

	const oldResolved =
		await prisma.widgetsConsumerFailure.findUniqueOrThrow({
			where: { id: fixture.oldConsumerFailure.id }
		});
	assert.deepEqual(oldResolved.payload, {});
	assert.deepEqual(oldResolved.headers, {});
	assert.equal(oldResolved.lastError, '[redacted after retention]');
	assert.ok(oldResolved.detailsPurgedAt);
	assert.equal(
		oldResolved.payloadHash,
		fixture.oldConsumerFailure.payloadHash
	);
	assert.equal(oldResolved.manualRetryCount, 2);
	assert.equal(oldResolved.status, 'RESOLVED');

	const boundaryResolved =
		await prisma.widgetsConsumerFailure.findUniqueOrThrow({
			where: { id: fixture.boundaryConsumerFailure.id }
		});
	assert.equal(boundaryResolved.detailsPurgedAt, null);
	assert.notDeepEqual(boundaryResolved.payload, {});
	const open = await prisma.widgetsConsumerFailure.findUniqueOrThrow({
		where: { id: fixture.openConsumerFailure.id }
	});
	assert.equal(open.status, 'OPEN');
	assert.equal(open.detailsPurgedAt, null);
	assert.notDeepEqual(open.payload, {});
}

async function assertIntegrationRetention(fixture) {
	const receipts = await prisma.integrationDeliveryReceipt.findMany({
		where: {
			id: {
				in: [
					fixture.oldDelivered.id,
					fixture.oldClosed.id,
					fixture.boundaryDelivered.id,
					fixture.deadIntegration.id,
					fixture.blockedDelivered.id
				]
			}
		}
	});
	assert.equal(receipts.length, 5);
	assert.ok(
		receipts.find(row => row.id === fixture.oldDelivered.id)
			?.detailsPurgedAt
	);
	assert.ok(
		receipts.find(row => row.id === fixture.oldClosed.id)?.detailsPurgedAt
	);
	assert.equal(
		receipts.find(row => row.id === fixture.boundaryDelivered.id)
			?.detailsPurgedAt,
		null
	);
	assert.equal(
		receipts.find(row => row.id === fixture.deadIntegration.id)?.lastError,
		'provider detail for manual retry'
	);
	assert.equal(
		receipts.find(row => row.id === fixture.blockedDelivered.id)
			?.detailsPurgedAt,
		null
	);

	const snapshots = await prisma.integrationCredentialSnapshot.findMany({
		where: {
			id: {
				in: [
					fixture.oldDeliveredSnapshot.id,
					fixture.oldClosedSnapshot.id,
					fixture.boundarySnapshot.id,
					fixture.deadSnapshot.id,
					fixture.blockedSnapshot.id
				]
			}
		},
		select: { id: true }
	});
	assert.deepEqual(
		new Set(snapshots.map(row => row.id)),
		new Set([
			fixture.boundarySnapshot.id,
			fixture.deadSnapshot.id,
			fixture.blockedSnapshot.id
		])
	);

	const deliveredFailure =
		await prisma.integrationDeliveryFailure.findUniqueOrThrow({
			where: { id: fixture.oldDeliveredFailure.id }
		});
	assertIntegrationFailurePurged(
		deliveredFailure,
		fixture.oldDeliveredFailure
	);
	assert.equal(deliveredFailure.resolution, 'DELIVERED');
	assert.equal(deliveredFailure.resolutionComment, null);

	const closedFailure =
		await prisma.integrationDeliveryFailure.findUniqueOrThrow({
			where: { id: fixture.oldClosedFailure.id }
		});
	assertIntegrationFailurePurged(closedFailure, fixture.oldClosedFailure);
	assert.equal(closedFailure.resolution, 'CLOSED_NO_RETRY');
	assert.equal(
		closedFailure.resolutionComment,
		'[redacted after retention]'
	);
	assert.equal(closedFailure.resolvedById, `actor-${runId}`);

	const boundaryFailure =
		await prisma.integrationDeliveryFailure.findUniqueOrThrow({
			where: { id: fixture.boundaryFailure.id }
		});
	assert.equal(boundaryFailure.detailsPurgedAt, null);
	assert.notDeepEqual(boundaryFailure.payload, {});
	const openFailure =
		await prisma.integrationDeliveryFailure.findUniqueOrThrow({
			where: { id: fixture.openIntegrationFailure.id }
		});
	assert.equal(openFailure.resolvedAt, null);
	assert.equal(openFailure.detailsPurgedAt, null);
	assert.notDeepEqual(openFailure.payload, {});
	const blockedOpenFailure =
		await prisma.integrationDeliveryFailure.findUniqueOrThrow({
			where: { id: fixture.blockedOpenFailure.id }
		});
	assert.equal(blockedOpenFailure.resolvedAt, null);
	assert.equal(blockedOpenFailure.detailsPurgedAt, null);
	assert.notDeepEqual(blockedOpenFailure.payload, {});
}

function assertIntegrationFailurePurged(actual, original) {
	assert.deepEqual(actual.payload, {});
	assert.deepEqual(actual.headers, {});
	assert.equal(actual.lastError, '[redacted after retention]');
	assert.equal(actual.safeReason, null);
	assert.equal(actual.httpStatus, null);
	assert.equal(actual.providerCode, null);
	assert.ok(actual.detailsPurgedAt);
	assert.equal(actual.normalizedCode, original.normalizedCode);
	assert.equal(actual.category, original.category);
	assert.equal(actual.attempts, original.attempts);
	assert.equal(actual.manualRetryCount, original.manualRetryCount);
}

async function assertReceiptTombstones(fixture) {
	await assert.rejects(
		prisma.widgetsConsumerReceipt.create({
			data: {
				eventId: fixture.oldConsumer.eventId,
				consumer: fixture.oldConsumer.consumer,
				payloadHash: fixture.oldConsumer.payloadHash,
				status: 'DELIVERED',
				deliveredAt: now
			}
		}),
		error => error?.code === 'P2002'
	);
	await assert.rejects(
		prisma.integrationDeliveryReceipt.create({
			data: {
				eventId: fixture.oldDelivered.eventId,
				integration: fixture.oldDelivered.integration,
				payloadHash: fixture.oldDelivered.payloadHash,
				status: 'DELIVERED',
				deliveredAt: now
			}
		}),
		error => error?.code === 'P2002'
	);
}

async function assertResolvedFailureActionCompatibility(fixture) {
	const service = new WidgetsDeliveryFailuresService(prisma, {}, {}, {});
	await assert.rejects(
		service.retry(
			fixture.oldDeliveredFailure.id,
			`actor-${runId}`,
			`retention-${runId}`
		),
		error => error?.message === 'Ошибка уже обработана'
	);
}

async function assertPostgreSql18() {
	const [row] = await prisma.$queryRawUnsafe(
		"SELECT current_setting('server_version_num')::int AS version"
	);
	assert.ok(
		row.version >= 180000 && row.version < 190000,
		`Widgets retention rehearsal requires PostgreSQL 18, got ${row.version}`
	);
}

async function assertRetentionIndexes() {
	const rows = await prisma.$queryRawUnsafe(
		"SELECT indexname FROM pg_indexes WHERE schemaname = 'widgets' AND indexname LIKE '%retention_idx'"
	);
	const names = new Set(rows.map(row => row.indexname));
	for (const name of [
		'outbox_events_retention_idx',
		'consumer_receipts_retention_idx',
		'consumer_failures_retention_idx',
		'integration_delivery_receipts_delivered_retention_idx',
		'integration_delivery_receipts_closed_retention_idx',
		'integration_delivery_receipts_snapshot_delivered_retention_idx',
		'integration_delivery_receipts_snapshot_closed_retention_idx',
		'integration_delivery_failures_retention_idx'
	]) {
		assert.ok(names.has(name), `Missing Widgets retention index: ${name}`);
	}
}

async function cleanupFixture() {
	await prisma.$transaction([
		prisma.integrationDeliveryFailure.deleteMany({
			where: { id: { in: tracked.integrationFailures } }
		}),
		prisma.integrationCredentialSnapshot.deleteMany({
			where: { id: { in: tracked.snapshots } }
		}),
		prisma.integrationDeliveryReceipt.deleteMany({
			where: { id: { in: tracked.integrationReceipts } }
		}),
		prisma.widgetsConsumerFailure.deleteMany({
			where: { id: { in: tracked.consumerFailures } }
		}),
		prisma.widgetsConsumerReceipt.deleteMany({
			where: { id: { in: tracked.consumerReceipts } }
		}),
		prisma.widgetsOutboxEvent.deleteMany({
			where: { id: { in: tracked.outbox } }
		}),
		prisma.callback.deleteMany({
			where: { id: { in: tracked.callbacks } }
		})
	]);
}

function hash(value) {
	return createHash('sha256').update(value).digest('hex');
}

function assertLocalTestDatabase(value) {
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\/+/, '')
	);
	if (
		parsed.protocol !== 'postgresql:' ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!(
			databaseName.toLowerCase().includes('test') ||
			databaseName.toLowerCase().endsWith('_ci')
		)
	) {
		throw new Error(
			'WIDGETS_TEST_DATABASE_URL must point to a local test or CI database'
		);
	}
	for (const [key, configured] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && configured?.trim() === value) {
			throw new Error(`WIDGETS_TEST_DATABASE_URL must not reuse ${key}`);
		}
	}
}
