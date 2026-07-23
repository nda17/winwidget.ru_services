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
let childFailure;
let connection;
let channel;
const createdEventIds = [];
const requiredQueues = [
	'winwidget.lead-integration.email',
	'winwidget.lead-integration.webhook',
	'winwidget.lead-integration.telegram',
	'winwidget.lead-integration.bitrix24',
	'winwidget.lead-integration.amo-crm',
	'winwidget.payment-notification.email',
	'winwidget.payment-notification.telegram',
	'winwidget.mailing.email',
	'winwidget.mailing.telegram',
	'winwidget.limit-notification.email',
	'winwidget.limit-notification.telegram'
];

const getRabbitManagementStatus = async path => {
	const response = await fetch(
		`${rabbitManagementUrl.replace(/\/$/, '')}${path}`,
		{
			headers: {
				Authorization: `Basic ${Buffer.from(
					`${rabbitUser}:${rabbitPassword}`
				).toString('base64')}`
			}
		}
	);
	await response.body?.cancel();
	return response.status;
};

const waitFor = async (check, label, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (childFailure) throw childFailure;
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
	child.once('exit', (code, signal) => {
		if (code !== 0 && signal !== 'SIGTERM') {
			childFailure = new Error(
				`${entry} exited unexpectedly: code=${code}, signal=${signal || 'none'}`
			);
		}
	});
	children.push(child);
	return child;
};

const stopChildren = async () => {
	await Promise.all(
		children.map(
			child =>
				new Promise(resolve => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve();
						return;
					}
					const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
					child.once('exit', () => {
						clearTimeout(forceStop);
						resolve();
					});
					child.kill('SIGTERM');
				})
		)
	);
};

