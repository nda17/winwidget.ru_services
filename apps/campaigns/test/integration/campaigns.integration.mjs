import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const databaseUrl = process.env.CAMPAIGNS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	console.log(
		'SKIP campaigns integration: CAMPAIGNS_TEST_DATABASE_URL is not set'
	);
	process.exit(0);
}
if (process.env.CAMPAIGNS_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('CAMPAIGNS_INTEGRATION_ALLOW_MUTATION=true is required');
}

const migrationDatabaseUrl =
	process.env.CAMPAIGNS_TEST_MIGRATION_DATABASE_URL?.trim() || databaseUrl;
assertLocalTestDatabase(databaseUrl, 'CAMPAIGNS_TEST_DATABASE_URL');
assertLocalTestDatabase(
	migrationDatabaseUrl,
	'CAMPAIGNS_TEST_MIGRATION_DATABASE_URL'
);
const testRabbitUrl = process.env.CAMPAIGNS_TEST_RABBITMQ_URL?.trim();
if (testRabbitUrl) {
	assertLocalTestRabbit(testRabbitUrl, 'CAMPAIGNS_TEST_RABBITMQ_URL');
}

const internalToken = `campaigns-integration-${randomUUID()}`;
const identityToken = `campaigns-identity-integration-${randomUUID()}`;
const billingToken = `campaigns-billing-integration-${randomUUID()}`;
if (new Set([internalToken, identityToken, billingToken]).size !== 3) {
	throw new Error('Campaigns integration tokens must be distinct');
}
const corsAllowedOrigin = 'http://127.0.0.1:3000';
const migration = spawnSync('pnpm', ['run', 'prisma:migrate:deploy'], {
	cwd: new URL('../../', import.meta.url),
	env: {
		...process.env,
		CAMPAIGNS_DATABASE_URL: migrationDatabaseUrl
	},
	encoding: 'utf8'
});
if (migration.status !== 0) {
	throw new Error(
		`Campaigns migration failed:\n${migration.stdout}\n${migration.stderr}`
	);
}

