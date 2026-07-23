import { PrismaClient } from '@prisma/client';
import * as amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL_DEVELOPMENT;
const rabbitUrl = process.env.RABBITMQ_URL;
const rabbitManagementUrl = process.env.RABBITMQ_MANAGEMENT_URL;
const rabbitUser = process.env.RABBITMQ_USER;
const rabbitPassword = process.env.RABBITMQ_PASSWORD;
const rabbitVhost = process.env.RABBITMQ_VHOST || 'winwidget';
if (
	!databaseUrl ||
	!rabbitUrl ||
	!rabbitManagementUrl ||
	!rabbitUser ||
	!rabbitPassword
) {
	throw new Error(
		'DATABASE_URL_DEVELOPMENT and RabbitMQ connection variables are required'
	);
}

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const children = [];
let connection;
let channel;
const createdEventIds = [];

const waitFor = async (check, label, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await check();
		if (result) return result;
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out waiting for ${label}`);
};

const startProcess = (entry, extraEnv = {}) => {
	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			MODE: 'development',
			DATABASE_URL_DEVELOPMENT: databaseUrl,
			RABBITMQ_URL: rabbitUrl,
			OUTBOX_POLL_INTERVAL_MS: '100',
			MESSAGING_SERVICE_NAME: `ci-${entry}`,
			...extraEnv
		},
		stdio: 'inherit'
	});
	children.push(child);
	return child;
};

try {
	await prisma.$connect();
	connection = await amqp.connect(rabbitUrl);

	startProcess('dist/src/outbox-publisher-main.js');
	await waitFor(async () => {
		const response = await fetch(
			`${rabbitManagementUrl.replace(/\/$/, '')}/api/exchanges/${encodeURIComponent(rabbitVhost)}/${encodeURIComponent('winwidget.events')}`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(`${rabbitUser}:${rabbitPassword}`).toString('base64')}`
				}
			}
		);
		if (response.status === 404) return false;
		if (!response.ok) {
			throw new Error(
				`RabbitMQ Management API returned ${response.status}`
			);
		}
		return true;
	}, 'publisher topology');
	channel = await connection.createChannel();

	const smokeEventCount = Number(
		process.env.MESSAGING_SMOKE_EVENT_COUNT || 10
	);
	const outboxEventIds = Array.from({ length: smokeEventCount }, () =>
		randomUUID()
	);
	createdEventIds.push(...outboxEventIds);
	const pendingEventIds = new Set(outboxEventIds);
	const received = new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() =>
				reject(
					new Error(
						`Outbox messages were not received: ${pendingEventIds.size} remaining`
					)
				),
			20_000
		);
		void channel
			.consume(
				'winwidget.lead-integration.webhook',
				message => {
					if (!message) return;
					if (
						!pendingEventIds.delete(message.properties.messageId || '')
					) {
						channel.nack(message, false, true);
						return;
					}
					channel.ack(message);
					if (pendingEventIds.size === 0) {
						clearTimeout(timeout);
						resolve(true);
					}
				},
				{ noAck: false }
			)
			.catch(reject);
	});

	await prisma.outboxEvent.createMany({
		data: outboxEventIds.map((id, index) => ({
			id,
			eventType: 'lead.integration.requested.v1',
			routingKey: 'lead.integration.webhook.v1',
			aggregateType: 'ci-smoke',
			aggregateId: randomUUID(),
			payload: {
				schemaVersion: 1,
				integration: 'webhook',
				source: 'widget',
				entity: { id: `ci-widget-${index}`, name: 'CI smoke' },
				lead: {
					id: randomUUID(),
					createdAt: new Date().toISOString()
				},
				destination: { webhookUrl: 'https://example.com' }
			}
		}))
	});
	await received;
	await waitFor(
		() =>
			prisma.outboxEvent
				.count({
					where: {
						id: { in: outboxEventIds },
						status: 'PUBLISHED'
					}
				})
				.then(count => count === smokeEventCount),
		'published outbox statuses'
	);

	startProcess('dist/src/integration-worker-main.js', {
		INTEGRATION_WORKER_KINDS: 'webhook'
	});
	await waitFor(async () => {
		const info = await channel.checkQueue(
			'winwidget.lead-integration.webhook.dead-letter'
		);
		return info.consumerCount > 0;
	}, 'dead-letter collector');

	const duplicateEventId = randomUUID();
	createdEventIds.push(duplicateEventId);
	const duplicatePayload = {
		schemaVersion: 1,
		integration: 'webhook',
		source: 'widget',
		entity: { id: 'ci-duplicate-widget', name: 'CI duplicate' },
		lead: {
			id: randomUUID(),
			createdAt: new Date().toISOString()
		},
		destination: { webhookUrl: 'https://example.com' }
	};
	await prisma.integrationDeliveryReceipt.create({
		data: { eventId: duplicateEventId, integration: 'webhook' }
	});
	await prisma.integrationDeliveryFailure.create({
		data: {
			eventId: duplicateEventId,
			integration: 'webhook',
			routingKey: 'lead.integration.webhook.v1',
			payload: duplicatePayload,
			attempts: 4,
			lastError: 'CI duplicate guard'
		}
	});
	channel.publish(
		'winwidget.events',
		'lead.integration.webhook.v1',
		Buffer.from(JSON.stringify(duplicatePayload)),
		{
			persistent: true,
			messageId: duplicateEventId,
			contentType: 'application/json'
		}
	);
	await waitFor(
		() =>
			prisma.integrationDeliveryFailure
				.findUnique({ where: { eventId: duplicateEventId } })
				.then(failure => Boolean(failure?.resolvedAt)),
		'duplicate receipt resolution'
	);

	const malformedEventId = randomUUID();
	createdEventIds.push(malformedEventId);
	channel.publish(
		'winwidget.events',
		'lead.integration.webhook.v1',
		Buffer.from('{"schemaVersion":1,"invalid":true}'),
		{
			persistent: true,
			messageId: malformedEventId,
			contentType: 'application/json'
		}
	);
	await waitFor(
		() =>
			prisma.integrationDeliveryFailure.findUnique({
				where: { eventId: malformedEventId }
			}),
		'persisted DLQ failure'
	);

	process.stdout.write(
		`Messaging integration smoke passed: ${smokeEventCount} Outbox -> RabbitMQ and malformed -> DLQ -> PostgreSQL\n`
	);
} finally {
	for (const child of children) child.kill('SIGTERM');
	if (channel) await channel.close().catch(() => undefined);
	if (connection) await connection.close().catch(() => undefined);
	if (createdEventIds.length) {
		await prisma.integrationDeliveryFailure
			.deleteMany({ where: { eventId: { in: createdEventIds } } })
			.catch(() => undefined);
		await prisma.integrationDeliveryReceipt
			.deleteMany({ where: { eventId: { in: createdEventIds } } })
			.catch(() => undefined);
		await prisma.outboxEvent
			.deleteMany({ where: { id: { in: createdEventIds } } })
			.catch(() => undefined);
	}
	await prisma.$disconnect();
}
