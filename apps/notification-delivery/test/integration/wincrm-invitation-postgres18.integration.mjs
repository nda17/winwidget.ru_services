import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.env.NOTIFICATION_INVITATION_TEST_ALLOW_MUTATION !== 'true')
	throw new Error(
		'Explicit local invitation test mutation opt-in is required'
	);
const runtimeUrl = required('NOTIFICATION_INVITATION_TEST_DATABASE_URL');
const expectedRole = required('NOTIFICATION_INVITATION_TEST_RUNTIME_ROLE');
let parsed;
try {
	parsed = new URL(runtimeUrl);
} catch {
	throw new Error('Invalid local invitation test database configuration');
}
assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
assert.match(
	parsed.pathname,
	/^\/winwidget_notification_invitation_(?:test|ci)(?:_[a-z0-9]+)?$/
);
assert.equal(parsed.searchParams.get('schema'), 'notification_delivery');
assert.ok([...parsed.searchParams.keys()].every(key => key === 'schema'));
assert.equal(parsed.hash, '');
assert.equal(parsed.username, expectedRole);
assert.match(expectedRole, /^[a-z_][a-z0-9_]{0,62}$/);
assert.ok(expectedRole.endsWith('_ci') || expectedRole.endsWith('_test'));

const { PrismaClient } =
	await import('@prisma/notification-delivery-client');
const { NotificationDeliveryReceiptService } =
	await import('../../dist/src/notification-delivery/notification-delivery-receipt.service.js');
const { NotificationDeliveryMessageMetadataService } =
	await import('../../dist/src/notification-delivery/notification-delivery-message-metadata.service.js');
const { NotificationDeliveryOutcomeService } =
	await import('../../dist/src/notification-delivery/notification-delivery-outcome.service.js');
const { NotificationDeliveryFailureService } =
	await import('../../dist/src/notification-delivery/notification-delivery-failure.service.js');
const { NotificationDeliveryAdapterService } =
	await import('../../dist/src/notification-delivery/notification-delivery-adapter.service.js');
const { NotificationDeliveryWorkerService } =
	await import('../../dist/src/notification-delivery/notification-delivery-worker.service.js');
const { NotificationDeliveryControlService } =
	await import('../../dist/src/notification-delivery/control/notification-delivery-control.service.js');
const { EmailService } =
	await import('../../dist/src/email/email.service.js');
