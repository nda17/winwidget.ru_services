import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const databaseUrl = process.env.REPORTING_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	throw new Error('REPORTING_TEST_DATABASE_URL is required');
}
if (process.env.REPORTING_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('REPORTING_INTEGRATION_ALLOW_MUTATION=true is required');
}
const migrationDatabaseUrl =
	process.env.REPORTING_TEST_MIGRATION_DATABASE_URL?.trim();
const restrictedRabbitUrl =
	process.env.REPORTING_TEST_RABBITMQ_URL?.trim();
const adminRabbitUrl =
	process.env.REPORTING_TEST_RABBITMQ_ADMIN_URL?.trim();
if (!migrationDatabaseUrl) {
	throw new Error('REPORTING_TEST_MIGRATION_DATABASE_URL is required');
}
if (!restrictedRabbitUrl || !adminRabbitUrl) {
	throw new Error(
		'REPORTING_TEST_RABBITMQ_URL and REPORTING_TEST_RABBITMQ_ADMIN_URL are required'
	);
}
assertLocalTestDatabase(databaseUrl, 'REPORTING_TEST_DATABASE_URL');
assertLocalTestDatabase(
	migrationDatabaseUrl,
	'REPORTING_TEST_MIGRATION_DATABASE_URL'
);
assertLocalTestRabbit(restrictedRabbitUrl, 'REPORTING_TEST_RABBITMQ_URL');
assertLocalTestRabbit(adminRabbitUrl, 'REPORTING_TEST_RABBITMQ_ADMIN_URL');
if (
	new URL(restrictedRabbitUrl).username ===
	new URL(adminRabbitUrl).username
) {
	throw new Error(
		'Reporting restricted and admin RabbitMQ users must differ'
	);
}

const appRoot = new URL('../../', import.meta.url);
const migration = spawnSync('pnpm', ['run', 'prisma:migrate:deploy'], {
	cwd: appRoot,
	env: {
		...process.env,
		REPORTING_DATABASE_URL: migrationDatabaseUrl
	},
	encoding: 'utf8',
	timeout: 120_000
});
if (migration.status !== 0) {
	throw new Error(
		`Reporting migration failed:\n${migration.stdout}\n${migration.stderr}`
	);
}

const importedClient = await import('@prisma/reporting-client');
const PrismaClient =
	importedClient.PrismaClient || importedClient.default.PrismaClient;
const importedProjectionService = await import(
	new URL(
		'../../dist/src/projections/projection.service.js',
		import.meta.url
	)
);
const ProjectionService =
	importedProjectionService.ProjectionService ||
	importedProjectionService.default?.ProjectionService;
if (!ProjectionService) {
	throw new Error('Compiled Reporting projection service is unavailable');
}
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const integrationMetrics = { increment: () => undefined };
const projectionService = new ProjectionService(
	prisma,
	integrationMetrics
);
const internalToken = `reporting-integration-${randomUUID()}`;
const operationsToken = `reporting-operations-integration-${randomUUID()}`;
const identityToken = `reporting-identity-integration-${randomUUID()}`;
if (new Set([internalToken, operationsToken, identityToken]).size !== 3) {
	throw new Error('Reporting integration tokens must be distinct');
}
const allowedOrigin = 'http://127.0.0.1:3000';
let lastIntrospectionCorrelationId = null;
let schedulePolicy = {
	reservationTime: '01:50',
	reservationGeneration: '0',
	confirmedChangeId: null,
	pending: null
};
let rejectNextPolicyConfirmation = false;
const operationsPort = await getFreePort();
const operations = createServer(async (request, response) => {
	if (request.headers['x-winwidget-internal-token'] !== internalToken) {
		response.writeHead(403).end();
		return;
	}
	if (
		request.url ===
		'/internal/v1/operations/reporting/schedule-policy'
	) {
		if (request.method === 'PUT') {
			const body = JSON.parse(await readRequestBody(request));
			if (
				Object.keys(body).sort().join('|') !==
					'actorId|changeId|expectedScheduleGeneration|scheduleTime' ||
				typeof body.changeId !== 'string' ||
				typeof body.scheduleTime !== 'string' ||
				typeof body.expectedScheduleGeneration !== 'string' ||
				!/^(?:0|[1-9]\d*)$/.test(body.expectedScheduleGeneration)
			) {
				response.writeHead(400).end();
				return;
			}
			const expectedGeneration = BigInt(body.expectedScheduleGeneration);
			const currentGeneration = BigInt(
				schedulePolicy.reservationGeneration
			);
			if (schedulePolicy.pending) {
				if (
					schedulePolicy.pending.changeId !== body.changeId ||
					schedulePolicy.pending.scheduleTime !== body.scheduleTime ||
					BigInt(schedulePolicy.pending.generation) !==
						expectedGeneration + 1n
				) {
					response.writeHead(409).end();
					return;
				}
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						accepted: true,
						changeId: body.changeId,
						reservationGeneration: schedulePolicy.pending.generation,
						confirmationRequired: true
					})
				);
				return;
			}
			if (currentGeneration !== expectedGeneration) {
				response.writeHead(409).end();
				return;
			}
			if (body.scheduleTime === schedulePolicy.reservationTime) {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						accepted: true,
						changeId: body.changeId,
						reservationGeneration: String(currentGeneration),
						confirmationRequired: false
					})
				);
				return;
			}
			schedulePolicy = {
				...schedulePolicy,
				pending: {
					changeId: body.changeId,
					scheduleTime: body.scheduleTime,
					generation: String(currentGeneration + 1n)
				}
			};
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					accepted: true,
					changeId: body.changeId,
					reservationGeneration: schedulePolicy.pending.generation,
					confirmationRequired: true
				})
			);
			return;
		}
		response.writeHead(405).end();
		return;
	}
	if (
		request.url ===
			'/internal/v1/operations/reporting/schedule-policy/confirm' &&
		request.method === 'POST'
	) {
		if (rejectNextPolicyConfirmation) {
			rejectNextPolicyConfirmation = false;
			response.writeHead(503).end();
			return;
		}
		const body = JSON.parse(await readRequestBody(request));
		if (
			Object.keys(body).sort().join('|') !==
				'changeId|scheduleGeneration' ||
			typeof body.changeId !== 'string' ||
			typeof body.scheduleGeneration !== 'string'
		) {
			response.writeHead(400).end();
			return;
		}
		if (!schedulePolicy.pending) {
			if (
				schedulePolicy.confirmedChangeId !== body.changeId ||
				schedulePolicy.reservationGeneration !== body.scheduleGeneration
			) {
				response.writeHead(409).end();
				return;
			}
		} else {
			if (
				schedulePolicy.pending.changeId !== body.changeId ||
				schedulePolicy.pending.generation !== body.scheduleGeneration
			) {
				response.writeHead(409).end();
				return;
			}
			schedulePolicy = {
				...schedulePolicy,
				reservationTime: schedulePolicy.pending.scheduleTime,
				reservationGeneration: schedulePolicy.pending.generation,
				confirmedChangeId: body.changeId,
				pending: null
			};
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				confirmed: true,
				changeId: body.changeId,
				reservationGeneration: body.scheduleGeneration
			})
		);
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	operations.once('error', reject);
	operations.listen(operationsPort, '127.0.0.1', resolve);
});

