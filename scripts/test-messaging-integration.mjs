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
	CORE_RABBITMQ_TOPOLOGY_KINDS,
	MESSAGING_QUEUE_NAMES
} = require('../dist/src/messaging/messaging.constants.js');
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
const publisherQueues = CORE_RABBITMQ_TOPOLOGY_KINDS.map(
	kind => MESSAGING_QUEUE_NAMES[kind]
);
const coreIntegrationWorkerKinds = 'reporting-admin-audit';
if (
	publisherQueues.some(queue => typeof queue !== 'string' || !queue) ||
	new Set(publisherQueues).size !== publisherQueues.length
) {
	throw new Error('Core publisher topology queue catalog is invalid');
}

const reportingEventTypes = ['identity.user.changed.v1'];

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
	await new ReportingProjectionSnapshotService().stream(request, response);
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
	if (
		entry.endsWith('integration-worker-main.js') &&
		extraEnv.INTEGRATION_WORKER_KINDS !== coreIntegrationWorkerKinds
	) {
		throw new Error(
			'Core integration worker smoke kind catalog is invalid'
		);
	}
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
	const emailValue = `projection-${suffix}@example.invalid`;
	const phoneValue = `+7000${suffix.replaceAll('-', '').slice(0, 10)}`;
	const aggregateIds = [disabledUserId, rollbackUserId, userId];
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
				'Retired Reporting projection snapshot was available'
			);
		} catch (error) {
			if (
				!error?.message?.includes(
					'Core Reporting projection snapshot was retired after Widgets ownership handoff'
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
				payload: { path: ['aggregateId'], equals: userId }
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
		const tombstone = cascadeEvents.find(
			event =>
				event.eventType === 'identity.user.changed.v1' &&
				event.payload.aggregateId === userId &&
				event.payload.tombstone === true &&
				event.payload.state === null
		);
		if (!tombstone) {
			throw new Error('Reporting identity cascade tombstone is missing');
		}

		const serializedPayloads = JSON.stringify(
			cascadeEvents.map(event => event.payload)
		);
		for (const forbiddenValue of [emailValue, phoneValue]) {
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
			publisherQueues.map(queue =>
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

	startProcess('dist/src/integration-worker-main.js', {
		INTEGRATION_WORKER_KINDS: coreIntegrationWorkerKinds,
		RABBITMQ_WORKER_PREFETCH: '1'
	});
	await waitFor(async () => {
		const queues = await Promise.all(
			[
				'winwidget.admin.audit.reporting.v1',
				'winwidget.admin.audit.reporting.v1.dead-letter'
			].map(queue => channel.checkQueue(queue))
		);
		return queues.every(queue => queue.consumerCount > 0);
	}, 'integration worker consumers');

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

	// Keep the smoke independent from the real database-backup schedule.
	const maintenanceScheduleSnapshot =
		await prisma.telegramBotSettings.findUnique({
			where: { id: 'singleton' },
			select: {
				databaseBackupEnabled: true
			}
		});
	const suspendedMaintenanceSchedule =
		await prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {
				databaseBackupEnabled: false
			},
			create: {
				id: 'singleton',
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
		const durabilityQueue = `winwidget.ci.core-outbox-restart.${durableEventId}`;
		await channel.assertQueue(durabilityQueue, { durable: true });
		await channel.bindQueue(
			durabilityQueue,
			'winwidget.events',
			'identity.user.changed.v1'
		);
		createdEventIds.push(durableEventId);
		await prisma.outboxEvent.create({
			data: {
				id: durableEventId,
				eventType: 'identity.user.changed.v1',
				routingKey: 'identity.user.changed.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'identity.user.changed.v1',
					eventId: durableEventId,
					aggregateId: `ci-restart-${durableEventId}`,
					aggregateVersion: '1',
					sourceSequence: '1',
					occurredAt: new Date().toISOString(),
					tombstone: true,
					state: null
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
					.checkQueue(durabilityQueue)
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
					.get(durabilityQueue, { noAck: false })
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
				eventType: 'identity.user.changed.v1',
				routingKey: 'identity.user.changed.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'identity.user.changed.v1',
					eventId: postRestartEventId,
					aggregateId: `ci-reconnected-${postRestartEventId}`,
					aggregateVersion: '1',
					sourceSequence: '1',
					occurredAt: new Date().toISOString(),
					tombstone: true,
					state: null
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
					.get(durabilityQueue, { noAck: false })
					.then(message =>
						message?.properties.messageId === postRestartEventId
							? message
							: false
					),
			'post-restart RabbitMQ publication'
		);
		channel.ack(postRestartMessage);
		await channel.deleteQueue(durabilityQueue);
	}

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

	process.stdout.write(
		`Messaging integration smoke passed: retired Reporting snapshot, retained identity producer, manual backup advisory lock, Reporting audit Outbox -> idempotent ActivityLog and malformed -> isolated DLQ -> PostgreSQL, terminal database-backup retry/DLQ${rabbitContainerId ? ', RabbitMQ restart durability and reconnect' : ''}\n`
	);
} finally {
	if (channel) await channel.close().catch(() => undefined);
	if (connection) await connection.close().catch(() => undefined);
	await stopChildren();
	if (maintenanceScheduleState) {
		const where = {
			id: 'singleton',
			updatedAt: maintenanceScheduleState.updatedAt,
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
