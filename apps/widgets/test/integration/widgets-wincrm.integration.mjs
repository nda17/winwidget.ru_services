import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/widgets-client';
import serviceModule from '../../dist/src/wincrm/widgets-wincrm.service.js';
import repositoryModule from '../../dist/src/domain/widgets-domain.repository.js';
import quotaModule from '../../dist/src/quota/widgets-quota.service.js';
import contractModule from '../../dist/src/messaging/widgets-outbox-contract.js';

const databaseUrl = process.env.WIDGETS_TEST_DATABASE_URL;
if (!databaseUrl) {
	console.log(
		'SKIP Widgets WinCRM PostgreSQL proof: WIDGETS_TEST_DATABASE_URL not set'
	);
	process.exit(0);
}
const url = new URL(databaseUrl);
if (
	process.env.WIDGETS_INTEGRATION_ALLOW_MUTATION !== 'true' ||
	url.protocol !== 'postgresql:' ||
	!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
	!/^winwidget_widgets_(test_[a-z0-9_]+_test|ci)$/.test(
		url.pathname.slice(1)
	)
)
	throw new Error(
		'WinCRM proof requires an explicitly authorized isolated local Widgets test database'
	);
const { WidgetsWincrmService } = serviceModule;
const { WidgetsDomainRepository } = repositoryModule;
const { WidgetsQuotaService } = quotaModule;
const { assertWidgetsOutboxContract } = contractModule;
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } },
	log: []
});
const owner = `proof-${randomUUID()}`;
const widgetId = `cm${randomUUID().replaceAll('-', '')}`;
const periodStart = new Date(Date.now() - 60_000);
const periodEnd = new Date(Date.now() + 86_400_000);
const subscriptionId = `cm${randomUUID().replaceAll('-', '')}`;
const command = {
	schemaVersion: 1,
	commandId: randomUUID(),
	workspaceId: randomUUID(),
	sourceId: randomUUID(),
	ownerSubject: owner,
	widgetType: 'WHEEL',
	widgetId,
	controlVersion: 1,
	generation: 1,
	enabled: true
};
let billingCalls = 0;
let phase = 'runtime role and table ACL';
const billing = {
	eligibility: async () => {
		billingCalls++;
		const now = new Date();
		return {
			schemaVersion: 1,
			ownerSubject: owner,
			eligible: true,
			reason: 'ELIGIBLE',
			subscriptionId,
			version: '1',
			plan: 'EASY',
			startsAt: periodStart.toISOString(),
			expiresAt: periodEnd.toISOString(),
			checkedAt: now.toISOString(),
			validUntil: new Date(now.getTime() + 5000).toISOString()
		};
	}
};
const repository = new WidgetsDomainRepository(prisma);
const service = new WidgetsWincrmService(
	prisma,
	repository,
	{ enabled: true, apiEnabled: true },
	billing
);
const quota = new WidgetsQuotaService(prisma, { get: () => '86400000' });
const assertDenied = async operation => {
	let rejected = false;
	try {
		await operation();
	} catch {
		rejected = true;
	}
	assert.ok(rejected, 'Expected database or domain rejection');
};