const identityPort = await getFreePort();
const identity = createServer((request, response) => {
	if (
		request.headers['x-winwidget-service'] !== 'reporting' ||
		request.headers['x-winwidget-internal-token'] !== identityToken
	) {
		response.writeHead(403).end();
		return;
	}
	if (
		request.method !== 'POST' ||
		request.url !== '/internal/v1/auth/introspect'
	) {
		response.writeHead(404).end();
		return;
	}
	const authorization = request.headers.authorization;
	lastIntrospectionCorrelationId =
		request.headers['x-correlation-id'] || null;
	if (authorization === 'Bearer introspection-unavailable') {
		response.writeHead(503).end();
		return;
	}
	if (authorization !== 'Bearer integration-admin') {
		response.writeHead(401).end();
		return;
	}
	response.writeHead(200, { 'content-type': 'application/json' });
	response.end(
		JSON.stringify({
			active: true,
			subject: 'reporting-integration-admin',
			sessionId: randomUUID(),
			roles: ['ADMIN', 'DEV']
		})
	);
});
await new Promise((resolve, reject) => {
	identity.once('error', reject);
	identity.listen(identityPort, '127.0.0.1', resolve);
});

let service = null;
let rabbitFixture = null;
try {
	await cleanupDatabase();
	const apiPort = await getFreePort();
	service = startService({
		port: apiPort,
		role: 'api',
		rabbitUrl: ''
	});
	await waitForReady(apiPort, 'api');
	await assertApiBoundary(apiPort);
	await stopService(service);
	service = null;

	rabbitFixture = await provisionSharedRabbitFixture();
	const allPort = await getFreePort();
	service = startService({
		port: allPort,
		role: 'all',
		rabbitUrl: restrictedRabbitUrl
	});
	await waitForReady(allPort, 'all', 30_000);
	await runRabbitSmoke(allPort);

	console.log(
		'Reporting API, projection and manual retry integration passed'
	);
} finally {
	if (service) await stopService(service);
	if (rabbitFixture) await rabbitFixture.close();
	await Promise.all([
		new Promise(resolve => operations.close(resolve)),
		new Promise(resolve => identity.close(resolve))
	]);
	await cleanupDatabase().catch(() => undefined);
	await prisma.$disconnect();
}

function startService({ port, role, rabbitUrl }) {
	return spawn('node', ['dist/src/main.js'], {
		cwd: appRoot,
		env: {
			...process.env,
			NODE_ENV: 'production',
			MODE: 'production',
			APP_REVISION: 'reporting-integration',
			REPORTING_DATABASE_URL: databaseUrl,
			REPORTING_PROCESS_ROLE: role,
			REPORTING_LISTEN_HOST: '127.0.0.1',
			REPORTING_PORT: String(port),
			OPERATIONS_INTERNAL_BASE_URL: `http://127.0.0.1:${operationsPort}`,
			REPORTING_INTERNAL_TOKEN: internalToken,
			REPORTING_INTERNAL_TIMEOUT_MS: '2000',
			REPORTING_OPERATIONS_TOKEN: operationsToken,
			IDENTITY_INTERNAL_BASE_URL: `http://127.0.0.1:${identityPort}`,
			IDENTITY_REPORTING_TOKEN: identityToken,
			IDENTITY_INTERNAL_TIMEOUT_MS: '2000',
			REPORTING_SCHEDULER_ENABLED: 'false',
			REPORTING_PREFETCH: '5',
			REPORTING_OUTBOX_BATCH_SIZE: '50',
			REPORTING_OUTBOX_POLL_INTERVAL_MS: '100',
			REPORTING_OUTBOX_RETENTION_DAYS: '7',
			CORS_ALLOWED_ORIGINS: allowedOrigin,
			...(rabbitUrl
				? {
						RABBITMQ_URL: rabbitUrl,
						RABBITMQ_ASSERT_TOPOLOGY: 'true',
						RABBITMQ_CONNECTION_NAME: 'reporting-restricted-integration'
					}
				: {})
		},
		stdio: 'inherit'
	});
}