let identityIntrospectionCalls = 0;
const identityPort = await getFreePort();
const identity = createServer((request, response) => {
	if (
		request.headers['x-winwidget-service'] !== 'campaigns' ||
		request.headers['x-winwidget-internal-token'] !== identityToken
	) {
		response.writeHead(403).end();
		return;
	}
	if (
		request.method === 'POST' &&
		request.url === '/internal/v1/auth/introspect'
	) {
		if (request.headers.authorization !== 'Bearer integration-token') {
			response.writeHead(401).end();
			return;
		}
		identityIntrospectionCalls += 1;
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(
			JSON.stringify({
				active: true,
				subject: 'integration-admin',
				sessionId: randomUUID(),
				roles: ['ADMIN', 'DEV']
			})
		);
		return;
	}
	if (
		request.method === 'POST' &&
		request.url === '/internal/v1/campaigns/eligible-contacts'
	) {
		response
			.writeHead(200, { 'content-type': 'application/x-ndjson' })
			.end();
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	identity.once('error', reject);
	identity.listen(identityPort, '127.0.0.1', resolve);
});

const billingPort = await getFreePort();
const billing = createServer((request, response) => {
	if (
		request.headers['x-winwidget-service'] !== 'campaigns' ||
		request.headers['x-winwidget-internal-token'] !== billingToken
	) {
		response.writeHead(403).end();
		return;
	}
	if (
		request.method === 'POST' &&
		request.url === '/internal/v1/billing/campaigns/active-subscriber-ids'
	) {
		response
			.writeHead(200, { 'content-type': 'application/x-ndjson' })
			.end();
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	billing.once('error', reject);
	billing.listen(billingPort, '127.0.0.1', resolve);
});

const apiPort = await getFreePort();
const appEnv = {
	...process.env,
	CAMPAIGNS_DATABASE_URL: databaseUrl,
	CAMPAIGNS_PROCESS_ROLE: 'api',
	CAMPAIGNS_LISTEN_HOST: '127.0.0.1',
	CAMPAIGNS_HEALTH_PORT: String(apiPort),
	CAMPAIGNS_INTERNAL_TOKEN: internalToken,
	IDENTITY_INTERNAL_BASE_URL: `http://127.0.0.1:${identityPort}`,
	IDENTITY_INTERNAL_TIMEOUT_MS: '5000',
	IDENTITY_CAMPAIGNS_TOKEN: identityToken,
	BILLING_INTERNAL_BASE_URL: `http://127.0.0.1:${billingPort}`,
	BILLING_CAMPAIGNS_TOKEN: billingToken,
	CORS_ALLOWED_ORIGINS: corsAllowedOrigin,
	APP_REVISION: 'integration-test'
};
delete appEnv.CAMPAIGNS_CORE_INTERNAL_BASE_URL;
delete appEnv.CAMPAIGNS_INTERNAL_TIMEOUT_MS;
const app = spawn('node', ['dist/src/main.js'], {
	cwd: new URL('../../', import.meta.url),
	env: appEnv,
	stdio: 'inherit'
});

let campaignId;
try {
	await waitForReady(apiPort);
	await assertCorsPreflight(apiPort, corsAllowedOrigin);
	const idempotencyKey = randomUUID();
	const body = {
		subject: 'Integration campaign',
		message: 'Integration campaign message',
		audience: 'ALL',
		channel: 'EMAIL'
	};
	const created = await requestJson(
		apiPort,
		'/api/v1/admin/campaigns',
		{
			method: 'POST',
			headers: {
				authorization: 'Bearer integration-token',
				'idempotency-key': idempotencyKey,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		},
		202
	);
	campaignId = created.id;
	if (created.status !== 'SNAPSHOTTING') {
		throw new Error('Created campaign must be SNAPSHOTTING');
	}

	const replay = await requestJson(
		apiPort,
		'/api/v1/admin/campaigns',
		{
			method: 'POST',
			headers: {
				authorization: 'Bearer integration-token',
				'idempotency-key': idempotencyKey,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		},
		202
	);
	if (replay.id !== campaignId) {
		throw new Error('Idempotent replay returned another campaign');
	}

	const list = await requestJson(
		apiPort,
		'/api/v1/admin/campaigns?page=1&limit=20',
		{
			headers: {
				authorization: 'Bearer integration-token'
			}
		},
		200
	);
	if (!list.items.some(item => item.id === campaignId)) {
		throw new Error('Created campaign is missing from server page');
	}

	const cancelled = await requestJson(
		apiPort,
		`/api/v1/admin/campaigns/${campaignId}/cancel`,
		{
			method: 'POST',
			headers: {
				authorization: 'Bearer integration-token'
			}
		},
		202
	);
	if (cancelled.status !== 'CANCELLED') {
		throw new Error('Empty snapshotting campaign must cancel immediately');
	}

	await requestJson(
		apiPort,
		'/api/v1/admin/campaigns',
		{
			method: 'POST',
			headers: {
				authorization: 'Bearer integration-token',
				'idempotency-key': idempotencyKey,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				...body,
				subject: 'Different campaign'
			})
		},
		409
	);
	if (process.env.CAMPAIGNS_TEST_RABBITMQ_URL?.trim()) {
		await runRabbitMqSmoke(
			databaseUrl,
			process.env.CAMPAIGNS_TEST_RABBITMQ_URL.trim(),
			internalToken,
			identityToken,
			billingToken,
			identityPort,
			billingPort
		);
	}
	if (identityIntrospectionCalls !== 5) {
		throw new Error(
			`Campaigns integration expected 5 Identity introspections, received ${identityIntrospectionCalls}`
		);
	}
	console.log('Campaigns API integration smoke passed');
} finally {
	app.kill('SIGTERM');
	await Promise.race([
		new Promise(resolve => app.once('exit', resolve)),
		new Promise(resolve => setTimeout(resolve, 5000))
	]);
	await Promise.all([
		new Promise(resolve => identity.close(resolve)),
		new Promise(resolve => billing.close(resolve))
	]);
	await cleanup(databaseUrl, campaignId);
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
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${variableName} must be a valid URL`);
	}
	if (
		parsed.protocol !== 'amqp:' ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		decodeURIComponent(parsed.pathname.replace(/^\//, '')) !==
			'winwidget' ||
		!parsed.username ||
		!parsed.password
	) {
		throw new Error(
			`${variableName} must use authenticated local vhost winwidget`
		);
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value?.trim() === url.trim()) {
			throw new Error(`${variableName} must not reuse ${key}`);
		}
	}
}

async function cleanup(url, id) {
	const imported = await import('@prisma/campaigns-client');
	const PrismaClient =
		imported.PrismaClient || imported.default.PrismaClient;
	const prisma = new PrismaClient({
		datasources: { db: { url } }
	});
	try {
		if (id) {
			const [outboxEvents, deliveries] = await Promise.all([
				prisma.campaignOutboxEvent.findMany({
					where: { aggregateId: id },
					select: { messageId: true }
				}),
				prisma.campaignDelivery.findMany({
					where: { campaignId: id },
					select: { lastOutcomeEventId: true }
				})
			]);
			const receiptEventIds = [
				...new Set([
					...outboxEvents.map(event => event.messageId),
					...deliveries
						.map(delivery => delivery.lastOutcomeEventId)
						.filter(eventId => eventId !== null)
				])
			];
			await prisma.$transaction([
				prisma.campaignConsumerReceipt.deleteMany({
					where: { eventId: { in: receiptEventIds } }
				}),
				prisma.campaignOutboxEvent.deleteMany({
					where: { aggregateId: id }
				}),
				prisma.campaignIdempotencyRecord.deleteMany({
					where: { resourceId: id }
				}),
				prisma.campaignRateLimit.deleteMany({
					where: { campaignId: id }
				}),
				prisma.campaign.deleteMany({ where: { id } })
			]);
		}
		await prisma.campaignHeartbeat.deleteMany({
			where: { role: { in: ['api', 'all'] } }
		});
	} finally {
		await prisma.$disconnect();
	}
}

async function runRabbitMqSmoke(
	databaseUrl,
	rabbitUrl,
	internalToken,
	identityToken,
	billingToken,
	identityPort,
	billingPort
) {
	const port = await getFreePort();
	const serviceEnv = {
		...process.env,
		CAMPAIGNS_DATABASE_URL: databaseUrl,
		CAMPAIGNS_PROCESS_ROLE: 'all',
		CAMPAIGNS_LISTEN_HOST: '127.0.0.1',
		CAMPAIGNS_HEALTH_PORT: String(port),
		CAMPAIGNS_INTERNAL_TOKEN: internalToken,
		IDENTITY_INTERNAL_BASE_URL: `http://127.0.0.1:${identityPort}`,
		IDENTITY_INTERNAL_TIMEOUT_MS: '5000',
		IDENTITY_CAMPAIGNS_TOKEN: identityToken,
		BILLING_INTERNAL_BASE_URL: `http://127.0.0.1:${billingPort}`,
		BILLING_CAMPAIGNS_TOKEN: billingToken,
		CORS_ALLOWED_ORIGINS: corsAllowedOrigin,
		RABBITMQ_URL: rabbitUrl,
		RABBITMQ_ASSERT_TOPOLOGY: 'true',
		RABBITMQ_CONNECTION_NAME: 'campaigns-ci-restricted-smoke',
		APP_REVISION: 'integration-test'
	};
	delete serviceEnv.CAMPAIGNS_CORE_INTERNAL_BASE_URL;
	delete serviceEnv.CAMPAIGNS_INTERNAL_TIMEOUT_MS;
	const service = spawn('node', ['dist/src/main.js'], {
		cwd: new URL('../../', import.meta.url),
		env: serviceEnv,
		stdio: 'inherit'
	});
	try {
		await waitForReady(port);
		const imported = await import('amqplib');
		const connect = imported.connect || imported.default?.connect;
		if (!connect) throw new Error('amqplib connect is unavailable');
		const connection = await connect(rabbitUrl);
		try {
			const channel = await connection.createChannel();
			try {
				for (const queue of [
					'winwidget.campaigns.snapshot',
					'winwidget.campaigns.delivery-outcome.v2'
				]) {
					await channel.checkQueue(queue);
					await channel.checkQueue(`${queue}.dead-letter`);
					for (const index of [1, 2, 3]) {
						await channel.checkQueue(`${queue}.retry.${index}`);
					}
				}
			} finally {
				await channel.close();
			}
			const forbiddenChannel = await connection.createChannel();
			forbiddenChannel.on('error', () => undefined);
			try {
				await forbiddenChannel.checkQueue(
					'winwidget.maintenance.database-backup'
				);
				throw new Error(
					'Campaigns RabbitMQ user can read a foreign queue'
				);
			} catch (error) {
				if (error?.code !== 403) throw error;
			}
		} finally {
			await connection.close();
		}
		console.log(
			'Campaigns restricted RabbitMQ topology and consumers passed'
		);
	} finally {
		service.kill('SIGTERM');
		await Promise.race([
			new Promise(resolve => service.once('exit', resolve)),
			new Promise(resolve => setTimeout(resolve, 5000))
		]);
	}
}

async function assertCorsPreflight(port, allowedOrigin) {
	const path = '/api/v1/admin/campaigns?page=1&limit=20';
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'OPTIONS',
		headers: {
			origin: allowedOrigin,
			'access-control-request-method': 'GET',
			'access-control-request-headers': 'authorization,content-type'
		}
	});
	if (response.status !== 204) {
		throw new Error(
			`Campaigns CORS preflight expected 204, received ${response.status}`
		);
	}
	if (
		response.headers.get('access-control-allow-origin') !==
			allowedOrigin ||
		response.headers.get('access-control-allow-credentials') !== 'true'
	) {
		throw new Error(
			'Campaigns CORS preflight rejected the allowed origin'
		);
	}
	const methods = new Set(
		(response.headers.get('access-control-allow-methods') || '')
			.split(',')
			.map(value => value.trim().toUpperCase())
			.filter(Boolean)
	);
	if (!methods.has('GET')) {
		throw new Error('Campaigns CORS preflight does not allow GET');
	}
	const headers = new Set(
		(response.headers.get('access-control-allow-headers') || '')
			.split(',')
			.map(value => value.trim().toLowerCase())
			.filter(Boolean)
	);
	if (!headers.has('authorization') || !headers.has('content-type')) {
		throw new Error(
			'Campaigns CORS preflight does not allow authorization/content-type'
		);
	}

	const denied = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: 'OPTIONS',
		headers: {
			origin: 'https://not-allowed.example',
			'access-control-request-method': 'GET',
			'access-control-request-headers': 'authorization'
		}
	});
	if (denied.headers.has('access-control-allow-origin')) {
		throw new Error('Campaigns CORS preflight allowed an unknown origin');
	}
}

async function requestJson(port, path, init, expectedStatus) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
	const payload = await response.json();
	if (response.status !== expectedStatus) {
		throw new Error(
			`${init.method || 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}: ${JSON.stringify(payload)}`
		);
	}
	return payload;
}

async function waitForReady(port) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/health/ready`
			);
			if (response.ok) return;
		} catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error('Campaigns API did not become ready');
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
