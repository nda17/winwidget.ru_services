import { PrismaClient } from '@prisma/client';
import * as amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
	ScheduledTasksService
} = require('../dist/src/maintenance/scheduled-tasks.service.js');
const {
	assertMessagingEventContract
} = require('../dist/src/messaging/messaging-event-contract.js');
const {
	ReportingProjectionSnapshotService
} = require('../dist/src/reporting-internal/reporting-projection-snapshot.service.js');

const databaseUrl = process.env.DATABASE_URL_DEVELOPMENT;
const rabbitUrl = process.env.RABBITMQ_URL;
const rabbitManagementUrl = process.env.RABBITMQ_MANAGEMENT_URL;
const rabbitUser = process.env.RABBITMQ_USER;
const rabbitPassword = process.env.RABBITMQ_PASSWORD;
const rabbitVhost = process.env.RABBITMQ_VHOST || 'winwidget';
const rabbitContainerId = process.env.RABBITMQ_CONTAINER_ID;
if (process.env.MESSAGING_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('MESSAGING_INTEGRATION_ALLOW_MUTATION=true is required');
}
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const parseLocalUrl = (rawValue, variableName, protocols) => {
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
};

const assertLocalTestDatabase = (rawValue, variableName) => {
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
	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value?.trim() === rawValue.trim()) {
			throw new Error(`${variableName} must not reuse ${key}`);
		}
	}
};

const assertLocalTestRabbit = (rawValue, variableName) => {
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
	for (const [key, value] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && value?.trim() === rawValue.trim()) {
			throw new Error(`${variableName} must not reuse ${key}`);
		}
	}
};

const assertLocalManagementUrl = (rawValue, variableName) => {
	const parsed = parseLocalUrl(rawValue, variableName, ['http:']);
	if (
		parsed.username ||
		parsed.password ||
		(parsed.pathname !== '/' && parsed.pathname !== '') ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(
			`${variableName} must be a credential-free local origin`
		);
	}
};

assertLocalTestDatabase(databaseUrl, 'DATABASE_URL_DEVELOPMENT');
assertLocalTestRabbit(rabbitUrl, 'RABBITMQ_URL');
assertLocalManagementUrl(rabbitManagementUrl, 'RABBITMQ_MANAGEMENT_URL');

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const children = [];
let childFailure;
let connection;
let channel;
let maintenanceScheduleState;
let reportingAuditActorId;
const createdEventIds = [];
const createdScheduledJobIds = [];
const requiredQueues = [
	'winwidget.lead-integration.email',
	'winwidget.lead-integration.webhook',
	'winwidget.lead-integration.telegram',
	'winwidget.lead-integration.bitrix24',
	'winwidget.lead-integration.amo-crm',
	'winwidget.payment-notification.email',
	'winwidget.payment-notification.telegram.v2',
	'winwidget.notification.campaign.email.v2',
	'winwidget.notification.campaign.telegram.v2',
	'winwidget.admin.audit.campaigns.v1',
	'winwidget.admin.audit.reporting.v1',
	'winwidget.limit-notification.email',
	'winwidget.limit-notification.telegram',
	'winwidget.report.daily-summary.telegram',
	'winwidget.notification.telegram-destination-unavailable',
	'winwidget.maintenance.database-backup'
];

const reportingEventTypes = [
	'identity.user.changed.v1',
	'billing.payment.changed.v1',
	'billing.subscription.changed.v1',
	'widgets.widget.changed.v1',
	'widgets.lead.changed.v1',
	'reporting.settings.changed.v1'
];

const streamReportingProjectionSnapshot = async () => {
	const chunks = [];
	const request = { aborted: false };
	const response = {
		destroyed: false,
		writableEnded: false,
		write(value) {
			chunks.push(value);
			return true;
		}
	};
	await new ReportingProjectionSnapshotService(prisma).stream(
		request,
		response
	);
	return chunks;
};

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
	const ownsTopology = entry.endsWith('outbox-publisher-main.js');
	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			MODE: 'development',
			DATABASE_URL_DEVELOPMENT: databaseUrl,
			RABBITMQ_URL: rabbitUrl,
			RABBITMQ_ASSERT_TOPOLOGY: ownsTopology ? 'true' : 'false',
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

const verifyManualBackupAdvisoryLock = async () => {
	const adminId = `ci-admin-${randomUUID()}`;
	const idempotencyKey = randomUUID();
	const jobId = randomUUID();
	const now = new Date();

	try {
		await prisma.$transaction([
			prisma.scheduledJobRun.create({
				data: {
					id: jobId,
					jobType: 'DATABASE_BACKUP',
					scheduleKey: `ci:manual-backup:${jobId}`,
					trigger: 'MANUAL',
					status: 'SUCCEEDED',
					scheduledFor: now,
					input: { requestedByAdminId: adminId },
					finishedAt: now
				}
			}),
			prisma.scheduledJobIdempotencyKey.create({
				data: {
					adminId,
					jobType: 'DATABASE_BACKUP',
					idempotencyKey,
					jobId
				}
			})
		]);

		const service = new ScheduledTasksService(prisma, {}, {});
		const result = await service.enqueueManualDatabaseBackup(
			'core',
			adminId,
			idempotencyKey
		);
		if (result.created || result.jobId !== jobId) {
			throw new Error(
				'Manual backup advisory-lock smoke returned another job'
			);
		}
	} finally {
		await prisma.scheduledJobIdempotencyKey.deleteMany({
			where: { jobId }
		});
		await prisma.scheduledJobRun.deleteMany({ where: { id: jobId } });
	}
};