async function assertApiBoundary(port) {
	await assertCorsPreflight(port);
	const correlationId = randomUUID();
	const dashboard = await requestJson(
		port,
		'/api/v1/admin/reporting/dashboard',
		{
			headers: {
				authorization: 'Bearer integration-admin',
				'x-correlation-id': correlationId
			}
		},
		200
	);
	if (
		typeof dashboard.generatedAt !== 'string' ||
		dashboard.finance?.revenueAllTime !== 0 ||
		dashboard.widgets?.byType?.length !== 7
	) {
		throw new Error('Reporting dashboard empty-state contract is invalid');
	}
	if (lastIntrospectionCorrelationId !== correlationId) {
		throw new Error(
			'Reporting did not preserve correlation ID through Auth introspection'
		);
	}
	const registrations = await requestJson(
		port,
		'/api/v1/admin/reporting/registrations-by-month',
		{ headers: { authorization: 'Bearer integration-admin' } },
		200
	);
	if (!Array.isArray(registrations)) {
		throw new Error(
			'Reporting registrations-by-month contract must return an array'
		);
	}
	await requestJson(
		port,
		'/api/v1/admin/reporting/overview',
		{ headers: { 'x-forwarded-role': 'ADMIN' } },
		401
	);
	await requestJson(
		port,
		'/api/v1/admin/reporting/overview',
		{ headers: { authorization: 'Bearer revoked' } },
		401
	);
	await requestJson(
		port,
		'/api/v1/admin/reporting/overview',
		{
			headers: {
				authorization: 'Bearer introspection-unavailable'
			}
		},
		503
	);
	await requestJson(
		port,
		'/internal/v1/reporting/messaging/overview',
		{
			headers: {
				'x-winwidget-service': 'operations',
				'x-winwidget-internal-token': internalToken
			}
		},
		401
	);
	await requestJson(
		port,
		'/internal/v1/reporting/messaging/overview',
		{
			headers: {
				'x-winwidget-service': 'reporting',
				'x-winwidget-internal-token': operationsToken
			}
		},
		403
	);
	const messagingOverview = await requestJson(
		port,
		'/internal/v1/reporting/messaging/overview',
		{
			headers: {
				'x-winwidget-service': 'operations',
				'x-winwidget-internal-token': operationsToken
			}
		},
		200
	);
	if (messagingOverview.schemaVersion !== 1) {
		throw new Error('Reporting Operations messaging overview is invalid');
	}
	const settings = await requestJson(
		port,
		'/api/v1/admin/reporting/daily-summary/settings',
		{ headers: { authorization: 'Bearer integration-admin' } },
		200
	);
	if (
		Object.hasOwn(settings, 'owner') ||
		settings.operationalAlertsThreadId !== null
	) {
		throw new Error('Reporting settings exposed a removed Core contract');
	}
	await assertConcurrentDailySummaryPatches(port);
	await assertOperationsNotificationRoutingProjection();
}

async function assertConcurrentDailySummaryPatches(port) {
	schedulePolicy = {
		reservationTime: '01:50',
		reservationGeneration: '0',
		confirmedChangeId: null,
		pending: null
	};
	await prisma.reportingSettings.update({
		where: { id: 'daily-summary' },
		data: {
			enabled: false,
			destinationChatId: '-100100',
			messageThreadId: 76,
			operationalAlertsThreadId: 43,
			scheduleTime: '01:50',
			timezone: 'Europe/Moscow',
			scheduleGeneration: 0n,
			schedulePolicyChangeId: null
		}
	});
	try {
		const before = await findSettingsAuditOutbox();
		const atomic = await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{
				method: 'PATCH',
				headers: {
					authorization: 'Bearer integration-admin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					messageThreadId: 77,
					scheduleTime: '02:10',
					expectedScheduleGeneration: '0'
				})
			},
			200
		);
		assert.equal(atomic.destinationChatId, '-100100');
		assert.equal(atomic.messageThreadId, 77);
		assert.equal(atomic.scheduleTime, '02:10');
		assert.equal(atomic.scheduleGeneration, '1');
		assert.equal(atomic.schedulePolicyConfirmationPending, false);
		assert.equal(schedulePolicy.reservationTime, '02:10');
		assert.equal(schedulePolicy.reservationGeneration, '1');
		assert.equal(schedulePolicy.pending, null);

		const [settings, afterAtomicAudit] = await Promise.all([
			prisma.reportingSettings.findUniqueOrThrow({
				where: { id: 'daily-summary' }
			}),
			findSettingsAuditOutbox()
		]);
		assert.equal(settings.destinationChatId, '-100100');
		assert.equal(settings.scheduleTime, '02:10');
		assert.equal(settings.timezone, 'Europe/Moscow');
		assert.equal(settings.messageThreadId, 77);
		assert.equal(settings.scheduleGeneration, 1n);
		assert.equal(settings.schedulePolicyChangeId, null);
		const atomicEvents = afterAtomicAudit.filter(
			event => !before.some(previous => previous.id === event.id)
		);
		assert.equal(atomicEvents.length, 1);
		assert.deepEqual(atomicEvents[0].payload?.metadata?.changedFields, [
			'messageThreadId',
			'scheduleTime'
		]);

		await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{
				method: 'PATCH',
				headers: {
					authorization: 'Bearer integration-admin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					scheduleTime: '02:30',
					expectedScheduleGeneration: '0'
				})
			},
			409
		);
		rejectNextPolicyConfirmation = true;
		await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{
				method: 'PATCH',
				headers: {
					authorization: 'Bearer integration-admin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					scheduleTime: '02:20',
					expectedScheduleGeneration: '1'
				})
			},
			503
		);
		const pendingRow = await prisma.reportingSettings.findUniqueOrThrow({
			where: { id: 'daily-summary' }
		});
		assert.equal(pendingRow.scheduleTime, '02:20');
		assert.equal(pendingRow.scheduleGeneration, 2n);
		assert.ok(pendingRow.schedulePolicyChangeId);
		assert.ok(schedulePolicy.pending);

		const localRead = await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{ headers: { authorization: 'Bearer integration-admin' } },
			200
		);
		assert.equal(localRead.scheduleTime, '02:20');
		assert.equal(localRead.scheduleGeneration, '2');
		assert.equal(localRead.schedulePolicyConfirmationPending, true);

		const repaired = await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{
				method: 'PATCH',
				headers: {
					authorization: 'Bearer integration-admin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					scheduleTime: '02:20',
					expectedScheduleGeneration: '2'
				})
			},
			200
		);
		assert.equal(repaired.schedulePolicyConfirmationPending, false);
		assert.equal(schedulePolicy.reservationTime, '02:20');
		assert.equal(schedulePolicy.reservationGeneration, '2');
		assert.equal(schedulePolicy.pending, null);

		schedulePolicy = {
			...schedulePolicy,
			reservationTime: '03:00',
			reservationGeneration: '3'
		};
		const independentRead = await requestJson(
			port,
			'/api/v1/admin/reporting/daily-summary/settings',
			{ headers: { authorization: 'Bearer integration-admin' } },
			200
		);
		assert.equal(independentRead.scheduleTime, '02:20');
		assert.equal(independentRead.scheduleGeneration, '2');
	} finally {
		schedulePolicy = {
			reservationTime: '01:50',
			reservationGeneration: '0',
			confirmedChangeId: null,
			pending: null
		};
		await prisma.reportingSettings.update({
			where: { id: 'daily-summary' },
			data: { enabled: false }
		});
	}
}

