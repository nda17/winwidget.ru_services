import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/billing-client');
const {
	CrmCommercialPolicyService
} = require('../../dist/src/domain/crm-commercial-policy.service.js');
const {
	CrmEntitlementService
} = require('../../dist/src/domain/crm-entitlement.service.js');

assert.equal(
	process.env.BILLING_CRM_POLICY_TEST_ALLOW_MUTATION,
	'true',
	'Explicit local test mutation opt-in is required'
);
const databaseUrl = requiredEnv('BILLING_CRM_POLICY_TEST_DATABASE_URL');
const expectedRole = requiredEnv('BILLING_CRM_POLICY_TEST_RUNTIME_ROLE');
assert.match(expectedRole, /^[a-z][a-z0-9_]{0,62}$/);
const parsed = new URL(databaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
assert.ok(
	['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname),
	'Only loopback PostgreSQL is allowed'
);
assert.match(
	parsed.pathname,
	/^\/winwidget_billing_crm_policy_test(?:_[a-z0-9]+)*$/
);
assert.equal(decodeURIComponent(parsed.username), expectedRole);
assert.equal(parsed.searchParams.get('schema'), 'billing');

const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const policyService = new CrmCommercialPolicyService(prisma);
const entitlementService = new CrmEntitlementService(prisma);
const context = {
	actor: {
		active: true,
		subject: 'policy-test-dev',
		sessionId: 'policy-test-session',
		roles: ['DEV']
	}
};

try {
	const [role] = await prisma.$queryRaw`
		SELECT current_user AS name,
			current_setting('server_version_num')::integer AS version,
			NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
				AND NOT rolinherit AND NOT rolreplication AND rolcanlogin AS restricted,
			pg_get_userbyid(nspowner) <> current_user AS not_owner,
			NOT has_database_privilege(current_user, current_database(), 'CREATE') AS database_create_denied,
			NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS foreign_schema_denied
		FROM pg_roles JOIN pg_namespace ON nspname = 'billing'
		WHERE rolname = current_user
	`;
	assert.equal(role.name, expectedRole);
	assert.equal(role.restricted, true);
	assert.equal(role.database_create_denied, true);
	assert.equal(role.foreign_schema_denied, true);
	await assert.rejects(
		prisma.$queryRawUnsafe(
			'SELECT id FROM foreign_service_guard.sentinel LIMIT 1'
		),
		error => error?.meta?.code === '42501'
	);
	assert.equal(
		role.not_owner,
		true,
		'Use the runtime role, not the schema owner'
	);
	assert.ok(
		role.version >= 180000 && role.version < 190000,
		'PostgreSQL 18 is required'
	);
	const initial = await policyService.get();
	assert.deepEqual(
		{ ...initial, createdAt: undefined },
		{
			schemaVersion: 1,
			productCode: 'WINCRM',
			version: 2,
			currency: 'RUB',
			monthlyPriceMinor: 99000,
			yearlyPriceMinor: 990000,
			additionalSeatMonthlyPriceMinor: 29000,
			additionalSeatYearlyPriceMinor: 290000,
			includedSeats: 2,
			trialSeatLimit: 2,
			trialDays: 5,
			graceDays: 3,
			createdAt: undefined
		},
		'The test requires a freshly migrated database with seeded policy v2'
	);
	const initialPolicyCount = 2;
	const historicalSeed =
		await prisma.crmCommercialPolicy.findUniqueOrThrow({
			where: { version: 1 }
		});
	assert.equal(historicalSeed.trialSeatLimit, 5);
	assert.equal(historicalSeed.includedSeats, 2);
	assert.equal(historicalSeed.trialDays, 5);
	assert.equal(historicalSeed.createdByUserId, null);
	assert.equal(await prisma.crmEntitlement.count(), 0);
	assert.equal(await prisma.billingCommandReceipt.count(), 0);

	for (const sql of [
		'UPDATE billing.crm_commercial_policies SET included_seats = 3 WHERE version = 1',
		'DELETE FROM billing.crm_commercial_policies WHERE version = 1',
		'TRUNCATE billing.crm_commercial_policies CASCADE'
	]) {
		await assert.rejects(prisma.$executeRawUnsafe(sql), error =>
			['P0001', '42501'].includes(error?.meta?.code)
		);
	}
	for (const [includedSeats, trialSeatLimit] of [
		[1, 2],
		[2, 1]
	]) {
		await assert.rejects(
			prisma.$executeRaw`
			INSERT INTO billing.crm_commercial_policies
			(version, monthly_price_minor, yearly_price_minor,
			 additional_seat_monthly_price_minor, additional_seat_yearly_price_minor,
			 included_seats, trial_seat_limit, trial_days, grace_days)
			VALUES (3, 1, 1, 1, 1, ${includedSeats}, ${trialSeatLimit}, 5, 3)
		`,
			error =>
				error?.meta?.code === '23514' &&
				String(error?.meta?.message).includes(
					'crm_commercial_policies_seats_check'
				)
		);
	}
	assert.equal(
		await prisma.crmCommercialPolicy.count(),
		initialPolicyCount
	);

	const trialCommand = {
		schemaVersion: 1,
		commandId: randomUUID(),
		workspaceId: randomUUID(),
		activatedByUserId: 'policy-test-owner'
	};
	const firstTrial = await entitlementService.activateTrial(trialCommand);
	assert.equal(firstTrial.activated, true);
	assert.equal(firstTrial.entitlement.policyVersion, initial.version);
	assert.equal(firstTrial.entitlement.seatLimit, 2);
	assert.equal(
		Date.parse(firstTrial.entitlement.effectiveUntil) -
			Date.parse(firstTrial.entitlement.effectiveFrom),
		5 * 86400000
	);
	assert.equal(
		Date.parse(firstTrial.entitlement.graceUntil) -
			Date.parse(firstTrial.entitlement.effectiveUntil),
		3 * 86400000
	);

	const command = {
		schemaVersion: 1,
		commandId: randomUUID(),
		expectedVersion: initial.version,
		monthlyPriceMinor: 199000,
		yearlyPriceMinor: 1990000,
		additionalSeatMonthlyPriceMinor: 39000,
		additionalSeatYearlyPriceMinor: 390000,
		includedSeats: 3,
		trialSeatLimit: 7
	};
	const concurrentReplay = await Promise.all([
		policyService.update(command, context),
		policyService.update(command, context)
	]);
	assert.deepEqual(concurrentReplay[0], concurrentReplay[1]);
	assert.equal(concurrentReplay[0].version, initial.version + 1);
	assert.equal(
		await prisma.crmCommercialPolicy.count(),
		initialPolicyCount + 1
	);
	assert.equal(
		await prisma.outboxEvent.count({
			where: { aggregateType: 'billing.admin-audit' }
		}),
		1
	);
	await assert.rejects(
		policyService.update({ ...command, includedSeats: 4 }, context),
		error => error?.status === 409
	);
	await assert.rejects(
		policyService.update(command, {
			actor: { ...context.actor, subject: 'other-dev' }
		}),
		error => error?.status === 409
	);
	await assert.rejects(
		policyService.update({ ...command, commandId: randomUUID() }, context),
		error =>
			error?.response?.code === 'crm_commercial_policy_version_conflict'
	);

	const oldTrial = await entitlementService.activateTrial(trialCommand);
	assert.equal(oldTrial.activated, false);
	assert.deepEqual(
		oldTrial.entitlement,
		firstTrial.entitlement,
		'Existing Trial snapshots must survive policy changes'
	);
	const newTrial = await entitlementService.activateTrial({
		...trialCommand,
		commandId: randomUUID(),
		workspaceId: randomUUID()
	});
	assert.equal(newTrial.entitlement.policyVersion, initial.version + 1);
	assert.equal(newTrial.entitlement.seatLimit, 7);

	const competingCommands = [
		{
			...command,
			commandId: randomUUID(),
			expectedVersion: initial.version + 1,
			includedSeats: 4
		},
		{
			...command,
			commandId: randomUUID(),
			expectedVersion: initial.version + 1,
			includedSeats: 5
		}
	];
	const competing = await Promise.allSettled(
		competingCommands.map(dto => policyService.update(dto, context))
	);
	assert.equal(
		competing.filter(result => result.status === 'fulfilled').length,
		1
	);
	const rejected = competing.find(result => result.status === 'rejected');
	assert.equal(
		rejected.reason.response.code,
		'crm_commercial_policy_version_conflict'
	);
	assert.equal(
		await prisma.crmCommercialPolicy.count(),
		initialPolicyCount + 2
	);
	assert.deepEqual(
		await policyService.update(command, context),
		concurrentReplay[0],
		'Old command replays its exact original policy result'
	);

	const rollbackCommand = {
		...command,
		commandId: randomUUID(),
		expectedVersion: initial.version + 2
	};
	const failingPrisma = {
		$transaction: (callback, options) =>
			prisma.$transaction(
				transaction =>
					callback(
						new Proxy(transaction, {
							get(target, property) {
								if (property === 'outboxEvent')
									return {
										create: async () => {
											throw new Error('intentional audit failure');
										}
									};
								const value = Reflect.get(target, property);
								return typeof value === 'function'
									? value.bind(target)
									: value;
							}
						})
					),
				options
			)
	};
	await assert.rejects(
		new CrmCommercialPolicyService(failingPrisma).update(
			rollbackCommand,
			context
		),
		/intentional audit failure/
	);
	assert.equal(
		await prisma.crmCommercialPolicy.count(),
		initialPolicyCount + 2
	);
	assert.equal(
		await prisma.billingCommandReceipt.count({
			where: { commandId: rollbackCommand.commandId }
		}),
		0
	);
	assert.equal(
		await prisma.outboxEvent.count({
			where: { aggregateType: 'billing.admin-audit' }
		}),
		2
	);

	const legacy = await prisma.crmEntitlement.create({
		data: {
			workspaceId: randomUUID(),
			activatedByUserId: 'legacy-test-owner',
			provisioningCommandId: randomUUID(),
			provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
			trialStartedAt: new Date('2020-01-01T00:00:00.000Z'),
			effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
			effectiveUntil: new Date('2020-01-06T00:00:00.000Z'),
			sourceSequence: 999n
		}
	});
	assert.equal(
		(await entitlementService.get(legacy.workspaceId)).status,
		'EXPIRED'
	);
	assert.equal(legacy.policyVersion, null);
	assert.equal(legacy.graceUntil, null);
	const aged = await prisma.crmEntitlement.create({
		data: {
			workspaceId: randomUUID(),
			activatedByUserId: 'expired-policy-owner',
			provisioningCommandId: randomUUID(),
			provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
			trialStartedAt: new Date('2020-01-01T00:00:00.000Z'),
			effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
			effectiveUntil: new Date('2020-01-06T00:00:00.000Z'),
			graceUntil: new Date('2020-01-09T00:00:00.000Z'),
			seatLimit: 5,
			policyVersion: 1,
			sourceSequence: 1000n
		}
	});
	assert.equal(
		(await entitlementService.get(aged.workspaceId)).status,
		'READ_ONLY'
	);
	assert.equal(
		(await entitlementService.get(aged.workspaceId)).entitlement.seatLimit,
		5
	);
	assert.deepEqual(
		await prisma.crmCommercialPolicy.findUniqueOrThrow({
			where: { version: 1 }
		}),
		historicalSeed,
		'Historical default policy is not rewritten by later publication'
	);
	console.log(
		'Billing CRM policy PostgreSQL 18 runtime, CAS, replay, snapshot and rollback checks passed'
	);
} finally {
	await prisma.$disconnect();
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	assert.ok(value, `${name} is required`);
	return value;
}