const verifyReportingProjectionProducers = async () => {
	const suffix = randomUUID();
	const disabledUserId = `ci-reporting-disabled-${suffix}`;
	const rollbackUserId = `ci-reporting-rollback-${suffix}`;
	const userId = `ci-reporting-user-${suffix}`;
	const emailIdentityId = `ci-reporting-email-${suffix}`;
	const phoneIdentityId = `ci-reporting-phone-${suffix}`;
	const paymentId = `ci-reporting-payment-${suffix}`;
	const subscriptionId = `ci-reporting-subscription-${suffix}`;
	const widgetId = `ci-reporting-widget-${suffix}`;
	const leadId = `ci-reporting-lead-${suffix}`;
	const widgetTypes = [
		'wheel',
		'quiz',
		'callback',
		'countdownTimer',
		'stopOffer',
		'onlineConsultant',
		'calculator'
	];
	const widgetAggregateIds = widgetTypes.map(
		type => `${type}:${widgetId}`
	);
	const leadAggregateIds = widgetTypes.map(type => `${type}:${leadId}`);
	const emailValue = `projection-${suffix}@example.invalid`;
	const phoneValue = `+7000${suffix.replaceAll('-', '').slice(0, 10)}`;
	const leadContact = `private-contact-${suffix}`;
	const installDomain = `private-${suffix}.example.invalid`;
	const aggregateIds = [
		disabledUserId,
		rollbackUserId,
		userId,
		paymentId,
		subscriptionId,
		...widgetAggregateIds,
		...leadAggregateIds
	];
	let originalState;

	try {
		originalState = await prisma.reportingProducerState.findUniqueOrThrow({
			where: { id: 'singleton' }
		});
		if (originalState.enabled) {
			throw new Error(
				'Reporting projection producer must be disabled before integration smoke'
			);
		}
		try {
			await streamReportingProjectionSnapshot();
			throw new Error(
				'Disabled Reporting producer allowed a projection snapshot'
			);
		} catch (error) {
			if (
				!error?.message?.includes(
					'Reporting projection snapshot requires enabled producers'
				)
			) {
				throw error;
			}
		}

		await prisma.user.create({
			data: {
				id: disabledUserId,
				password: 'not-a-real-password'
			}
		});
		const disabledEvents = await prisma.outboxEvent.count({
			where: {
				eventType: { in: reportingEventTypes },
				payload: { path: ['aggregateId'], equals: disabledUserId }
			}
		});
		if (disabledEvents !== 0) {
			throw new Error(
				'Disabled Reporting producer created an Outbox event'
			);
		}
		await prisma.user.delete({ where: { id: disabledUserId } });

		await prisma.reportingProducerState.update({
			where: { id: 'singleton' },
			data: { enabled: true, activatedAt: new Date() }
		});
		const snapshotChunks = await streamReportingProjectionSnapshot();
		const snapshotLines = snapshotChunks.map(chunk => JSON.parse(chunk));
		if (
			snapshotLines[0]?.kind !== 'header' ||
			snapshotLines.at(-1)?.kind !== 'footer'
		) {
			throw new Error(
				'Enabled Reporting producer did not produce a complete snapshot'
			);
		}
		try {
			await prisma.$transaction(async transaction => {
				await transaction.user.create({
					data: {
						id: rollbackUserId,
						password: 'not-a-real-password'
					}
				});
				throw new Error('EXPECTED_REPORTING_PRODUCER_ROLLBACK');
			});
			throw new Error('Reporting rollback smoke unexpectedly committed');
		} catch (error) {
			if (error?.message !== 'EXPECTED_REPORTING_PRODUCER_ROLLBACK') {
				throw error;
			}
		}
		const rolledBackArtifacts = await Promise.all([
			prisma.user.count({ where: { id: rollbackUserId } }),
			prisma.outboxEvent.count({
				where: {
					eventType: 'identity.user.changed.v1',
					payload: { path: ['aggregateId'], equals: rollbackUserId }
				}
			}),
			prisma.reportingProjectionVersion.count({
				where: {
					aggregateType: 'identity.user',
					aggregateId: rollbackUserId
				}
			})
		]);
		if (rolledBackArtifacts.some(count => count !== 0)) {
			throw new Error(
				'Reporting producer artifacts survived a rolled-back transaction'
			);
		}
		await prisma.user.create({
			data: { id: userId, password: 'not-a-real-password' }
		});
		await prisma.authIdentity.create({
			data: {
				id: emailIdentityId,
				userId,
				type: 'EMAIL',
				value: emailValue
			}
		});
		await prisma.user.updateMany({
			where: { id: userId },
			data: { status: 'DEACTIVATED' }
		});
		await prisma.authIdentity.create({
			data: {
				id: phoneIdentityId,
				userId,
				type: 'PHONE',
				value: phoneValue
			}
		});
		await prisma.authIdentity.updateMany({
			where: { id: phoneIdentityId },
			data: { verifiedAt: new Date() }
		});
		await prisma.payment.create({
			data: {
				id: paymentId,
				userId,
				amount: '990.00',
				checkoutExpiresAt: new Date(Date.now() + 60_000)
			}
		});
		await prisma.subscription.create({
			data: { id: subscriptionId, userId }
		});
		await prisma.widget.create({
			data: {
				id: widgetId,
				userId,
				publicKey: `ci-reporting-${suffix}`,
				installDomain
			}
		});
		await prisma.lead.create({
			data: { id: leadId, widgetId, contact: leadContact }
		});
		await prisma.$transaction([
			prisma.quiz.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-quiz-${suffix}`,
					installDomain
				}
			}),
			prisma.callback.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-callback-${suffix}`,
					installDomain
				}
			}),
			prisma.countdownTimer.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-countdown-${suffix}`,
					installDomain
				}
			}),
			prisma.stopOffer.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-stop-${suffix}`,
					installDomain
				}
			}),
			prisma.onlineConsultant.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-consultant-${suffix}`,
					installDomain
				}
			}),
			prisma.calculator.create({
				data: {
					id: widgetId,
					userId,
					publicKey: `ci-reporting-calculator-${suffix}`,
					installDomain
				}
			})
		]);
		await prisma.$transaction([
			prisma.quizLead.create({
				data: { id: leadId, quizId: widgetId, contact: leadContact }
			}),
			prisma.callbackLead.create({
				data: { id: leadId, callbackId: widgetId, phone: phoneValue }
			}),
			prisma.countdownTimerLead.create({
				data: { id: leadId, countdownTimerId: widgetId, phone: phoneValue }
			}),
			prisma.stopOfferLead.create({
				data: { id: leadId, stopOfferId: widgetId, email: emailValue }
			}),
			prisma.onlineConsultantLead.create({
				data: {
					id: leadId,
					onlineConsultantId: widgetId,
					phone: phoneValue
				}
			}),
			prisma.calculatorLead.create({
				data: {
					id: leadId,
					calculatorId: widgetId,
					contact: leadContact,
					calculatedPrice: '123.45'
				}
			})
		]);

		const identityEvents = await prisma.outboxEvent.findMany({
			where: {
				eventType: 'identity.user.changed.v1',
				payload: { path: ['aggregateId'], equals: userId }
			},
			orderBy: { createdAt: 'asc' },
			select: { payload: true }
		});
		const versions = identityEvents.map(event =>
			Number(event.payload.aggregateVersion)
		);
		if (
			versions.length !== 5 ||
			versions.some((version, index) => version !== index + 1)
		) {
			throw new Error(
				`Reporting aggregate versions are not gapless: ${versions.join(',')}`
			);
		}
		const sequences = identityEvents.map(event =>
			BigInt(event.payload.sourceSequence)
		);
		if (
			sequences.some(
				(sequence, index) => index > 0 && sequence <= sequences[index - 1]
			)
		) {
			throw new Error('Reporting sourceSequence is not monotonic');
		}
		const lastIdentityState = identityEvents.at(-1)?.payload.state;
		const expectedIdentityKeys = [
			'createdAt',
			'deletedAt',
			'hasEmailIdentity',
			'hasPhoneIdentity',
			'hasTelegramIdentity',
			'id',
			'loginMethodCount',
			'roles',
			'status',
			'updatedAt'
		];
		if (
			!lastIdentityState ||
			Object.keys(lastIdentityState).sort().join('|') !==
				expectedIdentityKeys.join('|') ||
			lastIdentityState.loginMethodCount !== 2
		) {
			throw new Error('Reporting identity state contract drifted');
		}

		await prisma.user.delete({ where: { id: userId } });
		const cascadeEvents = await prisma.outboxEvent.findMany({
			where: {
				eventType: { in: reportingEventTypes },
				OR: [
					userId,
					paymentId,
					subscriptionId,
					...widgetAggregateIds,
					...leadAggregateIds
				].map(id => ({
					payload: { path: ['aggregateId'], equals: id }
				}))
			},
			select: {
				id: true,
				messageId: true,
				eventType: true,
				routingKey: true,
				payload: true
			}
		});
		for (const event of cascadeEvents) {
			assertMessagingEventContract(event.payload, {
				eventType: event.eventType,
				routingKey: event.routingKey,
				messageId: event.messageId || event.id
			});
		}
		const postCascadeIdentityEvents = cascadeEvents
			.filter(
				event =>
					event.eventType === 'identity.user.changed.v1' &&
					event.payload.aggregateId === userId
			)
			.sort(
				(left, right) =>
					Number(left.payload.aggregateVersion) -
					Number(right.payload.aggregateVersion)
			);
		if (
			postCascadeIdentityEvents.length !== 6 ||
			postCascadeIdentityEvents.at(-1)?.payload.tombstone !== true
		) {
			throw new Error(
				'AuthIdentity cascade emitted a missing or resurrecting user projection'
			);
		}
		for (const [eventType, aggregateId] of [
			['identity.user.changed.v1', userId],
			['billing.payment.changed.v1', paymentId],
			['billing.subscription.changed.v1', subscriptionId],
			...widgetAggregateIds.map(id => ['widgets.widget.changed.v1', id]),
			...leadAggregateIds.map(id => ['widgets.lead.changed.v1', id])
		]) {
			const tombstone = cascadeEvents.find(
				event =>
					event.eventType === eventType &&
					event.payload.aggregateId === aggregateId &&
					event.payload.tombstone === true &&
					event.payload.state === null
			);
			if (!tombstone) {
				throw new Error(
					`Reporting cascade tombstone is missing for ${eventType}`
				);
			}
		}

		const serializedPayloads = JSON.stringify(
			cascadeEvents.map(event => event.payload)
		);
		for (const forbiddenValue of [
			emailValue,
			phoneValue,
			leadContact,
			installDomain
		]) {
			if (serializedPayloads.includes(forbiddenValue)) {
				throw new Error(
					'Reporting projection payload contains source PII'
				);
			}
		}
	} finally {
		await prisma.reportingProducerState.updateMany({
			where: { id: 'singleton' },
			data: {
				enabled: false,
				activatedAt: originalState?.activatedAt || null
			}
		});
		await prisma.user.deleteMany({
			where: { id: { in: [disabledUserId, rollbackUserId, userId] } }
		});
		const events = await prisma.outboxEvent.findMany({
			where: {
				eventType: { in: reportingEventTypes },
				OR: aggregateIds.map(id => ({
					payload: { path: ['aggregateId'], equals: id }
				}))
			},
			select: { id: true }
		});
		await prisma.outboxEvent.deleteMany({
			where: { id: { in: events.map(event => event.id) } }
		});
		await prisma.reportingProjectionVersion.deleteMany({
			where: { aggregateId: { in: aggregateIds } }
		});
	}
};

try {
	await prisma.$connect();
	await verifyReportingProjectionProducers();
	await verifyManualBackupAdvisoryLock();
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
					payload?.schemaVersion !== 2 ||
					payload?.eventType !== 'lead.integration.requested.v2' ||
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
			eventType: 'lead.integration.requested.v2',
			routingKey: 'lead.integration.webhook.v2',
			payload: {
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'webhook',
				source: 'widget',
				entity: { id: `ci-widget-${index}`, name: 'CI smoke' },
				lead: {
					id: randomUUID(),
					createdAt: new Date().toISOString()
				},
				destination: { credentialRef: randomUUID() }
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
	// Keep the event contract valid while exercising RabbitMQ's real NO_ROUTE path.
	await channel.unbindQueue(
		'winwidget.lead-integration.webhook',
		'winwidget.events',
		'lead.integration.webhook.v2'
	);
	try {
		await prisma.outboxEvent.create({
			data: {
				id: unroutableEventId,
				eventType: 'lead.integration.requested.v2',
				routingKey: 'lead.integration.webhook.v2',
				payload: {
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: {
						id: 'ci-unroutable-widget',
						name: 'CI unroutable'
					},
					lead: {
						id: randomUUID(),
						createdAt: new Date().toISOString()
					},
					destination: { credentialRef: randomUUID() }
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
	} finally {
		await channel.bindQueue(
			'winwidget.lead-integration.webhook',
			'winwidget.events',
			'lead.integration.webhook.v2'
		);
	}

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
					payload?.schemaVersion !== 2 ||
					payload?.eventType !== 'lead.integration.requested.v2' ||
					payload?.integration !== 'webhook'
				) {
					throw new Error('Manual retry payload is invalid');
				}
			} catch (error) {
				childFailure =
					error instanceof Error ? error : new Error(String(error));
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
			eventType: 'lead.integration.requested.v2',
			routingKey: 'manual.webhook',
			payload: {
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'webhook',
				source: 'widget',
				entity: { id: 'ci-manual-widget', name: 'CI manual retry' },
				lead: {
					id: randomUUID(),
					createdAt: new Date().toISOString()
				},
				destination: { credentialRef: randomUUID() }
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

	const paymentEmailEventId = randomUUID();
	const paymentTelegramEventId = randomUUID();
	createdEventIds.push(paymentEmailEventId, paymentTelegramEventId);
	const pendingPaymentQueues = new Set([
		'payment-email',
		'payment-telegram'
	]);
	const paymentConsumerTags = [];
	for (const [kind, queue] of [
		['payment-email', 'winwidget.payment-notification.email'],
		['payment-telegram', 'winwidget.payment-notification.telegram.v2']
	]) {
		const { consumerTag } = await channel.consume(
			queue,
			message => {
				if (!message) return;
				const expectedEventId =
					kind === 'payment-email'
						? paymentEmailEventId
						: paymentTelegramEventId;
				if (message.properties.messageId !== expectedEventId) {
					channel.nack(message, false, true);
					return;
				}
				try {
					const payload = JSON.parse(message.content.toString('utf8'));
					const expectedType =
						kind === 'payment-email'
							? 'payment.succeeded.v1'
							: 'payment.notification.telegram.requested.v1';
					if (
						payload?.schemaVersion !== 1 ||
						payload?.eventType !== expectedType ||
						payload?.payment?.id !== 'ci-payment' ||
						(kind === 'payment-telegram' &&
							(payload?.destination?.telegramChatId !==
								'ci-payment-chat' ||
								payload?.destination?.messageThreadId !== 17))
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
	const paymentSucceededAt = new Date().toISOString();
	await prisma.$transaction([
		prisma.outboxEvent.create({
			data: {
				id: paymentEmailEventId,
				messageId: paymentEmailEventId,
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
						succeededAt: paymentSucceededAt
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
		}),
		prisma.outboxEvent.create({
			data: {
				id: paymentTelegramEventId,
				messageId: paymentTelegramEventId,
				eventType: 'payment.notification.telegram.requested.v1',
				routingKey: 'payment.notification.telegram.requested.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'payment.notification.telegram.requested.v1',
					payment: {
						id: 'ci-payment',
						yookassaId: 'ci-yookassa',
						amount: '990.00',
						plan: 'EASY',
						billingPeriod: 'MONTHLY',
						succeededAt: paymentSucceededAt
					},
					user: {
						id: 'ci-user',
						name: 'CI',
						email: 'ci@example.com',
						phone: null
					},
					destination: {
						telegramChatId: 'ci-payment-chat',
						messageThreadId: 17
					}
				}
			}
		})
	]);
	await waitFor(
		() => pendingPaymentQueues.size === 0,
		'separate payment email and prepared Telegram events'
	);
	await waitFor(
		() =>
			prisma.outboxEvent
				.count({
					where: {
						id: { in: [paymentEmailEventId, paymentTelegramEventId] },
						status: 'PUBLISHED'
					}
				})
				.then(count => count === 2),
		'published prepared payment Outbox statuses'
	);
	for (const consumerTag of paymentConsumerTags) {
		await channel.cancel(consumerTag);
	}

	startProcess('dist/src/integration-worker-main.js', {
		INTEGRATION_WORKER_KINDS:
			'webhook,daily-summary-telegram,telegram-destination-unavailable,reporting-admin-audit',
		RABBITMQ_WORKER_PREFETCH: '1'
	});
	await waitFor(async () => {
		const queues = await Promise.all(
			[
				'winwidget.lead-integration.webhook.dead-letter',
				'winwidget.report.daily-summary.telegram',
				'winwidget.report.daily-summary.telegram.dead-letter',
				'winwidget.notification.telegram-destination-unavailable',
				'winwidget.notification.telegram-destination-unavailable.dead-letter',
				'winwidget.admin.audit.reporting.v1',
				'winwidget.admin.audit.reporting.v1.dead-letter'
			].map(queue => channel.checkQueue(queue))
		);
		return queues.every(queue => queue.consumerCount > 0);
	}, 'integration worker consumers');

	const destinationUnavailableEventId = randomUUID();
	createdEventIds.push(destinationUnavailableEventId);
	const destinationUnavailablePayload = {
		schemaVersion: 1,
		eventType: 'notification.telegram.destination-unavailable.v1',
		sourceEventId: randomUUID(),
		sourceKind: 'limit-telegram',
		destination: {
			telegramChatId: `ci-missing-chat-${destinationUnavailableEventId}`
		},
		normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
		occurredAt: new Date().toISOString()
	};
	channel.publish(
		'winwidget.events',
		'notification.telegram.destination-unavailable.v1',
		Buffer.from(JSON.stringify(destinationUnavailablePayload)),
		{
			persistent: true,
			messageId: destinationUnavailableEventId,
			type: 'notification.telegram.destination-unavailable.v1',
			contentType: 'application/json'
		}
	);
	await waitFor(
		() =>
			prisma.integrationDeliveryReceipt
				.findUnique({
					where: {
						eventId_integration: {
							eventId: destinationUnavailableEventId,
							integration: 'telegram-destination-unavailable'
						}
					},
					select: { status: true }
				})
				.then(receipt => receipt?.status === 'DELIVERED'),
		'destination-unavailable outcome delivery'
	);

	reportingAuditActorId = `ci-reporting-audit-${randomUUID()}`;
	await prisma.user.create({
		data: {
			id: reportingAuditActorId,
			password: 'not-a-real-password'
		}
	});
	const reportingAuditEventId = randomUUID();
	createdEventIds.push(reportingAuditEventId);
	const reportingAuditPayload = {
		schemaVersion: 1,
		eventType: 'admin.audit.event.v1',
		eventId: reportingAuditEventId,
		occurredAt: new Date().toISOString(),
		correlationId: `ci:reporting-audit:${reportingAuditEventId}`,
		actorId: reportingAuditActorId,
		action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
		target: { reportingSettingsId: 'daily-summary' },
		metadata: { changedFields: ['enabled', 'scheduleTime'] }
	};
	await prisma.outboxEvent.create({
		data: {
			id: reportingAuditEventId,
			messageId: reportingAuditEventId,
			eventType: 'admin.audit.event.v1',
			routingKey: 'admin.audit.reporting.v1',
			payload: reportingAuditPayload
		}
	});
	const reportingAuditLog = await waitFor(
		() =>
			prisma.adminEventLog.findFirst({
				where: {
					adminId: reportingAuditActorId,
					section: 'REPORTING',
					action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
					entityType: 'reporting-settings',
					entityId: 'daily-summary'
				}
			}),
		'Reporting settings ActivityLog delivery'
	);
	if (
		JSON.stringify(reportingAuditLog.metadata) !==
		JSON.stringify({ changedFields: ['enabled', 'scheduleTime'] })
	) {
		throw new Error('Reporting settings ActivityLog leaked values or PII');
	}
	await waitFor(
		() =>
			prisma.integrationDeliveryReceipt
				.findUnique({
					where: {
						eventId_integration: {
							eventId: reportingAuditEventId,
							integration: 'reporting-admin-audit'
						}
					},
					select: { status: true }
				})
				.then(receipt => receipt?.status === 'DELIVERED'),
		'Reporting settings audit receipt'
	);
	channel.publish(
		'winwidget.events',
		'admin.audit.reporting.v1',
		Buffer.from(JSON.stringify(reportingAuditPayload)),
		{
			persistent: true,
			messageId: reportingAuditEventId,
			type: 'admin.audit.event.v1',
			contentType: 'application/json'
		}
	);

	const malformedReportingAuditEventId = randomUUID();
	createdEventIds.push(malformedReportingAuditEventId);
	channel.publish(
		'winwidget.events',
		'admin.audit.reporting.v1',
		Buffer.from(
			JSON.stringify({
				...reportingAuditPayload,
				eventId: malformedReportingAuditEventId,
				metadata: {
					changedFields: ['enabled'],
					destinationChatId: '-100-not-allowed-in-audit'
				}
			})
		),
		{
			persistent: true,
			messageId: malformedReportingAuditEventId,
			type: 'admin.audit.event.v1',
			contentType: 'application/json'
		}
	);
	await waitFor(
		() =>
			prisma.integrationDeliveryFailure.findUnique({
				where: {
					eventId_integration: {
						eventId: malformedReportingAuditEventId,
						integration: 'reporting-admin-audit'
					}
				}
			}),
		'Reporting audit malformed event DLQ persistence'
	);
	const duplicateReportingAuditCount = await prisma.adminEventLog.count({
		where: {
			adminId: reportingAuditActorId,
			action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
			entityId: 'daily-summary'
		}
	});
	if (duplicateReportingAuditCount !== 1) {
		throw new Error(
			`Reporting audit duplicate was not idempotent: count=${duplicateReportingAuditCount}`
		);
	}

	// Keep the smoke independent from real time and Telegram schedule settings.
	const maintenanceScheduleSnapshot =
		await prisma.telegramBotSettings.findUnique({
			where: { id: 'singleton' },
			select: {
				dailySummaryEnabled: true,
				databaseBackupEnabled: true
			}
		});
	const suspendedMaintenanceSchedule =
		await prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {
				dailySummaryEnabled: false,
				databaseBackupEnabled: false
			},
			create: {
				id: 'singleton',
				dailySummaryEnabled: false,
				databaseBackupEnabled: false
			},
			select: { updatedAt: true }
		});
	maintenanceScheduleState = {
		snapshot: maintenanceScheduleSnapshot,
		updatedAt: suspendedMaintenanceSchedule.updatedAt
	};

	startProcess('dist/src/maintenance-worker-main.js', {
		MAINTENANCE_WORKER_KINDS: 'database-backup',
		MAINTENANCE_WORKER_PREFETCH: '1',
		SCHEDULED_JOB_POLL_INTERVAL_MS: '30000',
		SCHEDULED_JOB_LEASE_MS: '120000',
		SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS: '30000'
	});
	await waitFor(async () => {
		const queues = await Promise.all(
			[
				'winwidget.maintenance.database-backup',
				'winwidget.maintenance.database-backup.dead-letter'
			].map(queue => channel.checkQueue(queue))
		);
		return queues.every(queue => queue.consumerCount > 0);
	}, 'maintenance worker consumers');

	if (rabbitContainerId) {
		const durableEventId = randomUUID();
		createdEventIds.push(durableEventId);
		await prisma.outboxEvent.create({
			data: {
				id: durableEventId,
				eventType: 'lead.integration.requested.v2',
				routingKey: 'lead.integration.email.v2',
				payload: {
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'email',
					source: 'widget',
					entity: { id: 'ci-restart-widget', name: 'CI restart' },
					lead: {
						id: randomUUID(),
						createdAt: new Date().toISOString()
					},
					destination: { email: 'ci-restart@example.com' }
				}
			}
		});
		await waitFor(
			() =>
				prisma.outboxEvent
					.findUnique({
						where: { id: durableEventId },
						select: { status: true }
					})
					.then(event => event?.status === 'PUBLISHED'),
			'pre-restart durable Outbox publication'
		);
		await waitFor(
			() =>
				channel
					.checkQueue('winwidget.lead-integration.email')
					.then(queue => queue.messageCount > 0),
			'pre-restart durable RabbitMQ message'
		);

		await channel.close();
		channel = undefined;
		await connection.close();
		connection = undefined;
		await execFileAsync('docker', ['restart', rabbitContainerId], {
			timeout: 60_000
		});
		await waitFor(
			() =>
				getRabbitManagementStatus('/api/overview')
					.then(status => status >= 200 && status < 300)
					.catch(() => false),
			'RabbitMQ after container restart',
			60_000
		);
		connection = await amqp.connect(rabbitUrl);
		channel = await connection.createChannel();

		const durableMessage = await waitFor(
			() =>
				channel
					.get('winwidget.lead-integration.email', { noAck: false })
					.then(message =>
						message?.properties.messageId === durableEventId
							? message
							: false
					),
			'durable message after RabbitMQ restart'
		);
		channel.ack(durableMessage);

		await waitFor(
			async () => {
				const queues = await Promise.all(
					[
						'winwidget.lead-integration.webhook',
						'winwidget.lead-integration.webhook.dead-letter',
						'winwidget.report.daily-summary.telegram',
						'winwidget.report.daily-summary.telegram.dead-letter',
						'winwidget.notification.telegram-destination-unavailable',
						'winwidget.notification.telegram-destination-unavailable.dead-letter',
						'winwidget.admin.audit.reporting.v1',
						'winwidget.admin.audit.reporting.v1.dead-letter',
						'winwidget.maintenance.database-backup',
						'winwidget.maintenance.database-backup.dead-letter'
					].map(queue => channel.checkQueue(queue))
				);
				return queues.every(queue => queue.consumerCount > 0);
			},
			'worker consumers after RabbitMQ restart',
			60_000
		);

		const postRestartEventId = randomUUID();
		createdEventIds.push(postRestartEventId);
		await prisma.outboxEvent.create({
			data: {
				id: postRestartEventId,
				eventType: 'lead.integration.requested.v2',
				routingKey: 'lead.integration.email.v2',
				payload: {
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'email',
					source: 'widget',
					entity: {
						id: 'ci-reconnected-widget',
						name: 'CI reconnected'
					},
					lead: {
						id: randomUUID(),
						createdAt: new Date().toISOString()
					},
					destination: { email: 'ci-reconnected@example.com' }
				}
			}
		});
		await waitFor(
			() =>
				prisma.outboxEvent
					.findUnique({
						where: { id: postRestartEventId },
						select: { status: true }
					})
					.then(event => event?.status === 'PUBLISHED'),
			'Outbox publisher reconnect after RabbitMQ restart',
			60_000
		);
		const postRestartMessage = await waitFor(
			() =>
				channel
					.get('winwidget.lead-integration.email', { noAck: false })
					.then(message =>
						message?.properties.messageId === postRestartEventId
							? message
							: false
					),
			'post-restart RabbitMQ publication'
		);
		channel.ack(postRestartMessage);
	}

	const terminalDailySummaryJobId = randomUUID();
	const terminalDailySummaryPeriodEnd = new Date();
	const terminalDailySummaryPeriodStart = new Date(
		terminalDailySummaryPeriodEnd.getTime() - 24 * 60 * 60 * 1000
	);
	const terminalDailySummaryScheduleKey = `ci:${terminalDailySummaryJobId}`;
	createdEventIds.push(terminalDailySummaryJobId);
	createdScheduledJobIds.push(terminalDailySummaryJobId);
	await prisma.$transaction([
		prisma.scheduledJobRun.create({
			data: {
				id: terminalDailySummaryJobId,
				jobType: 'DAILY_TELEGRAM_SUMMARY',
				scheduleKey: terminalDailySummaryScheduleKey,
				trigger: 'SCHEDULED',
				status: 'SUCCEEDED',
				scheduledFor: terminalDailySummaryPeriodEnd,
				periodStart: terminalDailySummaryPeriodStart,
				periodEnd: terminalDailySummaryPeriodEnd,
				input: {
					chatId: 'ci-terminal-summary',
					messageThreadId: 1
				},
				result: {
					telegramSent: true,
					smoke: true
				},
				finishedAt: terminalDailySummaryPeriodEnd
			}
		}),
		prisma.outboxEvent.create({
			data: {
				id: terminalDailySummaryJobId,
				messageId: terminalDailySummaryJobId,
				eventType: 'report.daily-summary.requested.v1',
				routingKey: 'report.daily-summary.requested.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'report.daily-summary.requested.v1',
					jobId: terminalDailySummaryJobId,
					jobType: 'DAILY_TELEGRAM_SUMMARY',
					scheduleKey: terminalDailySummaryScheduleKey,
					periodStart: terminalDailySummaryPeriodStart.toISOString(),
					periodEnd: terminalDailySummaryPeriodEnd.toISOString()
				}
			}
		})
	]);
	await waitFor(
		() =>
			prisma.integrationDeliveryReceipt
				.findUnique({
					where: {
						eventId_integration: {
							eventId: terminalDailySummaryJobId,
							integration: 'daily-summary-telegram'
						}
					},
					select: { status: true }
				})
				.then(receipt => receipt?.status === 'DELIVERED'),
		'terminal daily summary delivery'
	);

	const terminalBackupJobId = randomUUID();
	const terminalBackupCreatedAt = new Date();
	const terminalBackupScheduleKey = `ci:${terminalBackupJobId}`;
	createdEventIds.push(terminalBackupJobId);
	createdScheduledJobIds.push(terminalBackupJobId);
	await prisma.$transaction([
		prisma.scheduledJobRun.create({
			data: {
				id: terminalBackupJobId,
				jobType: 'DATABASE_BACKUP',
				scheduleKey: terminalBackupScheduleKey,
				trigger: 'MANUAL',
				status: 'QUEUED',
				scheduledFor: terminalBackupCreatedAt,
				input: {
					chatId: 'ci-terminal-backup',
					messageThreadId: 1,
					trigger: 'MANUAL',
					periodStart: null
				},
				attempts: 4,
				maxAttempts: 4,
				lastError: 'CI terminal database backup'
			}
		}),
		prisma.outboxEvent.create({
			data: {
				id: terminalBackupJobId,
				messageId: terminalBackupJobId,
				eventType: 'database.backup.requested.v1',
				routingKey: 'database.backup.requested.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'database.backup.requested.v1',
					jobId: terminalBackupJobId,
					jobType: 'DATABASE_BACKUP',
					scheduleKey: terminalBackupScheduleKey,
					periodStart: null,
					periodEnd: null
				}
			}
		})
	]);
	await waitFor(
		() =>
			prisma.integrationDeliveryFailure
				.findUnique({
					where: {
						eventId_integration: {
							eventId: terminalBackupJobId,
							integration: 'database-backup'
						}
					},
					select: { lastError: true }
				})
				.then(failure =>
					failure?.lastError.includes('CI terminal database backup')
				),
		'terminal database backup dead-letter'
	);
	await waitFor(
		() =>
			prisma.outboxEvent
				.findUnique({
					where: {
						deduplicationKey: `scheduled-job:${terminalBackupJobId}:dead-letter:4`
					},
					select: {
						routingKey: true,
						status: true
					}
				})
				.then(
					event =>
						event?.routingKey === 'database-backup.dead-letter' &&
						event.status === 'PUBLISHED'
				),
		'published terminal database backup DLQ Outbox event'
	);

	const duplicateEventId = randomUUID();
	createdEventIds.push(duplicateEventId);
	const duplicatePayload = {
		schemaVersion: 2,
		eventType: 'lead.integration.requested.v2',
		integration: 'webhook',
		source: 'widget',
		entity: { id: 'ci-duplicate-widget', name: 'CI duplicate' },
		lead: {
			id: randomUUID(),
			createdAt: new Date().toISOString()
		},
		destination: { credentialRef: randomUUID() }
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
			routingKey: 'lead.integration.webhook.v2',
			payload: duplicatePayload,
			attempts: 4,
			lastError: 'CI duplicate guard'
		}
	});
	channel.publish(
		'winwidget.events',
		'lead.integration.webhook.v2',
		Buffer.from(JSON.stringify(duplicatePayload)),
		{
			persistent: true,
			messageId: duplicateEventId,
			type: 'lead.integration.requested.v2',
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
		'lead.integration.webhook.v2',
		Buffer.from(
			'{"schemaVersion":2,"eventType":"lead.integration.requested.v2","invalid":true}'
		),
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
		`Messaging integration smoke passed: manual backup advisory lock, ${smokeEventCount} lead events, mandatory return, manual retry routing, payment fan-out, Reporting audit Outbox -> idempotent ActivityLog and malformed -> isolated DLQ -> PostgreSQL, terminal scheduled jobs, malformed -> DLQ -> PostgreSQL${rabbitContainerId ? ', RabbitMQ restart durability and reconnect' : ''}\n`
	);
} finally {
	if (channel) await channel.close().catch(() => undefined);
	if (connection) await connection.close().catch(() => undefined);
	await stopChildren();
	if (maintenanceScheduleState) {
		const where = {
			id: 'singleton',
			updatedAt: maintenanceScheduleState.updatedAt,
			dailySummaryEnabled: false,
			databaseBackupEnabled: false
		};
		if (maintenanceScheduleState.snapshot) {
			await prisma.telegramBotSettings
				.updateMany({
					where,
					data: maintenanceScheduleState.snapshot
				})
				.catch(() => undefined);
		} else {
			await prisma.telegramBotSettings
				.deleteMany({ where })
				.catch(() => undefined);
		}
	}
	if (createdEventIds.length) {
		await prisma.integrationDeliveryFailure
			.deleteMany({ where: { eventId: { in: createdEventIds } } })
			.catch(() => undefined);
		await prisma.integrationDeliveryReceipt
			.deleteMany({ where: { eventId: { in: createdEventIds } } })
			.catch(() => undefined);
		await prisma.outboxEvent
			.deleteMany({
				where: {
					OR: [
						{ id: { in: createdEventIds } },
						{ messageId: { in: createdEventIds } }
					]
				}
			})
			.catch(() => undefined);
	}
	if (createdScheduledJobIds.length) {
		await prisma.scheduledJobRun
			.deleteMany({ where: { id: { in: createdScheduledJobIds } } })
			.catch(() => undefined);
	}
	if (reportingAuditActorId) {
		await prisma.adminEventLog
			.deleteMany({
				where: {
					adminId: reportingAuditActorId,
					action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE'
				}
			})
			.catch(() => undefined);
		await prisma.user
			.deleteMany({ where: { id: reportingAuditActorId } })
			.catch(() => undefined);
	}
	await prisma.$disconnect();
}