async function assertOperationsNotificationRoutingProjection() {
	await prisma.reportingSettings.update({
		where: { id: 'daily-summary' },
		data: {
			enabled: true,
			destinationChatId: '-100111',
			messageThreadId: 77,
			operationalAlertsThreadId: 43,
			scheduleTime: '02:20',
			timezone: 'Europe/Moscow',
			scheduleGeneration: 2n
		}
	});
	const eventId = randomUUID();
	const lockToken = randomUUID();
	const staleEventId = randomUUID();
	const staleLockToken = randomUUID();
	const changedAt = new Date();
	try {
		await prisma.consumerReceipt.create({
			data: {
				eventId,
				consumer: 'reporting-settings-v1',
				payloadHash: 'a'.repeat(64),
				status: 'PROCESSING',
				lockedAt: new Date(),
				lockedBy: 'integration',
				lockToken,
				leaseExpiresAt: new Date(Date.now() + 60_000)
			}
		});
		await projectionService.applyOperationsNotificationRouting(
			{
				schemaVersion: 1,
				eventId,
				operationalAlertsThreadId: 2024,
				changedAt: changedAt.toISOString()
			},
			{
				eventId,
				consumer: 'reporting-settings-v1',
				lockToken
			}
		);
		const postCleanupProjection =
			await prisma.reportingSettings.findUniqueOrThrow({
				where: { id: 'daily-summary' }
			});
		assert.equal(postCleanupProjection.destinationChatId, '-100111');
		assert.equal(
			postCleanupProjection.operationalAlertsThreadId,
			2024
		);
		assert.equal(
			postCleanupProjection.operationalAlertsChangedAt?.toISOString(),
			changedAt.toISOString()
		);
		assert.equal(postCleanupProjection.scheduleTime, '02:20');

		await prisma.consumerReceipt.create({
			data: {
				eventId: staleEventId,
				consumer: 'reporting-settings-v1',
				payloadHash: 'b'.repeat(64),
				status: 'PROCESSING',
				lockedAt: new Date(),
				lockedBy: 'integration',
				lockToken: staleLockToken,
				leaseExpiresAt: new Date(Date.now() + 60_000)
			}
		});
		await projectionService.applyOperationsNotificationRouting(
			{
				schemaVersion: 1,
				eventId: staleEventId,
				operationalAlertsThreadId: 43,
				changedAt: new Date(changedAt.getTime() - 1_000).toISOString()
			},
			{
				eventId: staleEventId,
				consumer: 'reporting-settings-v1',
				lockToken: staleLockToken
			}
		);
		const afterStaleRetry =
			await prisma.reportingSettings.findUniqueOrThrow({
				where: { id: 'daily-summary' }
			});
		assert.equal(afterStaleRetry.operationalAlertsThreadId, 2024);
		assert.equal(
			afterStaleRetry.operationalAlertsChangedAt?.toISOString(),
			changedAt.toISOString()
		);
	} finally {
		await prisma.reportingSettings.update({
			where: { id: 'daily-summary' },
			data: {
				enabled: false,
				operationalAlertsThreadId: null,
				operationalAlertsChangedAt: null
			}
		});
		await prisma.consumerReceipt.deleteMany({
			where: { eventId: { in: [eventId, staleEventId] } }
		});
	}
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = '';
		request.setEncoding('utf8');
		request.on('data', chunk => {
			body += chunk;
			if (body.length > 4096)
				reject(new Error('Request body is too large'));
		});
		request.on('end', () => resolve(body));
		request.on('error', reject);
	});
}