try {
	await prisma.$connect();
	connection = await amqp.connect(rabbitUrl);

	startProcess('dist/src/outbox-publisher-main.js');
	await waitFor(async () => {
		const statuses = await Promise.all(
			requiredQueues.map(queue =>
				getRabbitManagementStatus(
					`/api/queues/${encodeURIComponent(rabbitVhost)}/${encodeURIComponent(queue)}`
				)
			)
		);
		if (statuses.some(status => status === 404)) return false;
		const failedStatus = statuses.find(
			status => status < 200 || status >= 300
		);
		if (failedStatus) {
			throw new Error(`RabbitMQ Management API returned ${failedStatus}`);
		}
		return true;
	}, 'publisher queues');
	channel = await connection.createChannel();

	const configuredSmokeEventCount = Number(
		process.env.MESSAGING_SMOKE_EVENT_COUNT || 10
	);
	const smokeEventCount =
		Number.isInteger(configuredSmokeEventCount) &&
		configuredSmokeEventCount > 0 &&
		configuredSmokeEventCount <= 100
			? configuredSmokeEventCount
			: 10;
	const outboxEventIds = Array.from({ length: smokeEventCount }, () =>
		randomUUID()
	);
	createdEventIds.push(...outboxEventIds);
	const pendingEventIds = new Set(outboxEventIds);
	const { consumerTag: outboxConsumerTag } = await channel.consume(
		'winwidget.lead-integration.webhook',
		message => {
			if (!message) return;
			if (!pendingEventIds.delete(message.properties.messageId || '')) {
				channel.nack(message, false, true);
				return;
			}
			try {
				const payload = JSON.parse(message.content.toString('utf8'));
				if (
					payload?.schemaVersion !== 1 ||
					payload?.integration !== 'webhook' ||
					!payload?.lead?.id
				) {
					throw new Error('Unexpected lead integration payload');
				}
			} catch (error) {
				childFailure = new Error(
					`Outbox published invalid JSON payload: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			}
			channel.ack(message);
		},
		{ noAck: false }
	);

	await prisma.outboxEvent.createMany({
		data: outboxEventIds.map((id, index) => ({
			id,
			eventType: 'lead.integration.requested.v1',
			routingKey: 'lead.integration.webhook.v1',
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
	await waitFor(
		() => pendingEventIds.size === 0,
		`Outbox messages (${pendingEventIds.size} remaining)`
	);
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
	await channel.cancel(outboxConsumerTag);

	const unroutableEventId = randomUUID();
	createdEventIds.push(unroutableEventId);
	await prisma.outboxEvent.create({
		data: {
			id: unroutableEventId,
			eventType: 'ci.unroutable.v1',
			routingKey: 'ci.missing.route.v1',
			payload: {
				schemaVersion: 1,
				eventType: 'ci.unroutable.v1'
			}
		}
	});
	await waitFor(
		() =>
			prisma.outboxEvent
				.findUnique({
					where: { id: unroutableEventId },
					select: {
						status: true,
						attempts: true,
						lastError: true
					}
				})
				.then(
					event =>
						event?.status === 'PENDING' &&
						event.attempts >= 1 &&
						event.lastError?.includes('returned publication')
				),
		'unroutable Outbox retry'
	);
	await waitFor(
		() =>
			prisma.outboxEvent
				.deleteMany({
					where: {
						id: unroutableEventId,
						status: 'PENDING'
					}
				})
				.then(result => result.count === 1),
		'unroutable Outbox cleanup'
	);

	const manualRetryOutboxId = randomUUID();
	const manualRetryEventId = randomUUID();
	createdEventIds.push(manualRetryOutboxId, manualRetryEventId);
	let manualRetryReceived = false;
	const { consumerTag: manualRetryConsumerTag } = await channel.consume(
		'winwidget.lead-integration.webhook',
		message => {
			if (!message) return;
			if (message.properties.messageId !== manualRetryEventId) {
				channel.nack(message, false, true);
				return;
			}
			try {
				const payload = JSON.parse(message.content.toString('utf8'));
				if (
					payload?.schemaVersion !== 1 ||
					payload?.integration !== 'webhook'
				) {
					throw new Error('Manual retry payload is invalid');
				}
			} catch (error) {
				childFailure =
					error instanceof Error
						? error
						: new Error(String(error));
			}
			manualRetryReceived = true;
			channel.ack(message);
		},
		{ noAck: false }
	);
	await prisma.outboxEvent.create({
		data: {
			id: manualRetryOutboxId,
			messageId: manualRetryEventId,
			eventType: 'lead.integration.requested.v1',
			routingKey: 'manual.webhook',
			payload: {
				schemaVersion: 1,
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'ci-manual-widget', name: 'CI manual retry' },
				lead: {
					id: randomUUID(),
					createdAt: new Date().toISOString()
				},
				destination: { webhookUrl: 'https://example.com' }
			}
		}
	});
	await waitFor(() => manualRetryReceived, 'manual retry Outbox routing');
	await waitFor(
		() =>
			prisma.outboxEvent
				.findUnique({
					where: { id: manualRetryOutboxId },
					select: { status: true }
				})
				.then(event => event?.status === 'PUBLISHED'),
		'published manual retry Outbox status'
	);
	await channel.cancel(manualRetryConsumerTag);

	const paymentEventId = randomUUID();
	createdEventIds.push(paymentEventId);
	const pendingPaymentQueues = new Set([
		'payment-email',
		'payment-telegram'
	]);
	const paymentConsumerTags = [];
	for (const [kind, queue] of [
		['payment-email', 'winwidget.payment-notification.email'],
		['payment-telegram', 'winwidget.payment-notification.telegram']
	]) {
		const { consumerTag } = await channel.consume(
			queue,
			message => {
				if (!message) return;
				if (message.properties.messageId !== paymentEventId) {
					channel.nack(message, false, true);
					return;
				}
				try {
					const payload = JSON.parse(message.content.toString('utf8'));
					if (
						payload?.schemaVersion !== 1 ||
						payload?.eventType !== 'payment.succeeded.v1' ||
						payload?.payment?.id !== 'ci-payment'
					) {
						throw new Error('Unexpected payment event payload');
					}
				} catch (error) {
					childFailure = new Error(
						`Payment fan-out contained invalid JSON payload: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				}
				pendingPaymentQueues.delete(kind);
				channel.ack(message);
			},
			{ noAck: false }
		);
		paymentConsumerTags.push(consumerTag);
	}
	await prisma.outboxEvent.create({
		data: {
			id: paymentEventId,
			eventType: 'payment.succeeded.v1',
			routingKey: 'payment.succeeded.v1',
			payload: {
				schemaVersion: 1,
				eventType: 'payment.succeeded.v1',
				payment: {
					id: 'ci-payment',
					yookassaId: 'ci-yookassa',
					amount: '990.00',
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					succeededAt: new Date().toISOString()
				},
				user: {
					id: 'ci-user',
					name: 'CI',
					email: 'ci@example.com',
					phone: null
				},
				subscription: { expiresAt: null }
			}
		}
	});
	await waitFor(
		() => pendingPaymentQueues.size === 0,
		'payment event fan-out'
	);
	await waitFor(
		() =>
			prisma.outboxEvent
				.findUnique({
					where: { id: paymentEventId },
					select: { status: true }
				})
				.then(event => event?.status === 'PUBLISHED'),
		'published payment outbox status'
	);
	for (const consumerTag of paymentConsumerTags) {
		await channel.cancel(consumerTag);
	}

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
		data: {
			eventId: duplicateEventId,
			integration: 'webhook',
			status: 'DELIVERED',
			deliveredAt: new Date()
		}
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
				.findUnique({
					where: {
						eventId_integration: {
							eventId: duplicateEventId,
							integration: 'webhook'
						}
					}
				})
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
				where: {
					eventId_integration: {
						eventId: malformedEventId,
						integration: 'webhook'
					}
				}
			}),
		'persisted DLQ failure'
	);

	process.stdout.write(
		`Messaging integration smoke passed: ${smokeEventCount} lead events, mandatory return, manual retry routing, payment fan-out and malformed -> DLQ -> PostgreSQL\n`
	);
} finally {
	if (channel) await channel.close().catch(() => undefined);
	if (connection) await connection.close().catch(() => undefined);
	await stopChildren();
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
