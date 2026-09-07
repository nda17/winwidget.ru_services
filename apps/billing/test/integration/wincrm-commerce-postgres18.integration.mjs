import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Own isolated PostgreSQL only. No broker or provider HTTP is contacted here.
// Provider results below are synthetic test data passed to the real domain service.
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/billing-client');
const {
	WincrmCommerceService
} = require('../../dist/src/domain/wincrm-commerce.service.js');
const {
	CrmEntitlementService
} = require('../../dist/src/domain/crm-entitlement.service.js');
const {
	CrmAdminSubscriptionService
} = require('../../dist/src/domain/crm-admin-subscription.service.js');
const {
	PaymentMethodCryptoService
} = require('../../dist/src/provider/payment-method-crypto.service.js');
const {
	wincrmCommerceRequestHash,
	WINCRM_CONSENT_VERSION
} = require('../../dist/src/domain/wincrm-commerce.helpers.js');
let phase = 'configuration';
let prisma;
const OriginalDate = globalThis.Date;
const oldFlag = process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
const oldKey = process.env.PAYMENT_METHOD_ENCRYPTION_KEY;
const oldOrigin = process.env.BILLING_WINCRM_FRONTEND_ORIGIN;
try {
	assert.equal(
		process.env.BILLING_WINCRM_COMMERCE_TEST_ALLOW_MUTATION,
		'true'
	);
	const raw = process.env.BILLING_WINCRM_COMMERCE_TEST_DATABASE_URL;
	const role = process.env.BILLING_WINCRM_COMMERCE_TEST_RUNTIME_ROLE;
	assert.ok(typeof raw === 'string' && typeof role === 'string');
	assert.match(role, /^[a-z][a-z0-9_]{0,62}$/);
	const url = new URL(raw);
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
	assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
	assert.match(
		url.pathname,
		/^\/winwidget_billing_[a-z0-9_]+_(?:test|ci)$/
	);
	assert.equal(decodeURIComponent(url.username), role);
	assert.equal(url.hash, '');
	assert.deepEqual(url.searchParams.getAll('schema'), ['billing']);
	assert.ok(
		[...url.searchParams.keys()].every(
			key => key === 'schema' || key === 'sslmode'
		)
	);
	assert.ok(url.searchParams.getAll('sslmode').length <= 1);
	assert.ok(
		!url.searchParams.has('sslmode') ||
			url.searchParams.get('sslmode') === 'disable'
	);
	process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
	process.env.PAYMENT_METHOD_ENCRYPTION_KEY =
		randomBytes(32).toString('base64');
	process.env.BILLING_WINCRM_FRONTEND_ORIGIN = 'https://crm.example.test';
	prisma = new PrismaClient({ datasources: { db: { url: raw } } });
	const service = new WincrmCommerceService(
		prisma,
		new PaymentMethodCryptoService()
	);
	const entitlements = new CrmEntitlementService(prisma);
	phase = 'role-and-isolation';
	const [identity] =
		await prisma.$queryRaw`SELECT current_user AS name, current_setting('server_version_num')::integer AS version,
		NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit AND NOT rolreplication AND rolcanlogin AS restricted,
		pg_get_userbyid(nspowner) <> current_user AS not_owner,
		NOT has_database_privilege(current_user, current_database(), 'CREATE') AS no_database_create,
		NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS no_foreign_schema,
		NOT has_function_privilege(current_user, 'billing.protect_wincrm_commerce_evidence()', 'EXECUTE') AS no_routine_execute
		FROM pg_roles JOIN pg_namespace ON nspname='billing' WHERE rolname=current_user`;
	assert.equal(identity.name, role);
	for (const key of [
		'restricted',
		'not_owner',
		'no_database_create',
		'no_foreign_schema',
		'no_routine_execute'
	])
		assert.equal(identity[key], true, key);
	assert.ok(identity.version >= 180000 && identity.version < 190000);
	for (const table of [
		'crm_commerce_accounts',
		'crm_commerce_commands',
		'crm_orders',
		'crm_paid_periods',
		'crm_auto_renewals',
		'crm_auto_renewal_consents',
		'crm_provider_operations',
		'crm_provider_deliveries',
		'crm_payment_receipts'
	]) {
		for (const privilege of ['DELETE', 'TRUNCATE']) {
			const [row] = await prisma.$queryRawUnsafe(
				'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
				`billing.${table}`,
				privilege
			);
			assert.equal(row.allowed, false, `${table}:${privilege}`);
		}
	}
	const [consentAcl] =
		await prisma.$queryRaw`SELECT has_table_privilege(current_user, 'billing.crm_auto_renewal_consents','UPDATE') AS allowed`;
	assert.equal(consentAcl.allowed, false);
	// The production-named CI role starts with the same broad table defaults.
	// Migrations must restrict CRM evidence without modifying Widgets payments.
	if (role === 'winwidget_billing_runtime') {
		const [widgetsAcl] =
			await prisma.$queryRaw`SELECT has_table_privilege(current_user, 'billing.payments', 'DELETE') AS allowed`;
		assert.equal(widgetsAcl.allowed, true, 'legacy Widgets ACL preserved');
	}
	await assert.rejects(
		prisma.$queryRawUnsafe(
			'SELECT id FROM foreign_service_guard.sentinel LIMIT 1'
		),
		sqlDenied
	);
	const workspaceId = randomUUID(),
		owner = `commerce-test-${randomUUID()}`;
	const context = { schemaVersion: 1, workspaceId, actorSubject: owner };
	await prisma.identityContactProjection.create({
		data: {
			userId: owner,
			status: 'ACTIVE',
			email: 'commerce@example.test',
			roles: ['USER']
		}
	});
	phase = 'trial-checkout-concurrency';
	const trialCommandId = randomUUID();
	const trial = await entitlements.activateTrial({
		schemaVersion: 1,
		commandId: trialCommandId,
		workspaceId,
		activatedByUserId: owner
	});
	const summary = await service.summary(context);
	assert.equal(summary.billingVersion, '0');
	assert.equal(trial.entitlement.seatLimit, 2);
	const checkout = capacity(
		{
			...context,
			commandId: randomUUID(),
			expectedBillingVersion: summary.billingVersion,
			expectedPolicyVersion: summary.policy.policyVersion,
			cycle: 'MONTHLY',
			totalSeats: summary.policy.includedSeats,
			autoRenew: true,
			consentVersion: WINCRM_CONSENT_VERSION
		},
		'WINCRM_CHECKOUT',
		summary.policy.includedSeats
	);
	const attempts = await Promise.all([
		service.checkout(checkout),
		service.checkout(checkout)
	]);
	assert.equal(attempts[0].order.id, attempts[1].order.id);
	assert.equal(await prisma.crmOrder.count({ where: { workspaceId } }), 1);
	assert.equal(attempts[0].status, 'PENDING');
	await assert.rejects(
		service.checkout({ ...checkout, actorSubject: 'other' })
	);
	const orderId = attempts[0].order.id;
	const initialOperation =
		await prisma.crmProviderOperation.findFirstOrThrow({
			where: { orderId, kind: 'CREATE' }
		});
	const event = await prisma.outboxEvent.findUniqueOrThrow({
		where: { id: initialOperation.outboxId }
	});
	assert.equal(event.status, 'PENDING');
	assert.equal(Object.keys(event.payload).length, 4);
	const claim = await service.claimProviderOperation(event.payload);
	assert.equal(claim.state, 'CLAIMED');
	const busy = await service.claimProviderOperation(event.payload);
	assert.equal(busy.state, 'BUSY');
	const prepared = await service.prepareProviderOperation(claim.claim);
	assert.equal(prepared.action, 'CREATE');
	process.env.BILLING_WINCRM_FRONTEND_ORIGIN =
		'https://changed.example.test';
	assert.deepEqual(
		(await service.prepareProviderOperation(claim.claim)).request,
		prepared.request
	);
	// Reverse Access authorization is a separate HTTP gate; this script proves
	// the Billing transaction following it, without inventing a user JWT.
	await service.beginProviderDispatch(claim.claim);
	phase = 'immutable-database-evidence';
	for (const [sql, args] of [
		[
			'UPDATE billing.crm_orders SET amount_minor=amount_minor+1 WHERE id=$1::uuid',
			[orderId]
		],
		[
			"UPDATE billing.crm_orders SET price_snapshot=jsonb_set(price_snapshot,'{monthlyPriceMinor}','null'::jsonb) WHERE id=$1::uuid",
			[orderId]
		],
		[
			"UPDATE billing.crm_provider_operations SET request_snapshot=jsonb_set(request_snapshot,'{returnUrl}','\"https://forged.example.test\"'::jsonb) WHERE id=$1::uuid",
			[initialOperation.id]
		],
		[
			'UPDATE billing.crm_provider_operations SET first_dispatch_at=NULL WHERE id=$1::uuid',
			[initialOperation.id]
		],
		[
			"UPDATE billing.crm_provider_operations SET status='PENDING', lease_token=NULL WHERE id=$1::uuid",
			[initialOperation.id]
		],
		[
			"UPDATE billing.crm_commerce_commands SET actor_subject='different' WHERE command_id=$1::uuid",
			[checkout.commandId]
		]
	])
		await assert.rejects(
			prisma.$executeRawUnsafe(sql, ...args),
			sqlConstraint
		);
	phase = 'verified-paid-fulfillment';
	const payment = {
		id: `synthetic-${randomUUID()}`,
		status: 'succeeded',
		paid: true,
		captured_at: new OriginalDate().toISOString(),
		amount: { value: prepared.request.amount, currency: 'RUB' },
		metadata: {
			productCode: 'WINCRM',
			paymentId: orderId,
			kind: 'ONE_TIME',
			plan: 'WINCRM',
			billingPeriod: 'MONTHLY'
		},
		payment_method: {
			id: `synthetic-method-${randomUUID()}`,
			saved: true,
			type: 'bank_card',
			title: 'Synthetic card',
			card: { last4: '4242' }
		}
	};
	await service.settleProviderOperation(claim.claim, payment);
	assert.equal(
		(await service.claimProviderOperation(event.payload)).state,
		'DONE'
	);
	assert.equal(
		await prisma.crmPaidPeriod.count({ where: { workspaceId } }),
		1
	);
	const paid = await prisma.crmPaidPeriod.findFirstOrThrow({
		where: { workspaceId }
	});
	assert.equal(
		paid.startsAt.toISOString(),
		trial.entitlement.effectiveUntil
	);
	const scheduledAdminRead = await new CrmAdminSubscriptionService(
		prisma
	).list(
		{ page: 1, pageSize: 20, workspaceId },
		{
			subject: owner,
			roles: ['ADMIN'],
			active: true,
			sessionId: 'synthetic-admin-session'
		}
	);
	assert.equal(scheduledAdminRead.total, 1);
	assert.equal(scheduledAdminRead.items[0].period.id, paid.id);
	assert.equal(scheduledAdminRead.items[0].entitlement.planCode, 'TRIAL');
	assert.equal(
		scheduledAdminRead.items[0].entitlement.effectiveUntil,
		trial.entitlement.effectiveUntil
	);
	const storedBase = await prisma.crmEntitlement.findUniqueOrThrow({
		where: { workspaceId }
	});
	assert.equal(storedBase.planCode, 'TRIAL');
	assert.equal(storedBase.provisioningCommandId, trialCommandId);
	assert.equal(
		storedBase.provisioningCommandType,
		'ACTIVATE_WINCRM_TRIAL'
	);
	const scheduledProof = await service.commandStatus({
		...context,
		commandId: checkout.commandId,
		requestHash: checkout.capacityFence.requestHash
	});
	assert.equal(scheduledProof.status, 'COMMITTED');
	assert.equal(scheduledProof.releaseFence, false);
	assert.equal(scheduledProof.holdUntil, paid.startsAt.toISOString());
	const renewal = await prisma.crmAutoRenewal.findUniqueOrThrow({
		where: { workspaceId }
	});
	assert.ok(renewal.paymentMethodCiphertext.startsWith('v1:'));
	assert.ok(
		!renewal.paymentMethodCiphertext.includes(payment.payment_method.id)
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			"UPDATE billing.crm_orders SET provider_payment_id='different' WHERE id=$1::uuid",
			orderId
		),
		sqlConstraint
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'UPDATE billing.crm_paid_periods SET original_seats=original_seats+1 WHERE id=$1::uuid',
			paid.id
		),
		sqlConstraint
	);
	phase = 'scheduled-start-seats-cas';
	let clock = paid.startsAt.getTime() + 60000;
	globalThis.Date = class extends OriginalDate {
		constructor(...args) {
			super(...(args.length ? args : [clock]));
		}
		static now() {
			return clock;
		}
	};
	process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
	await service.advanceRenewals(new Date());
	assert.ok(
		(
			await prisma.crmPaidPeriod.findUniqueOrThrow({
				where: { id: paid.id }
			})
		).activationNotifiedAt
	);
	assert.equal(
		(await entitlements.get(workspaceId)).entitlement.planCode,
		'PAID'
	);
	assert.equal(
		(
			await service.commandStatus({
				...context,
				commandId: checkout.commandId,
				requestHash: checkout.capacityFence.requestHash
			})
		).releaseFence,
		true
	);
	process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
	const active = await service.summary(context);
	const seats = capacity(
		{
			...context,
			commandId: randomUUID(),
			expectedBillingVersion: active.billingVersion,
			expectedPeriodId: paid.id,
			expectedPeriodVersion: paid.version,
			newTotalSeats: paid.totalSeats + 1
		},
		'WINCRM_SEAT_CHANGE',
		paid.totalSeats + 1,
		2
	);
	const changed = await service.changeSeats(seats);
	assert.equal(changed.period.totalSeats, paid.totalSeats + 1);
	assert.ok(
		Date.parse(changed.period.expiresAt) < paid.expiresAt.getTime()
	);
	assert.deepEqual(
		changed.period.priceSnapshot,
		active.period.priceSnapshot
	);
	const afterSeats = await service.summary(context);
	const competing = [paid.totalSeats + 2, paid.totalSeats + 3].map(
		newTotalSeats =>
			capacity(
				{
					...context,
					commandId: randomUUID(),
					expectedBillingVersion: afterSeats.billingVersion,
					expectedPeriodId: paid.id,
					expectedPeriodVersion: changed.period.version,
					newTotalSeats
				},
				'WINCRM_SEAT_CHANGE',
				newTotalSeats,
				3
			)
	);
	const races = await Promise.allSettled(
		competing.map(dto => service.changeSeats(dto))
	);
	assert.equal(
		races.filter(result => result.status === 'fulfilled').length,
		1
	);
	assert.equal(
		races.filter(result => result.status === 'rejected').length,
		1
	);
	phase = 'disable-and-late-command-tombstone';
	const latest = await service.summary(context);
	await service.disableRenewal({
		...context,
		commandId: randomUUID(),
		expectedBillingVersion: latest.billingVersion,
		expectedRenewalVersion: latest.renewal.version
	});
	const disabled = await service.summary(context);
	assert.equal(disabled.renewal.state, 'USER_DISABLED');
	const late = capacity(
		{
			...context,
			commandId: randomUUID(),
			expectedBillingVersion: disabled.billingVersion,
			expectedPolicyVersion: disabled.policy.policyVersion,
			cycle: 'MONTHLY',
			totalSeats: disabled.policy.includedSeats,
			autoRenew: false,
			consentVersion: null
		},
		'WINCRM_CHECKOUT',
		disabled.policy.includedSeats,
		4
	);
	const closed = await service.closeCommand({
		...context,
		commandId: late.commandId,
		requestHash: late.capacityFence.requestHash,
		commandType: 'WINCRM_CHECKOUT',
		capacityFence: late.capacityFence
	});
	assert.equal(closed.status, 'CANCELLED');
	await assert.rejects(service.checkout(late));
	const record = await prisma.crmPaidPeriod.findUniqueOrThrow({
		where: { id: paid.id }
	});
	clock = record.graceUntil.getTime();
	assert.equal((await entitlements.get(workspaceId)).status, 'READ_ONLY');
	phase = 'administrative-free-day-grants';
	const administrative = new CrmAdminSubscriptionService(prisma);
	const operator = {
		subject: owner,
		roles: ['DEV'],
		active: true,
		sessionId: 'synthetic-admin-session'
	};
	const makeGrant = (subscription, days = 7) => ({
		schemaVersion: 1,
		commandId: randomUUID(),
		expectedActorSubject: operator.subject,
		expectedEntitlementVersion: subscription.entitlementVersion,
		expectedBillingVersion: subscription.billingVersion,
		expectedPeriodId: subscription.period?.id ?? null,
		expectedPeriodVersion: subscription.period?.version ?? null,
		days,
		reason: 'Synthetic administrative compensation'
	});
	const previous = (await administrative.detail(workspaceId, operator))
		.subscription;
	assert.equal(previous.blockedReason, null);
	const originalPeriod = await prisma.crmPaidPeriod.findUniqueOrThrow({
		where: { id: previous.period.id }
	});
	const originalOrderCount = await prisma.crmOrder.count({
		where: { workspaceId }
	});
	const originalRenewal = await prisma.crmAutoRenewal.findUniqueOrThrow({
		where: { workspaceId }
	});
	const grantCommand = makeGrant(previous);
	const grantResults = await Promise.all([
		administrative.extend(workspaceId, grantCommand, { actor: operator }),
		administrative.extend(workspaceId, grantCommand, { actor: operator })
	]);
	assert.deepEqual(grantResults[0], grantResults[1]);
	assert.equal(grantResults[0].grant.target, 'PAID_PERIOD');
	assert.equal(grantResults[0].grant.actorRole, 'DEV');
	assert.equal(
		grantResults[0].grant.newExpiresAt,
		new Date(clock + 7 * 86400000).toISOString()
	);
	assert.equal((await entitlements.get(workspaceId)).status, 'ACTIVE');
	assert.equal(
		await prisma.crmOrder.count({ where: { workspaceId } }),
		originalOrderCount
	);
	const grantedPeriod = await prisma.crmPaidPeriod.findUniqueOrThrow({
		where: { id: previous.period.id }
	});
	for (const key of [
		'startsAt',
		'originalExpiresAt',
		'originalSeats',
		'priceSnapshot',
		'orderId'
	])
		assert.deepEqual(grantedPeriod[key], originalPeriod[key]);
	const grantedRenewal = await prisma.crmAutoRenewal.findUniqueOrThrow({
		where: { workspaceId }
	});
	for (const key of [
		'status',
		'consentVersion',
		'consentText',
		'paymentMethodCiphertext',
		'amountMinor'
	])
		assert.deepEqual(grantedRenewal[key], originalRenewal[key]);
	assert.equal(+grantedRenewal.nextChargeAt, +grantedPeriod.expiresAt);
	assert.equal(
		await prisma.crmAdminDayGrant.count({
			where: { commandId: grantCommand.commandId }
		}),
		1
	);
	const history = await administrative.history(
		workspaceId,
		{ page: 1, pageSize: 20 },
		operator
	);
	assert.equal(history.total, 1);
	assert.equal(history.items[0].commandId, grantCommand.commandId);
	assert.deepEqual(
		(
			await administrative.command(
				workspaceId,
				grantCommand.commandId,
				operator
			)
		).result,
		grantResults[0]
	);
	await assert.rejects(
		administrative.extend(
			workspaceId,
			{ ...grantCommand, days: 8 },
			{ actor: operator }
		)
	);
	await assert.rejects(
		administrative.extend(
			workspaceId,
			{ ...grantCommand, commandId: randomUUID() },
			{ actor: operator }
		),
		error =>
			error?.response?.code === 'crm_admin_subscription_version_conflict'
	);
	for (const roles of [['USER'], ['CRM_ADMIN']])
		await assert.rejects(
			administrative.extend(workspaceId, grantCommand, {
				actor: { ...operator, roles }
			}),
			error => error?.status === 403
		);
	const freshForRace = (await administrative.detail(workspaceId, operator))
		.subscription;
	const differentCommands = await Promise.allSettled([
		administrative.extend(workspaceId, makeGrant(freshForRace, 1), {
			actor: operator
		}),
		administrative.extend(workspaceId, makeGrant(freshForRace, 2), {
			actor: operator
		})
	]);
	assert.equal(
		differentCommands.filter(result => result.status === 'fulfilled')
			.length,
		1
	);
	assert.equal(
		differentCommands.filter(result => result.status === 'rejected')
			.length,
		1
	);
	const manualTrialWorkspace = randomUUID();
	await entitlements.activateTrial({
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: manualTrialWorkspace,
		activatedByUserId: owner
	});
	const manualTrial = (
		await administrative.detail(manualTrialWorkspace, operator)
	).subscription;
	const trialGrant = await administrative.extend(
		manualTrialWorkspace,
		makeGrant(manualTrial),
		{ actor: { ...operator, roles: ['ADMIN'] } }
	);
	assert.equal(trialGrant.grant.target, 'ENTITLEMENT');
	assert.equal(trialGrant.subscription.billingVersion, '0');
	assert.equal(
		await prisma.crmOrder.count({
			where: { workspaceId: manualTrialWorkspace }
		}),
		0
	);
	assert.equal(
		await prisma.crmCommerceAccount.count({
			where: { workspaceId: manualTrialWorkspace }
		}),
		0
	);
	const selected = await administrative.list(
		{
			page: 1,
			pageSize: 10,
			ownerSubject: owner,
			workspaceId: manualTrialWorkspace
		},
		operator
	);
	assert.equal(selected.total, 1);
	assert.equal(selected.items[0].workspaceId, manualTrialWorkspace);
	const paidPage = await administrative.list(
		{ page: 1, pageSize: 100, workspaceId },
		operator
	);
	assert.deepEqual(
		paidPage.items[0],
		(await administrative.detail(workspaceId, operator)).subscription
	);
	phase = 'administrative-cancellation-retention';
	const cancellationInput = {
		schemaVersion: 1,
		expectedActorSubject: operator.subject
	};
	const beforeCancellation = (
		await administrative.detail(manualTrialWorkspace, operator)
	).subscription;
	const unconfirmed = makeGrant(beforeCancellation);
	const cancelled = await administrative.cancel(
		manualTrialWorkspace,
		unconfirmed.commandId,
		cancellationInput,
		{ actor: operator }
	);
	assert.equal(cancelled.outcome, 'CANCELLED');
	assert.equal(cancelled.actorSubject, operator.subject);
	assert.deepEqual(
		await administrative.cancel(
			manualTrialWorkspace,
			unconfirmed.commandId,
			cancellationInput,
			{ actor: operator }
		),
		cancelled
	);
	assert.deepEqual(
		await administrative.command(
			manualTrialWorkspace,
			unconfirmed.commandId,
			operator
		),
		cancelled
	);
	assert.deepEqual(
		(await administrative.detail(manualTrialWorkspace, operator))
			.subscription,
		beforeCancellation
	);
	assert.equal(
		await prisma.crmAdminDayGrant.count({
			where: { commandId: unconfirmed.commandId }
		}),
		0
	);
	await assert.rejects(
		administrative.extend(manualTrialWorkspace, unconfirmed, {
			actor: operator
		}),
		error => error?.response?.code === 'crm_admin_grant_cancelled'
	);
	const alreadyCommitted = await administrative.cancel(
		workspaceId,
		grantCommand.commandId,
		cancellationInput,
		{ actor: operator }
	);
	assert.equal(alreadyCommitted.outcome, 'COMMITTED');
	assert.deepEqual(alreadyCommitted.result, grantResults[0]);
	await assert.rejects(
		administrative.cancel(
			manualTrialWorkspace,
			grantCommand.commandId,
			cancellationInput,
			{ actor: operator }
		),
		error =>
			error?.response?.code === 'crm_admin_subscription_command_conflict'
	);
	await assert.rejects(
		administrative.cancel(
			workspaceId,
			grantCommand.commandId,
			{ ...cancellationInput, expectedActorSubject: 'another-admin' },
			{ actor: { ...operator, subject: 'another-admin' } }
		),
		error =>
			error?.response?.code === 'crm_admin_subscription_command_conflict'
	);
	await assert.rejects(
		administrative.cancel(workspaceId, trialCommandId, cancellationInput, {
			actor: operator
		}),
		error =>
			error?.response?.code === 'crm_admin_subscription_command_conflict'
	);
	for (let iteration = 0; iteration < 4; iteration += 1) {
		const state = (
			await administrative.detail(manualTrialWorkspace, operator)
		).subscription;
		const racingCommand = makeGrant(state, 1);
		const grantCall = () =>
			administrative.extend(manualTrialWorkspace, racingCommand, {
				actor: operator
			});
		const cancelCall = () =>
			administrative.cancel(
				manualTrialWorkspace,
				racingCommand.commandId,
				cancellationInput,
				{ actor: operator }
			);
		const calls =
			iteration % 2
				? [cancelCall(), grantCall()]
				: [grantCall(), cancelCall()];
		const results = await Promise.allSettled(calls);
		const cancellationResult = results[iteration % 2 ? 0 : 1];
		assert.equal(cancellationResult.status, 'fulfilled');
		for (const result of results) {
			if (result.status === 'rejected')
				assert.equal(
					result.reason?.response?.code,
					'crm_admin_grant_cancelled'
				);
		}
		const terminal = await administrative.command(
			manualTrialWorkspace,
			racingCommand.commandId,
			operator
		);
		const grantCount = await prisma.crmAdminDayGrant.count({
			where: { commandId: racingCommand.commandId }
		});
		if (terminal.outcome === 'COMMITTED') {
			assert.equal(grantCount, 1);
			assert.deepEqual(
				await administrative.cancel(
					manualTrialWorkspace,
					racingCommand.commandId,
					cancellationInput,
					{ actor: operator }
				),
				terminal
			);
		} else {
			assert.equal(terminal.outcome, 'CANCELLED');
			assert.equal(grantCount, 0);
			await assert.rejects(
				grantCall(),
				error => error?.response?.code === 'crm_admin_grant_cancelled'
			);
		}
	}
	for (const commandId of [
		grantCommand.commandId,
		unconfirmed.commandId
	]) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				'DELETE FROM billing.command_receipts WHERE command_id = $1',
				commandId
			),
			sqlConstraint
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(
				"UPDATE billing.command_receipts SET command_type = 'FORGOTTEN' WHERE command_id = $1",
				commandId
			),
			sqlConstraint
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(
				"UPDATE billing.command_receipts SET result = '{}'::jsonb WHERE command_id = $1",
				commandId
			),
			sqlConstraint
		);
	}
	const legacyReceiptId = randomUUID();
	await prisma.billingCommandReceipt.create({
		data: {
			commandId: legacyReceiptId,
			commandType: 'UNRELATED_WIDGETS_RETENTION_TEST',
			result: {}
		}
	});
	assert.equal(
		await prisma.$executeRawUnsafe(
			'DELETE FROM billing.command_receipts WHERE command_id = $1',
			legacyReceiptId
		),
		1
	);
	const [receiptGuard] =
		await prisma.$queryRaw`SELECT NOT has_function_privilege(current_user, 'billing.protect_crm_admin_command_receipts()', 'EXECUTE') AS private,
		EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'billing.command_receipts'::regclass AND tgname = 'crm_admin_command_receipts_no_truncate' AND tgenabled = 'O') AS truncate_guard`;
	assert.equal(receiptGuard.private, true);
	assert.equal(receiptGuard.truncate_guard, true);
	const missingWorkspace = randomUUID();
	await assert.rejects(
		administrative.extend(missingWorkspace, makeGrant(manualTrial), {
			actor: operator
		}),
		error =>
			error?.response?.code === 'crm_admin_subscription_not_provisioned'
	);
	assert.equal(
		await prisma.crmEntitlement.count({
			where: { workspaceId: missingWorkspace }
		}),
		0
	);
	for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
		const [acl] = await prisma.$queryRawUnsafe(
			'SELECT has_table_privilege(current_user, $1, $2) AS allowed',
			'billing.crm_admin_day_grants',
			privilege
		);
		assert.equal(
			acl.allowed,
			false,
			`manual grant ${privilege} prohibited`
		);
	}
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'UPDATE billing.crm_admin_day_grants SET days = 99 WHERE command_id = $1::uuid',
			grantCommand.commandId
		),
		sqlDenied
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'DELETE FROM billing.crm_admin_day_grants WHERE command_id = $1::uuid',
			grantCommand.commandId
		),
		sqlDenied
	);
	await assert.rejects(
		prisma.$executeRawUnsafe('TRUNCATE billing.crm_admin_day_grants'),
		sqlDenied
	);
	console.log(
		JSON.stringify({
			ok: true,
			gate: 'wincrm-commerce-postgres18',
			realPostgres: true,
			syntheticProviderResults: true,
			providerHttpVerified: false,
			rabbitTransportVerified: false,
			concurrency: true,
			snapshots: true,
			immutableEvidence: true,
			trialProvenance: true,
			scheduledActivation: true,
			seatsCas: true,
			leastPrivilege: true,
			administrativeFreeDays: true,
			administrativeCancellation: true
		})
	);
} catch {
	console.error(
		`WinCRM commerce PostgreSQL gate failed at ${phase}; sensitive exception output suppressed`
	);
	process.exitCode = 1;
} finally {
	globalThis.Date = OriginalDate;
	if (prisma) await prisma.$disconnect();
	for (const [name, value] of [
		['BILLING_WINCRM_PAYMENTS_ENABLED', oldFlag],
		['PAYMENT_METHOD_ENCRYPTION_KEY', oldKey],
		['BILLING_WINCRM_FRONTEND_ORIGIN', oldOrigin]
	]) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function capacity(dto, type, seats, fenceRevision = 1) {
	return {
		...dto,
		capacityFence: {
			operationId: dto.commandId,
			requestHash: wincrmCommerceRequestHash(type, dto),
			fenceRevision,
			targetSeats: seats
		}
	};
}
function sqlDenied(error) {
	return error?.meta?.code === '42501';
}
function sqlConstraint(error) {
	return ['P0001', '23514', '23503', '42501'].includes(error?.meta?.code);
}