async function findSettingsAuditOutbox() {
	const events = await prisma.reportingOutboxEvent.findMany({
		where: { eventType: 'admin.audit.event.v1' }
	});
	return events.filter(
		event =>
			event.payload &&
			typeof event.payload === 'object' &&
			!Array.isArray(event.payload) &&
			event.payload.action === 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE'
	);
}

async function provisionSharedRabbitFixture() {
	const amqpImported = await import('amqplib');
	const connect = amqpImported.connect || amqpImported.default?.connect;
	if (!connect) throw new Error('amqplib connect is unavailable');
	const connection = await connect(adminRabbitUrl);
	const channel = await connection.createChannel();
	try {
		await channel.assertExchange('winwidget.events', 'topic', {
			durable: true
		});
		await channel.assertExchange('winwidget.dead-letter', 'topic', {
			durable: true
		});
		const queue = `winwidget.integration.reporting-audit-${randomUUID()}`;
		await channel.assertQueue(queue, {
			durable: false,
			exclusive: true,
			autoDelete: true
		});
		await channel.bindQueue(
			queue,
			'winwidget.events',
			'admin.audit.reporting.v1'
		);
		return {
			close: async () => {
				await channel.close().catch(() => undefined);
				await connection.close().catch(() => undefined);
			}
		};
	} catch (error) {
		await channel.close().catch(() => undefined);
		await connection.close().catch(() => undefined);
		throw error;
	}
}

async function runRabbitSmoke(port) {
	const amqpImported = await import('amqplib');
	const connect = amqpImported.connect || amqpImported.default?.connect;
	if (!connect) throw new Error('amqplib connect is unavailable');
	const restricted = await connect(restrictedRabbitUrl);
	const admin = await connect(adminRabbitUrl);
	let foreignQueue = '';
	try {
		const restrictedChannel = await restricted.createChannel();
		try {
			for (const queue of [
				'winwidget.reporting.identity-user',
				'winwidget.reporting.billing-payment',
				'winwidget.reporting.billing-subscription',
				'winwidget.reporting.widget',
				'winwidget.reporting.lead',
				'winwidget.reporting.settings',
				'winwidget.reporting.delivery-outcome'
			]) {
				await restrictedChannel.checkQueue(queue);
				await restrictedChannel.checkQueue(`${queue}.dead-letter`);
				for (const index of [1, 2, 3]) {
					await restrictedChannel.checkQueue(`${queue}.retry.${index}`);
				}
			}
			await restrictedChannel.checkExchange('winwidget.reporting.retry');
			await restrictedChannel.checkExchange(
				'winwidget.reporting.manual-retry'
			);
		} finally {
			await restrictedChannel.close();
		}

		const publisher = await admin.createConfirmChannel();
		try {
			foreignQueue = `winwidget.integration.foreign-${randomUUID()}`;
			await publisher.assertQueue(foreignQueue, {
				durable: false,
				autoDelete: false
			});
			publisher.sendToQueue(foreignQueue, Buffer.from('foreign-marker'), {
				persistent: false
			});
			await publisher.waitForConfirms();
			await assertForeignQueueDenied(
				restricted,
				foreignQueue,
				'configure'
			);
			await assertForeignQueueDenied(restricted, foreignQueue, 'read');

			const outcomeEventId = randomUUID();
			await publishDeliveryOutcome(publisher, outcomeEventId);
			await waitFor('Reporting-owned delivery outcome', async () => {
				const receipt = await prisma.consumerReceipt.findUnique({
					where: {
						eventId_consumer: {
							eventId: outcomeEventId,
							consumer: 'reporting-delivery-outcome-v1'
						}
					}
				});
				return receipt?.status === 'DELIVERED';
			});
			const routingEventId = randomUUID();
			await publishOperationsNotificationRouting(
				publisher,
				routingEventId,
				2024
			);
			await waitFor('Operations notification routing projection', async () => {
				const [receipt, settings] = await Promise.all([
					prisma.consumerReceipt.findUnique({
						where: {
							eventId_consumer: {
								eventId: routingEventId,
								consumer: 'reporting-settings-v1'
							}
						}
					}),
					prisma.reportingSettings.findUnique({
						where: { id: 'daily-summary' }
					})
				]);
				return (
					receipt?.status === 'DELIVERED' &&
					settings?.operationalAlertsThreadId === 2024
				);
			});
			await assertReportingSettingsManualRetry(port, publisher);

			const aggregateId = `integration-user-${randomUUID()}`;
			const baseEventId = randomUUID();
			const conflictEventId = randomUUID();
			const newerEventId = randomUUID();
			const state = identityState(aggregateId, false);
			await publishProjection(publisher, {
				eventId: baseEventId,
				aggregateId,
				aggregateVersion: '2',
				sourceSequence: '10',
				state
			});
			await waitFor('base projection', async () => {
				const projection = await prisma.identityUserProjection.findUnique({
					where: { id: aggregateId }
				});
				return projection?.aggregateVersion.toString() === '2';
			});

			await publishProjection(publisher, {
				eventId: conflictEventId,
				aggregateId,
				aggregateVersion: '2',
				sourceSequence: '11',
				state: identityState(aggregateId, true)
			});
			await waitFor('terminal projection conflict', async () => {
				const failure = await prisma.reportingConsumerFailure.findUnique({
					where: {
						eventId_consumer: {
							eventId: conflictEventId,
							consumer: 'reporting-identity-user-v1'
						}
					}
				});
				return (
					failure?.status === 'OPEN' && failure.manualRetryCount === 0
				);
			});

			await Promise.all(
				[1, 2].map(() =>
					requestJson(
						port,
						`/api/v1/admin/reporting/delivery-failures/${conflictEventId}/identityUser/retry`,
						{
							method: 'POST',
							headers: {
								authorization: 'Bearer integration-admin'
							}
						},
						202
					)
				)
			);
			await waitFor('first manual retry terminal state', async () => {
				const failure = await prisma.reportingConsumerFailure.findUnique({
					where: {
						eventId_consumer: {
							eventId: conflictEventId,
							consumer: 'reporting-identity-user-v1'
						}
					}
				});
				return (
					failure?.status === 'OPEN' && failure.manualRetryCount === 1
				);
			});
			await waitFor('single concurrent manual retry intent', async () => {
				const [manualRetries, audits] = await Promise.all([
					prisma.reportingOutboxEvent.findMany({
						where: {
							deduplicationKey: `consumer-manual-retry:reporting-identity-user-v1:${conflictEventId}:1`
						}
					}),
					findDeliveryRetryAuditOutbox(conflictEventId)
				]);
				return (
					manualRetries.length === 1 &&
					manualRetries[0].status === 'PUBLISHED' &&
					audits.length === 1 &&
					audits[0].status === 'PUBLISHED'
				);
			});

			await publishProjection(publisher, {
				eventId: newerEventId,
				aggregateId,
				aggregateVersion: '3',
				sourceSequence: '12',
				state: identityState(aggregateId, true)
			});
			await waitFor('newer projection', async () => {
				const projection = await prisma.identityUserProjection.findUnique({
					where: { id: aggregateId }
				});
				return projection?.aggregateVersion.toString() === '3';
			});
			await requestJson(
				port,
				`/api/v1/admin/reporting/delivery-failures/${conflictEventId}/identityUser/retry`,
				{
					method: 'POST',
					headers: { authorization: 'Bearer integration-admin' }
				},
				202
			);
			await waitFor('manual retry resolution', async () => {
				const [failure, receipt] = await Promise.all([
					prisma.reportingConsumerFailure.findUnique({
						where: {
							eventId_consumer: {
								eventId: conflictEventId,
								consumer: 'reporting-identity-user-v1'
							}
						}
					}),
					prisma.consumerReceipt.findUnique({
						where: {
							eventId_consumer: {
								eventId: conflictEventId,
								consumer: 'reporting-identity-user-v1'
							}
						}
					})
				]);
				return (
					failure?.status === 'RESOLVED' &&
					failure.manualRetryCount === 2 &&
					receipt?.status === 'DELIVERED' &&
					receipt.retryCycle === 2
				);
			});

			const cycleKeys = await prisma.reportingOutboxEvent.count({
				where: {
					deduplicationKey: {
						startsWith: `consumer-dead-letter:reporting-identity-user-v1:${conflictEventId}:`
					}
				}
			});
			if (cycleKeys !== 2) {
				throw new Error(
					'Manual retry cycles did not create distinct DLQ intents'
				);
			}
			await waitFor(
				'two published manual retry audit intents',
				async () => {
					const [manualRetryCount, audits] = await Promise.all([
						prisma.reportingOutboxEvent.count({
							where: {
								deduplicationKey: {
									startsWith: `consumer-manual-retry:reporting-identity-user-v1:${conflictEventId}:`
								},
								status: 'PUBLISHED'
							}
						}),
						findDeliveryRetryAuditOutbox(conflictEventId)
					]);
					return (
						manualRetryCount === 2 &&
						audits.length === 2 &&
						audits.every(audit => audit.status === 'PUBLISHED')
					);
				}
			);
		} finally {
			if (foreignQueue) {
				await publisher.deleteQueue(foreignQueue).catch(() => undefined);
			}
			await publisher.close();
		}
	} finally {
		await admin.close();
		await restricted.close();
	}
}