try {
	await prisma.$connect();
	assert.equal(
		await prisma.wincrmConnector.count(),
		0,
		'Use a fresh disposable database'
	);
	const [role] =
		await prisma.$queryRaw`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication, rolinherit FROM pg_roles WHERE rolname=current_user`;
	assert.ok(
		role &&
			!role.rolsuper &&
			!role.rolcreatedb &&
			!role.rolcreaterole &&
			!role.rolbypassrls &&
			!role.rolreplication &&
			!role.rolinherit,
		'Restricted runtime role required'
	);
	for (const table of [
		'wincrm_connectors',
		'wincrm_connector_commands',
		'wincrm_transfer_intents'
	]) {
		const [acl] =
			await prisma.$queryRaw`SELECT has_table_privilege(current_user, ${`widgets.${table}`}, 'SELECT') AS can_read, has_table_privilege(current_user, ${`widgets.${table}`}, 'INSERT') AS can_insert, has_table_privilege(current_user, ${`widgets.${table}`}, 'UPDATE') AS can_update, has_table_privilege(current_user, ${`widgets.${table}`}, 'DELETE') AS can_delete, has_table_privilege(current_user, ${`widgets.${table}`}, 'TRUNCATE') AS can_truncate`;
		assert.ok(
			acl.can_read &&
				acl.can_insert &&
				!acl.can_delete &&
				!acl.can_truncate
		);
		assert.equal(acl.can_update, table === 'wincrm_connectors');
	}
	await prisma.widgetOwnerProjection.create({
		data: {
			userId: owner,
			status: 'ACTIVE',
			aggregateVersion: 1n,
			sourceSequence: 1n,
			sourceOccurredAt: new Date()
		}
	});
	await prisma.widgetEntitlementProjection.create({
		data: {
			id: subscriptionId,
			userId: owner,
			plan: 'EASY',
			status: 'ACTIVE',
			startsAt: periodStart,
			expiresAt: periodEnd,
			periodResetsAt: periodEnd,
			maxWidgets: 100,
			maxLeadsPerPeriod: 100,
			unlimited: false,
			aggregateVersion: 1n,
			sourceSequence: 1n,
			sourceOccurredAt: new Date(),
			sourceCreatedAt: periodStart,
			sourceUpdatedAt: periodStart
		}
	});
	await prisma.widgetUsageCounter.create({
		data: {
			userId: owner,
			widgetCount: 1,
			leadCount: 0,
			entitlementVersion: 1n,
			leadPeriodKey: periodEnd.toISOString(),
			leadPeriodStartsAt: periodStart,
			leadPeriodEndsAt: periodEnd
		}
	});
	const widget = await prisma.widget.create({
		data: {
			id: widgetId,
			userId: owner,
			publicKey: randomUUID().replaceAll('-', ''),
			name: 'Native connector proof',
			config: {},
			publishedVersion: 1,
			publishedAt: new Date()
		}
	});
	const connectorId = randomUUID();
	phase = 'configure replay and ownership';
	const responses = await Promise.all(
		Array.from({ length: 4 }, () =>
			service.configure(connectorId, command)
		)
	);
	for (const response of responses)
		assert.deepEqual(response, responses[0]);
	assert.equal(await prisma.wincrmConnectorCommand.count(), 1);
	await assertDenied(() =>
		service.configure(connectorId, { ...command, enabled: false })
	);
	await assertDenied(() =>
		service.configure(connectorId, {
			...command,
			commandId: randomUUID(),
			workspaceId: randomUUID(),
			controlVersion: 2
		})
	);
	await assertDenied(() =>
		service.configure(randomUUID(), {
			...command,
			commandId: randomUUID(),
			sourceId: randomUUID()
		})
	);
	phase = 'server-paged candidates';
	const page = await service.candidates(owner, 1, 1);
	assert.equal(page.total, 1);
	assert.equal(page.items.length, 1);
	assert.equal(page.items[0].connector.id, connectorId);
	assert.equal(
		(await service.candidates('foreign-owner', 1, 1)).items.length,
		0
	);
	const createLead = async (contactName = null, rollback = false) =>
		quota.withLeadCreation(
			owner,
			{ idempotencyKey: randomUUID() },
			async (tx, projection) => {
				const lead = await repository.createLead(
					'WHEEL',
					widgetId,
					{ contact: '+79990000000', phone: '+79990000000', bonus: '10%' },
					tx
				);
				await service.capture(tx, {
					type: 'WHEEL',
					widget,
					lead,
					config: {},
					contactName,
					entitlement: projection
				});
				if (rollback) throw new Error('Injected post-Outbox rollback');
				return {
					value: lead,
					aggregateType: 'wheel-lead',
					aggregateId: lead.id
				};
			}
		);
	const callsBefore = billingCalls;
	phase = 'atomic lead capture';
	const created = await createLead();
	assert.equal(
		billingCalls,
		callsBefore,
		'Lead transaction must not call Billing'
	);
	const transfer = await prisma.wincrmTransferIntent.findFirstOrThrow({
		where: { leadId: created.value.id }
	});
	assert.equal(transfer.originalSubscriptionId, subscriptionId);
	assert.equal(transfer.state, 'READY');
	const outbox = await prisma.widgetsOutboxEvent.findFirstOrThrow({
		where: { messageId: transfer.eventId }
	});
	assertWidgetsOutboxContract(outbox);
	const {
		id: omittedId,
		eventId: omittedEvent,
		createdAt: omittedCreatedAt,
		...evidence
	} = transfer;
	for (const patch of [
		{ ownerSubject: 'foreign-owner' },
		{ widgetId: 'foreign-widget' },
		{ widgetType: 'QUIZ' },
		{ sourceId: randomUUID() }
	])
		await assertDenied(() =>
			prisma.wincrmTransferIntent.create({
				data: {
					...evidence,
					...patch,
					id: randomUUID(),
					eventId: randomUUID(),
					leadId: `probe-${randomUUID()}`
				}
			})
		);
	const storedCommand =
		await prisma.wincrmConnectorCommand.findUniqueOrThrow({
			where: { commandId: command.commandId }
		});
	await assertDenied(() =>
		prisma.wincrmConnectorCommand.create({
			data: {
				...storedCommand,
				commandId: randomUUID(),
				ownerSubject: 'foreign-owner'
			}
		})
	);
	assert.ok(!JSON.stringify(outbox.payload).includes('+79990000000'));
	const binding = {
		eventId: transfer.eventId,
		connectorId,
		workspaceId: command.workspaceId,
		sourceId: command.sourceId,
		generation: 1
	};
	phase = 'fresh transfer context';
	assert.equal(
		(await service.context(transfer.id, binding)).deliver,
		true
	);
	await assertDenied(() =>
		service.context(transfer.id, { ...binding, workspaceId: randomUUID() })
	);
	const skipped = await createLead('<b>unsupported</b>');
	assert.equal(
		(
			await prisma.wincrmTransferIntent.findFirstOrThrow({
				where: { leadId: skipped.value.id }
			})
		).reason,
		'TEXT_UNSUPPORTED'
	);
	const before = [
		await prisma.lead.count(),
		await prisma.wincrmTransferIntent.count(),
		await prisma.widgetsOutboxEvent.count(),
		(
			await prisma.widgetUsageCounter.findUniqueOrThrow({
				where: { userId: owner }
			})
		).leadCount
	];
	await assertDenied(() => createLead(null, true));
	assert.deepEqual(
		[
			await prisma.lead.count(),
			await prisma.wincrmTransferIntent.count(),
			await prisma.widgetsOutboxEvent.count(),
			(
				await prisma.widgetUsageCounter.findUniqueOrThrow({
					where: { userId: owner }
				})
			).leadCount
		],
		before
	);
	await service.configure(connectorId, {
		...command,
		commandId: randomUUID(),
		controlVersion: 2,
		enabled: false
	});
	phase = 'disable and generation fences';
	assert.equal(
		(await service.context(transfer.id, binding)).reason,
		'CONNECTOR_DISABLED'
	);
	assert.deepEqual(
		await service.configure(connectorId, command),
		responses[0]
	);
	await assertDenied(() =>
		service.configure(connectorId, { ...command, commandId: randomUUID() })
	);
	await assertDenied(() =>
		service.configure(connectorId, {
			...command,
			commandId: randomUUID(),
			controlVersion: 3
		})
	);
	await service.configure(connectorId, {
		...command,
		commandId: randomUUID(),
		controlVersion: 3,
		generation: 2
	});
	assert.equal(
		(await service.context(transfer.id, binding)).reason,
		'GENERATION_CHANGED'
	);
	phase = 'bounded widget lock contention';
	let releaseLock;
	let signalLocked;
	const release = new Promise(resolve => {
		releaseLock = resolve;
	});
	const locked = new Promise(resolve => {
		signalLocked = resolve;
	});
	const blocker = prisma.$transaction(
		async tx => {
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`widgets:wincrm-widget:WHEEL:${widgetId}`}, 0))::text`;
			signalLocked();
			await release;
		},
		{ timeout: 8000, maxWait: 1000 }
	);
	await Promise.race([
		locked,
		blocker.then(() => {
			throw new Error('Expected held widget lock');
		})
	]);
	try {
		const started = Date.now();
		let lockFailure;
		try {
			await service.configure(connectorId, {
				...command,
				commandId: randomUUID(),
				controlVersion: 4,
				generation: 2
			});
		} catch (error) {
			lockFailure = error;
		}
		assert.equal(lockFailure?.code, 'P2010');
		assert.equal(lockFailure?.meta?.code, '55P03');
		assert.ok(
			Date.now() - started < 5000,
			'Native lock wait must be SQL-bounded'
		);
	} finally {
		releaseLock();
		await blocker;
	}
	await assertDenied(() =>
		prisma.wincrmConnector.update({
			where: { id: connectorId },
			data: { controlVersion: 4, ownerSubject: 'other-owner' }
		})
	);
	phase = 'runtime immutable evidence';
	await assertDenied(() =>
		prisma.wincrmConnector.update({
			where: { id: connectorId },
			data: { controlVersion: 2 }
		})
	);
	await assertDenied(() =>
		prisma.wincrmConnectorCommand.updateMany({
			data: { caller: 'crm-intake' }
		})
	);
	await assertDenied(() =>
		prisma.wincrmTransferIntent.updateMany({ data: { state: 'SKIPPED' } })
	);
	await assertDenied(() => prisma.wincrmConnector.deleteMany());
	await assertDenied(
		() =>
			prisma.$executeRaw`TRUNCATE TABLE widgets.wincrm_transfer_intents`
	);
	const lateBilling = {
		eligibility: async () => {
			const value = await billing.eligibility();
			return {
				...value,
				startsAt: new Date(Date.now() + 1000).toISOString()
			};
		}
	};
	phase = 'original period expiry';
	const lateService = new WidgetsWincrmService(
		prisma,
		repository,
		{ enabled: true, apiEnabled: true },
		lateBilling
	);
	const freshLead = await createLead();
	const freshTransfer = await prisma.wincrmTransferIntent.findFirstOrThrow(
		{ where: { leadId: freshLead.value.id } }
	);
	const freshBinding = {
		...binding,
		eventId: freshTransfer.eventId,
		generation: 2
	};
	assert.equal(
		(await lateService.context(freshTransfer.id, freshBinding)).reason,
		'BILLING_PERIOD_CHANGED'
	);
	const originalNow = Date.now;
	try {
		Date.now = () => periodEnd.getTime();
		assert.equal(
			(await service.context(freshTransfer.id, freshBinding)).reason,
			'PERIOD_EXPIRED'
		);
	} finally {
		Date.now = originalNow;
	}
	console.log(
		'Widgets WinCRM PostgreSQL proof GREEN: runtime ACL, replay/CAS, scope, generation, snapshots, atomic lead/usage/intent/Outbox rollback. Disposable test rows retained for owner cleanup.'
	);
} catch (error) {
	console.error(
		`Widgets WinCRM PostgreSQL proof FAILED at ${phase} (${error?.constructor?.name || 'Error'}${typeof error?.code === 'string' && /^[A-Z0-9]{3,8}$/.test(error.code) ? `/${error.code}` : ''}${typeof error?.meta?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.meta.code) ? `/${error.meta.code}` : ''}): ${error?.name === 'AssertionError' ? 'assertion failed' : 'check failed; no private diagnostics emitted'}`
	);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