const { Logger } = await import('@nestjs/common');
Logger.overrideLogger(false);
const runtime = new PrismaClient({
	datasources: { db: { url: runtimeUrl } }
});
const kind = 'wincrm-invitation-email';
const eventType = 'notification.wincrm.invitation.email.requested.v1';
const eventIds = [];
let sends = 0;
let eligibility = true;
let failure = null;
let acks = 0;
let nacks = 0;
const metadata = new NotificationDeliveryMessageMetadataService();
const outcomes = new NotificationDeliveryOutcomeService();
const receipts = new NotificationDeliveryReceiptService(
	runtime,
	metadata,
	outcomes
);
const failures = new NotificationDeliveryFailureService(
	runtime,
	receipts,
	outcomes,
	metadata
);
const adapter = new NotificationDeliveryAdapterService(
	new EmailService({
		sendMail: async mail => {
			assert.equal(mail.subject, 'Приглашение в WinCRM');
			assert.ok(
				mail.messageId.endsWith('.wincrm-invitation@winwidget.ru>')
			);
			if (failure) throw failure;
			sends++;
		}
	}),
	{},
	runtime,
	{
		canDeliver: async () => {
			if (eligibility instanceof Error) throw eligibility;
			return eligibility;
		}
	}
);
const worker = new NotificationDeliveryWorkerService(
	{ ack: () => acks++, nack: () => nacks++ },
	adapter,
	{ get: () => undefined },
	{ markSuccessfulConsume: () => undefined },
	receipts,
	failures
);
const control = new NotificationDeliveryControlService(runtime);
try {
	const [role] =
		await runtime.$queryRawUnsafe(`SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
		NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AS restricted,
		has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
		has_schema_privilege(current_user,'notification_delivery','CREATE') AS schema_create,
		has_schema_privilege(current_user,'foreign_service_guard','USAGE') AS foreign_usage
		FROM pg_roles WHERE rolname=current_user`);
	assert.equal(role.name, expectedRole);
	assert.equal(Math.floor(role.version / 10000), 18);
	assert.equal(role.restricted, true);
	assert.equal(role.database_create, false);
	assert.equal(role.schema_create, false);
	assert.equal(role.foreign_usage, false);
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT * FROM foreign_service_guard.sentinel'
		),
		sqlState('42501')
	);
	await assert.rejects(
		runtime.$queryRawUnsafe(
			'SELECT migration_name FROM notification_delivery._prisma_migrations LIMIT 0'
		),
		sqlState('42501')
	);

	const expired = event(-60_000);
	await worker.handle(kind, message(expired));
	let row = await receipt(expired);
	assert.equal(row.status, 'CLOSED_NO_RETRY');
	assert.equal(row.deliveredAt, null);
	assert.equal(row.checkpoint.outcome, 'SKIPPED');
	assert.equal(row.checkpoint.reason, 'INVITATION_EXPIRED');
	assert.equal(sends, 0);
	await worker.handle(kind, message(expired));
	assert.equal(sends, 0);

	const delivered = event();
	await Promise.all([
		worker.handle(kind, message(delivered)),
		worker.handle(kind, message(delivered))
	]);
	assert.equal((await receipt(delivered)).status, 'DELIVERED');
	assert.equal(sends, 1);
	await worker.handle(kind, message(delivered));
	assert.equal(sends, 1);

	const unavailable = event();
	eligibility = new Error('Context unavailable');
	await worker.handle(kind, message(unavailable));
	row = await receipt(unavailable);
	assert.equal(row.status, 'RETRY_SCHEDULED');
	let outbox =
		await runtime.notificationDeliveryOutboxEvent.findFirstOrThrow({
			where: { messageId: unavailable.eventId },
			orderBy: { createdAt: 'desc' }
		});
	assert.equal(outbox.routingKey, 'manual.wincrm-invitation-email');
	// Explicit test fixture makes only this known isolated retry due, without waiting or publishing.
	await runtime.notificationDeliveryReceipt.update({
		where: { id: row.id },
		data: { retryAvailableAt: new Date(Date.now() - 1000) }
	});
	eligibility = false;
	await worker.handle(
		kind,
		message(unavailable, outbox.routingKey, outbox.headers)
	);
	row = await receipt(unavailable);
	assert.equal(row.status, 'CLOSED_NO_RETRY');
	const closed =
		await runtime.notificationDeliveryFailure.findUniqueOrThrow({
			where: {
				eventId_consumer: { eventId: unavailable.eventId, consumer: kind }
			}
		});
	assert.equal(closed.resolution, 'CLOSED_NO_RETRY');
	assert.equal(closed.resolvedById, 'service:notification-delivery');
	assert.equal(row.checkpoint.reason, 'INVITATION_UNAVAILABLE');
	assert.equal(sends, 1);
	await assert.rejects(
		control.retryFailure(closed.id, 'qa-admin'),
		error => error.getStatus?.() === 409
	);

	const dead = event();
	eligibility = true;
	failure = Object.assign(new Error('Rejected by fake SMTP'), {
		code: 'EENVELOPE',
		responseCode: 550
	});
	await worker.handle(kind, message(dead));
	assert.equal((await receipt(dead)).status, 'DEAD_LETTERED');
	outbox = await runtime.notificationDeliveryOutboxEvent.findFirstOrThrow({
		where: { messageId: dead.eventId }
	});
	assert.equal(outbox.routingKey, 'wincrm-invitation-email.dead-letter');
	const retainedFailure =
		await runtime.notificationDeliveryFailure.findUniqueOrThrow({
			where: {
				eventId_consumer: { eventId: dead.eventId, consumer: kind }
			}
		});
	await control.retryFailure(retainedFailure.id, 'qa-admin');
	assert.equal(
		await runtime.notificationDeliveryControlAction.count({
			where: { eventId: dead.eventId, kind, action: 'RETRY' }
		}),
		1
	);
	outbox = await runtime.notificationDeliveryOutboxEvent.findFirstOrThrow({
		where: {
			messageId: dead.eventId,
			routingKey: 'manual.wincrm-invitation-email'
		}
	});
	failure = null;
	await worker.handle(
		kind,
		message(dead, outbox.routingKey, outbox.headers)
	);
	assert.equal((await receipt(dead)).status, 'DELIVERED');
	assert.equal(sends, 2);
	assert.equal(
		(
			await runtime.notificationDeliveryFailure.findUniqueOrThrow({
				where: { id: retainedFailure.id }
			})
		).resolution,
		'DELIVERED'
	);

	const cas = event();
	const claim = await receipts.claimDelivery(cas.eventId, kind, 0, null);
	assert.equal(claim.state, 'claimed');
	await assert.rejects(
		receipts.markSkipped(
			cas.eventId,
			kind,
			randomUUID(),
			'INVITATION_EXPIRED'
		),
		/claim was lost/
	);
	assert.equal((await receipt(cas)).status, 'PROCESSING');
	await receipts.markSkipped(
		cas.eventId,
		kind,
		claim.lockToken,
		'INVITATION_EXPIRED'
	);
	assert.equal(
		(await receipts.claimDelivery(cas.eventId, kind, 0, null)).state,
		'closed'
	);

	await assert.rejects(
		runtime.notificationDeliveryReceipt.create({
			data: {
				eventId: randomUUID(),
				consumer: 'foreign-consumer',
				status: 'DEAD_LETTERED'
			}
		})
	);
	await assert.rejects(
		runtime.notificationDeliveryOutboxEvent.create({
			data: {
				messageId: randomUUID(),
				exchange: 'EVENTS',
				eventType: 'payment.succeeded.v1',
				routingKey: 'manual.wincrm-invitation-email',
				payload: {},
				headers: {}
			}
		})
	);
	assert.equal(
		await runtime.notificationDeliveryOutboxEvent.count({
			where: {
				messageId: { in: eventIds },
				routingKey: { contains: 'outcome' }
			}
		}),
		0
	);
	assert.equal(nacks, 0);
	assert.ok(acks >= 8);
	console.log(
		'WinCRM invitation PostgreSQL 18 integration: PASS (restricted roles, CHECKs, CAS/lease, concurrent dedup, skip, retry/DLQ/control, no outcome; fake SMTP only)'
	);
} finally {
	// Only records created by this run are touched. Parent owns the disposable DB/container lifecycle.
	try {
		await runtime.notificationDeliveryControlAction.deleteMany({
			where: { eventId: { in: eventIds } }
		});
		await runtime.notificationDeliveryOutboxEvent.deleteMany({
			where: { messageId: { in: eventIds } }
		});
		await runtime.notificationDeliveryFailure.deleteMany({
			where: { eventId: { in: eventIds } }
		});
		await runtime.notificationDeliveryReceipt.deleteMany({
			where: { eventId: { in: eventIds } }
		});
	} finally {
		await runtime.$disconnect();
	}
}

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
function sqlState(code) {
	return error => error?.meta?.code === code || error?.code === code;
}
function event(expiresIn = 60 * 60 * 1000) {
	const eventId = randomUUID();
	eventIds.push(eventId);
	const invitationId = randomUUID();
	return {
		schemaVersion: 1,
		eventId,
		eventType,
		occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		reference: {
			type: 'wincrm-invitation',
			id: invitationId,
			workspaceId: randomUUID()
		},
		destination: { email: 'invited@example.test' },
		content: {
			invitationId,
			expiresAt: new Date(Date.now() + expiresIn).toISOString()
		}
	};
}
function message(payload, routingKey = eventType, headers = {}) {
	return {
		content: Buffer.from(JSON.stringify(payload)),
		fields: { routingKey, exchange: 'winwidget.events' },
		properties: { messageId: payload.eventId, type: eventType, headers }
	};
}
function receipt(payload) {
	return runtime.notificationDeliveryReceipt.findUniqueOrThrow({
		where: {
			eventId_consumer: { eventId: payload.eventId, consumer: kind }
		}
	});
}