async function assertReportingSettingsManualRetry(port, publisher) {
	const eventId = randomUUID();
	const conflictThreadId = 3030;
	const settings = await prisma.reportingSettings.findUniqueOrThrow({
		where: { id: 'daily-summary' }
	});
	const changedAt = new Date(
		(settings.operationalAlertsChangedAt?.getTime() ?? Date.now()) + 1_000
	).toISOString();
	await prisma.reportingSettings.update({
		where: { id: 'daily-summary' },
		data: { messageThreadId: conflictThreadId }
	});
	await publishOperationsNotificationRouting(
		publisher,
		eventId,
		conflictThreadId,
		changedAt
	);
	await waitFor('Reporting settings terminal failure', async () => {
		const [failure, receipt] = await Promise.all([
			prisma.reportingConsumerFailure.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: 'reporting-settings-v1'
					}
				}
			}),
			prisma.consumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: 'reporting-settings-v1'
					}
				}
			})
		]);
		return (
			failure?.status === 'OPEN' &&
			failure.manualRetryCount === 0 &&
			receipt?.status === 'DEAD_LETTERED' &&
			receipt.retryCycle === 0
		);
	});

	await prisma.reportingSettings.update({
		where: { id: 'daily-summary' },
		data: { messageThreadId: conflictThreadId + 1 }
	});
	const retry = await requestJson(
		port,
		`/api/v1/admin/reporting/delivery-failures/${eventId}/reportingSettings/retry`,
		{
			method: 'POST',
			headers: { authorization: 'Bearer integration-admin' }
		},
		202
	);
	assert.equal(retry.eventId, eventId);
	assert.equal(retry.consumerKind, 'reportingSettings');
	assert.equal(retry.status, 'retry-requested');
	assert.equal(retry.manualRetryCount, 1);
	assert.ok(retry.retryRequestedAt);

	await waitFor('Reporting settings manual retry resolution', async () => {
		const [failure, receipt, projectedSettings] = await Promise.all([
			prisma.reportingConsumerFailure.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: 'reporting-settings-v1'
					}
				}
			}),
			prisma.consumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId,
						consumer: 'reporting-settings-v1'
					}
				}
			}),
			prisma.reportingSettings.findUnique({
				where: { id: 'daily-summary' }
			})
		]);
		return (
			failure?.status === 'RESOLVED' &&
			failure.manualRetryCount === 1 &&
			receipt?.status === 'DELIVERED' &&
			receipt.retryCycle === 1 &&
			projectedSettings?.operationalAlertsThreadId === conflictThreadId &&
			projectedSettings.operationalAlertsChangedAt?.toISOString() ===
				changedAt
		);
	});
	await waitFor(
		'Reporting settings retry Outbox publication',
		async () => {
			const [deadLetter, manualRetry, audits] = await Promise.all([
				prisma.reportingOutboxEvent.findUnique({
					where: {
						deduplicationKey: `consumer-dead-letter:reporting-settings-v1:${eventId}:0`
					}
				}),
				prisma.reportingOutboxEvent.findUnique({
					where: {
						deduplicationKey: `consumer-manual-retry:reporting-settings-v1:${eventId}:1`
					}
				}),
				findDeliveryRetryAuditOutbox(eventId)
			]);
			return (
				deadLetter?.status === 'PUBLISHED' &&
				manualRetry?.status === 'PUBLISHED' &&
				audits.length === 1 &&
				audits[0].status === 'PUBLISHED'
			);
		}
	);
}

async function findDeliveryRetryAuditOutbox(eventId) {
	const rows = await prisma.reportingOutboxEvent.findMany({
		where: { eventType: 'admin.audit.event.v1' }
	});
	return rows.filter(row => {
		const payload = row.payload;
		return (
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			payload.action === 'REPORTING_DELIVERY_RETRY' &&
			payload.target &&
			typeof payload.target === 'object' &&
			!Array.isArray(payload.target) &&
			payload.target.eventId === eventId
		);
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
	const captureChannelError = error => {
		channelErrors.push(error);
	};
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
				`Reporting RabbitMQ user has forbidden ${operation} access to ${queue}`
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
		assert.equal(
			channelErrors.length,
			1,
			`Denied ${operation} must emit exactly one channel error`
		);
		assertRabbitAccessRefused(
			channelErrors[0],
			expectedMethod,
			`${operation} channel`
		);
	} catch (error) {
		failure = error;
	}
	if (!channelClosed) {
		try {
			await channel.close();
		} catch (error) {
			if (!failure) failure = error;
		}
	}
	channel.off('error', captureChannelError);
	if (failure) throw failure;
}

function assertRabbitAccessRefused(error, expectedMethod, source) {
	const normalizedError = normalizeRabbitChannelClose(error, source);
	assert.equal(
		normalizedError.code,
		403,
		`${source} must fail with AMQP 403`
	);
	assert.equal(
		normalizedError.classId,
		expectedMethod.classId,
		`${source} failed in an unexpected AMQP class`
	);
	assert.equal(
		normalizedError.methodId,
		expectedMethod.methodId,
		`${source} failed in an unexpected AMQP method`
	);
	assert.match(
		normalizedError.reason,
		/ACCESS[_-]REFUSED/i,
		`${source} must contain the broker ACCESS_REFUSED reason`
	);
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

function identityState(id, hasPhoneIdentity) {
	return {
		id,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	};
}

async function publishProjection(channel, input) {
	const payload = {
		schemaVersion: 1,
		eventType: 'identity.user.changed.v1',
		eventId: input.eventId,
		aggregateId: input.aggregateId,
		aggregateVersion: input.aggregateVersion,
		sourceSequence: input.sourceSequence,
		occurredAt: '2026-07-31T00:00:00.000Z',
		tombstone: false,
		state: input.state
	};
	channel.publish(
		'winwidget.events',
		payload.eventType,
		// Pretty JSON deliberately differs from the compact JSONB serialization
		// used by manual retry. The receipt identity must be semantic/canonical,
		// not tied to the original wire whitespace or object key order.
		Buffer.from(JSON.stringify(payload, null, 2)),
		{
			mandatory: true,
			persistent: true,
			contentType: 'application/json',
			messageId: payload.eventId,
			type: payload.eventType,
			correlationId: payload.eventId,
			headers: { 'x-retry-attempt': 0, 'x-retry-cycle': 0 }
		}
	);
	await channel.waitForConfirms();
}

async function publishOperationsNotificationRouting(
	channel,
	eventId,
	operationalAlertsThreadId,
	changedAt = new Date().toISOString()
) {
	const eventType = 'operations.notification-routing.changed.v1';
	const payload = {
		schemaVersion: 1,
		eventId,
		operationalAlertsThreadId,
		changedAt
	};
	channel.publish(
		'winwidget.events',
		eventType,
		Buffer.from(JSON.stringify(payload)),
		{
			mandatory: true,
			persistent: true,
			contentType: 'application/json',
			messageId: eventId,
			type: eventType,
			correlationId: eventId,
			headers: {
				'x-aggregate-type': 'telegram-bot-settings',
				'x-aggregate-id': 'singleton',
				'x-retry-attempt': 0,
				'x-retry-cycle': 0
			}
		}
	);
	await channel.waitForConfirms();
}

async function publishDeliveryOutcome(channel, messageId) {
	const sourceEventId = randomUUID();
	const payload = {
		schemaVersion: 1,
		eventType: 'reporting.notification.delivery.outcome.v1',
		sourceEventId,
		sourceKind: 'daily-summary-delivery-telegram',
		reference: { type: 'daily-summary-job', id: randomUUID() },
		status: 'DELIVERED',
		failure: null,
		occurredAt: new Date().toISOString()
	};
	channel.publish(
		'winwidget.events',
		payload.eventType,
		Buffer.from(JSON.stringify(payload)),
		{
			mandatory: true,
			persistent: true,
			contentType: 'application/json',
			messageId,
			type: payload.eventType,
			correlationId: sourceEventId,
			headers: { 'x-retry-attempt': 0, 'x-retry-cycle': 0 }
		}
	);
	await channel.waitForConfirms();
}

async function cleanupDatabase() {
	await prisma.$transaction([
		prisma.reportingConsumerFailure.deleteMany(),
		prisma.consumerReceipt.deleteMany(),
		prisma.projectionReceipt.deleteMany(),
		prisma.projectionWatermark.deleteMany(),
		prisma.reportingOutboxEvent.deleteMany(),
		prisma.reportRun.deleteMany(),
		prisma.leadFact.deleteMany(),
		prisma.widgetProjection.deleteMany(),
		prisma.billingSubscriptionProjection.deleteMany(),
		prisma.billingPaymentFact.deleteMany(),
		prisma.identityUserProjection.deleteMany(),
		prisma.reportingHeartbeat.deleteMany(),
		prisma.reportingSettings.deleteMany()
	]);
}

async function assertCorsPreflight(port) {
	const path = '/api/v1/admin/reporting/dashboard';
	const allowed = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'OPTIONS',
		headers: {
			origin: allowedOrigin,
			'access-control-request-method': 'GET',
			'access-control-request-headers': 'authorization,content-type'
		},
		signal: AbortSignal.timeout(5_000)
	});
	if (
		allowed.status !== 204 ||
		allowed.headers.get('access-control-allow-origin') !== allowedOrigin ||
		allowed.headers.get('access-control-allow-credentials') !== 'true'
	) {
		throw new Error(
			'Reporting CORS preflight rejected the allowed origin'
		);
	}
	const denied = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'OPTIONS',
		headers: {
			origin: 'https://not-allowed.example',
			'access-control-request-method': 'GET'
		},
		signal: AbortSignal.timeout(5_000)
	});
	if (denied.headers.has('access-control-allow-origin')) {
		throw new Error('Reporting CORS preflight allowed an unknown origin');
	}
}

async function requestJson(port, path, init, expectedStatus) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		...init,
		signal: AbortSignal.timeout(5_000)
	});
	const body = await response.json().catch(() => null);
	if (response.status !== expectedStatus) {
		throw new Error(
			`${init.method || 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}: ${JSON.stringify(body)}`
		);
	}
	return body;
}

async function waitForReady(port, expectedRole, timeoutMs = 20_000) {
	await waitFor(
		'Reporting readiness',
		async () => {
			const response = await fetch(
				`http://127.0.0.1:${port}/health/ready`,
				{ signal: AbortSignal.timeout(2_000) }
			);
			return response.ok;
		},
		timeoutMs
	);
	const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
		signal: AbortSignal.timeout(2_000)
	});
	const raw = await response.text();
	const requestId = response.headers.get('x-request-id');
	const correlationId = response.headers.get('x-correlation-id');
	if (
		!response.ok ||
		!requestId ||
		correlationId !== requestId ||
		[internalToken, operationsToken, identityToken].some(token =>
			raw.includes(token)
		) ||
		/postgres(?:ql)?:\/\//i.test(raw) ||
		/amqps?:\/\//i.test(raw)
	) {
		throw new Error('Reporting readiness exposed a credential or URL');
	}
	const body = JSON.parse(raw);
	assert.deepEqual(body, {
		status: 'ready',
		service: 'reporting',
		role: expectedRole,
		revision: 'reporting-integration',
		schedulerEnabled: false
	});
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

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
}

async function withTimeout(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function stopService(process) {
	if (process.exitCode !== null) return;
	process.kill('SIGTERM');
	if (await waitForProcessExit(process, 10_000)) return;
	process.kill('SIGKILL');
	if (!(await waitForProcessExit(process, 5_000))) {
		throw new Error(
			'Reporting integration child did not exit after SIGKILL'
		);
	}
}

function waitForProcessExit(process, timeoutMs) {
	if (process.exitCode !== null) return Promise.resolve(true);
	return new Promise(resolve => {
		const timer = setTimeout(() => {
			process.off('exit', onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		process.once('exit', onExit);
	});
}

async function getFreePort() {
	const server = createTcpServer();
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

function assertLocalTestDatabase(url, variableName) {
	const parsed = new URL(url);
	const databaseName = parsed.pathname.replace(/^\//, '').toLowerCase();
	if (
		!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
		!(databaseName.includes('test') || databaseName.endsWith('_ci'))
	) {
		throw new Error(
			`${variableName} must point to a local test or CI database`
		);
	}
}

function assertLocalTestRabbit(url, variableName) {
	const parsed = new URL(url);
	if (
		!['amqp:', 'amqps:'].includes(parsed.protocol) ||
		!['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
		!parsed.username ||
		!parsed.password ||
		decodeURIComponent(parsed.pathname) !== '/winwidget'
	) {
		throw new Error(
			`${variableName} must use explicit credentials for the local winwidget test vhost`
		);
	}
}
