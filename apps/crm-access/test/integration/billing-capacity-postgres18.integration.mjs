import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-access-client');
const {
	NotFoundException,
	ServiceUnavailableException
} = require('@nestjs/common');
const {
	CrmBillingCapacityService,
	effectiveAdmissionCeiling
} = require('../../dist/src/billing/billing-capacity.service.js');
const {
	CrmTeamAdmissionService
} = require('../../dist/src/team/team-admission.service.js');
assert.equal(process.env.CRM_ACCESS_INTEGRATION_ALLOW_MUTATION, 'true');
const databaseUrl = required('CRM_ACCESS_TEST_DATABASE_URL'),
	runtimeRole = required('CRM_ACCESS_TEST_RUNTIME_ROLE');
const url = new URL(databaseUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.match(url.pathname, /^\/winwidget_crm_access_test(?:_[a-z0-9]+)*$/);
assert.equal(decodeURIComponent(url.username), runtimeRole);
assert.equal(url.searchParams.get('schema'), 'crm_access');
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const actorSubject = `billing-owner-${randomUUID()}`;
const workspaceId = randomUUID();
let ownerValid = true,
	phase = 'preflight';
const identity = {
	authContext: async () => ({
		schemaVersion: 1,
		subject: actorSubject,
		sessionId: randomUUID(),
		memberships: [
			{ workspaceId, membershipId: randomUUID(), role: 'OWNER' }
		]
	}),
	widgetSourceContext: async () => ({
		ownerSubject: ownerValid ? actorSubject : null,
		membership: ownerValid ? { role: 'OWNER' } : null
	})
};
let transport = async () => {
	throw new NotFoundException();
};
const billing = {
	enabled: true,
	request: async (...args) => transport(...args)
};
const service = new CrmBillingCapacityService(prisma, billing, identity);
const command = (patch = {}) => ({
	schemaVersion: 1,
	workspaceId,
	actorSubject,
	commandId: randomUUID(),
	expectedBillingVersion: '0',
	expectedPolicyVersion: 1,
	cycle: 'MONTHLY',
	totalSeats: 5,
	autoRenew: false,
	consentVersion: null,
	...patch
});
const period = seats => ({
	id: randomUUID(),
	orderId: randomUUID(),
	version: 1,
	cycle: 'MONTHLY',
	totalSeats: seats,
	priceSnapshot: {
		policyVersion: 1,
		monthlyPriceMinor: 10000,
		yearlyPriceMinor: 100000,
		additionalSeatMonthlyPriceMinor: 5000,
		additionalSeatYearlyPriceMinor: 50000,
		includedSeats: 2,
		graceDays: 3
	},
	startsAt: '2026-09-05T00:00:00.000Z',
	expiresAt: '2026-10-05T00:00:00.000Z',
	graceUntil: '2026-10-08T00:00:00.000Z',
	state: 'ACTIVE'
});
const proof = (op, patch = {}) => ({
	schemaVersion: 1,
	workspaceId: op.workspaceId,
	commandId: op.commandId,
	requestHash: op.requestHash,
	status: 'PENDING',
	billingVersion: '1',
	releaseFence: false,
	holdUntil: null,
	order: null,
	period: null,
	...patch
});
const denial = error => error?.meta?.code === '42501';
try {
	const [pg] =
		await prisma.$queryRaw`SELECT current_setting('server_version_num')::integer AS version, current_user AS role`;
	assert.ok(pg.version >= 180000 && pg.version < 190000);
	assert.equal(pg.role, runtimeRole);
	const [role] =
		await prisma.$queryRaw`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
	assert.ok(Object.values(role).every(value => value === false));

	phase = 'parallel-reservation-replay';
	const request = command();
	const results = await Promise.allSettled(
		Array.from({ length: 6 }, () =>
			service.prepare('WINCRM_CHECKOUT', request, 2)
		)
	);
	assert.ok(results.every(result => result.status === 'fulfilled'));
	let op = results[0].value;
	assert.equal(
		await prisma.crmBillingOperation.count({
			where: { commandId: request.commandId }
		}),
		1
	);
	assert.equal(
		await prisma.crmTeamCommandReceipt.count({
			where: { commandId: request.commandId }
		}),
		1
	);
	const cap = await prisma.crmBillingCapacity.findUniqueOrThrow({
		where: { workspaceId }
	});
	assert.equal(cap.pendingTargetSeats, 5);
	assert.equal(cap.admissionCeiling, 2);
	assert.equal(effectiveAdmissionCeiling(5, cap), 2);
	for (const patch of [
		{ actorSubject: 'another-owner' },
		{ workspaceId: randomUUID() },
		{ totalSeats: 6 }
	])
		await assert.rejects(
			service.prepare('WINCRM_CHECKOUT', { ...request, ...patch }, 2),
			error => error?.getStatus?.() === 409
		);
	await assert.rejects(
		service.prepare('WINCRM_CHECKOUT', command(), 2),
		error => error?.getStatus?.() === 409
	);

	phase = 'ambiguous-status-and-owner-revocation';
	transport = async () => {
		throw new ServiceUnavailableException();
	};
	await assert.rejects(service.synchronize(op));
	assert.equal(
		(
			await prisma.crmBillingCapacity.findUniqueOrThrow({
				where: { workspaceId }
			})
		).pendingOperationId,
		op.commandId
	);
	const [due] =
		await prisma.$queryRaw`SELECT next_check_at>clock_timestamp()+interval '3 seconds' AS delayed FROM crm_access.crm_billing_operations WHERE command_id=${op.commandId}::uuid`;
	assert.equal(due.delayed, true);
	ownerValid = false;
	await assert.rejects(
		service.execute(op),
		error => error?.getStatus?.() === 403
	);
	ownerValid = true;

	phase = 'scheduled-proof-and-durable-ceiling';
	op = await service.applyProof(
		op,
		proof(op, {
			status: 'COMMITTED',
			holdUntil: '2026-09-10T00:00:00.000Z',
			period: period(5)
		})
	);
	assert.equal(
		(
			await prisma.crmBillingCapacity.findUniqueOrThrow({
				where: { workspaceId }
			})
		).pendingOperationId,
		op.commandId
	);
	op = await service.applyProof(
		op,
		proof(op, {
			status: 'COMMITTED',
			releaseFence: true,
			period: period(5)
		})
	);
	assert.equal(
		(
			await prisma.crmBillingCapacity.findUniqueOrThrow({
				where: { workspaceId }
			})
		).admissionCeiling,
		5
	);
	assert.equal(
		await prisma.crmTeamOutbox.count({
			where: { deduplicationKey: `admission:billing:${op.commandId}` }
		}),
		1
	);
	await service.applyProof(
		op,
		proof(op, {
			status: 'COMMITTED',
			releaseFence: true,
			period: period(5)
		})
	);
	assert.equal(
		await prisma.crmTeamOutbox.count({
			where: { deduplicationKey: `admission:billing:${op.commandId}` }
		}),
		1
	);

	phase = 'atomic-close-and-late-execute-fence';
	const cancelled = await service.prepare(
		'WINCRM_CHECKOUT',
		command({ totalSeats: 3 }),
		5
	);
	transport = async path => {
		if (path === 'operations/get') throw new NotFoundException();
		assert.equal(path, 'operations/close');
		return proof(cancelled, { status: 'CANCELLED', releaseFence: true });
	};
	assert.equal(
		(await service.recover(workspaceId, cancelled.commandId, actorSubject))
			.state,
		'CANCELLED'
	);
	const untouched = command();
	assert.equal(
		(await service.recover(workspaceId, untouched.commandId, actorSubject))
			.state,
		'NOT_STARTED'
	);
	await assert.rejects(
		service.prepare('WINCRM_CHECKOUT', untouched),
		error => error?.getStatus?.() === 409
	);
	assert.equal(
		(
			await prisma.crmBillingCapacity.findUniqueOrThrow({
				where: { workspaceId }
			})
		).admissionCeiling,
		5
	);

	phase = 'actual-insert-rollback';
	const faultRequest = command({ workspaceId: randomUUID() });
	let faultReached = false;
	const faulty = new CrmBillingCapacityService(
		{
			$transaction: (action, options) =>
				prisma.$transaction(
					async tx =>
						action(
							new Proxy(tx, {
								get: (target, key) =>
									key === 'crmTeamAudit'
										? {
												create: async () => {
													assert.equal(
														await tx.crmBillingOperation.count({
															where: { commandId: faultRequest.commandId }
														}),
														1
													);
													assert.equal(
														await tx.crmTeamCommandReceipt.count({
															where: { commandId: faultRequest.commandId }
														}),
														1
													);
													faultReached = true;
													throw Error('EXPECTED_AFTER_INSERT');
												}
											}
										: target[key]
							})
						),
					options
				)
		},
		billing,
		identity
	);
	await assert.rejects(faulty.prepare('WINCRM_CHECKOUT', faultRequest, 2));
	assert.equal(faultReached, true);
	assert.equal(
		await prisma.crmBillingOperation.count({
			where: { commandId: faultRequest.commandId }
		}),
		0
	);
	assert.equal(
		await prisma.crmTeamCommandReceipt.count({
			where: { commandId: faultRequest.commandId }
		}),
		0
	);
	assert.equal(
		await prisma.crmBillingCapacity.count({
			where: { workspaceId: faultRequest.workspaceId }
		}),
		0
	);

	phase = 'actual-admission-with-stale-billing-read';
	const raceWorkspace = randomUUID(),
		entitlementId = randomUUID(),
		memberSubject = `billing-member-${randomUUID()}`,
		candidateSubject = `billing-candidate-${randomUUID()}`;
	await prisma.crmWorkspaceAccess.create({
		data: {
			workspaceId: raceWorkspace,
			lifecycle: 'ACTIVE',
			activatedBySubject: actorSubject,
			billingEntitlementId: entitlementId,
			provisioningCommandId: randomUUID(),
			provisioningCommandType: 'ACTIVATE_WINCRM_TRIAL',
			onboardingCommandId: randomUUID(),
			onboardingTemplateKey: 'sales',
			onboardingTemplateVersion: 1,
			onboardingTemplateFingerprint: 'a'.repeat(64),
			onboardingPipelineId: randomUUID(),
			onboardingCompletedAt: new Date()
		}
	});
	const active = await prisma.crmWorkspaceMember.create({
		data: {
			workspaceId: raceWorkspace,
			subject: memberSubject,
			membershipId: randomUUID(),
			role: 'MANAGER'
		}
	});
	const pending = await prisma.crmWorkspaceMember.create({
		data: {
			workspaceId: raceWorkspace,
			subject: candidateSubject,
			membershipId: randomUUID(),
			role: 'MANAGER',
			disabledAt: new Date()
		}
	});
	const waiting = await prisma.crmAdmission.create({
		data: {
			workspaceId: raceWorkspace,
			memberId: pending.id,
			expectedMemberVersion: 1,
			subject: candidateSubject,
			membershipId: pending.membershipId,
			requestedBySubject: actorSubject
		}
	});
	const future = new Date(Date.now() + 86400000).toISOString();
	let reachedResolve, resumeResolve;
	const reached = new Promise(resolve => {
			reachedResolve = resolve;
		}),
		resume = new Promise(resolve => {
			resumeResolve = resolve;
		});
	const admissions = new CrmTeamAdmissionService(
		prisma,
		{
			authorizeSubject: async () => ({
				workspaceId: raceWorkspace,
				subject: actorSubject,
				role: 'OWNER',
				state: 'ACTIVE',
				permissions: ['access:manage-team']
			})
		},
		{
			get: async () => {
				reachedResolve();
				await resume;
				return {
					status: 'ACTIVE',
					entitlement: {
						id: entitlementId,
						seatLimit: 5,
						effectiveUntil: future,
						graceUntil: future,
						policyVersion: 1
					}
				};
			}
		},
		{
			sourceContext: async () => ({
				membership: { role: 'MEMBER', membershipId: pending.membershipId }
			})
		},
		{},
		{ manageRole: () => undefined, requireTeams: async () => undefined },
		service
	);
	const admissionResult = admissions.admitNext(raceWorkspace);
	await reached;
	try {
		const decrease = await service.prepare(
			'WINCRM_CHECKOUT',
			command({ workspaceId: raceWorkspace, totalSeats: 2 }),
			5
		);
		await service.applyProof(
			decrease,
			proof(decrease, {
				status: 'COMMITTED',
				releaseFence: true,
				period: period(2)
			})
		);
	} finally {
		resumeResolve();
	}
	await admissionResult;
	assert.equal(
		(
			await prisma.crmAdmission.findUniqueOrThrow({
				where: { id: waiting.id }
			})
		).status,
		'WAITING'
	);
	assert.equal(
		(
			await prisma.crmWorkspaceMember.findUniqueOrThrow({
				where: { id: pending.id }
			})
		).disabledAt !== null,
		true
	);
	assert.equal(
		await prisma.crmWorkspaceMember.count({
			where: { workspaceId: raceWorkspace, disabledAt: null }
		}),
		1
	);
	assert.equal(active.workspaceId, raceWorkspace);
	await assert.rejects(
		service.prepare(
			'WINCRM_CHECKOUT',
			command({ workspaceId, totalSeats: 1 })
		),
		error => Boolean(error)
	);

	phase = 'schema-and-least-privilege';
	for (const table of ['crm_billing_capacity', 'crm_billing_operations']) {
		await assert.rejects(
			prisma.$executeRawUnsafe(
				`DELETE FROM crm_access.${table} WHERE false`
			),
			denial
		);
		await assert.rejects(
			prisma.$executeRawUnsafe(`TRUNCATE crm_access.${table}`),
			denial
		);
	}
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'UPDATE crm_access.crm_team_command_receipts SET request_hash=request_hash WHERE false'
		),
		denial
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'UPDATE crm_access.crm_team_audit SET action=action WHERE false'
		),
		denial
	);
	await assert.rejects(
		prisma.$executeRaw`UPDATE crm_access.crm_billing_operations SET actor_subject='forged' WHERE command_id=${op.commandId}::uuid`,
		error => error?.meta?.code === '23514'
	);
	await assert.rejects(
		prisma.$executeRaw`UPDATE crm_access.crm_billing_operations SET state='PENDING' WHERE command_id=${op.commandId}::uuid`,
		error => error?.meta?.code === '23514'
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'CREATE TABLE crm_access.billing_runtime_ddl_must_fail(id integer)'
		),
		denial
	);
	console.log(
		'PASS WinCRM Access billing PostgreSQL18: concurrent reservation/replay, global command binding, scheduled fences, DB-clock recovery, confirmed ceiling versus stale real admission, close/tombstone, post-insert rollback, least privileges and immutable bindings'
	);
} catch (error) {
	console.error(
		JSON.stringify({
			phase,
			name: error?.name,
			code: error?.code,
			sqlState: error?.meta?.code,
			assertion: error?.operator
		})
	);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
function required(name) {
	const value = process.env[name]?.trim();
	assert.ok(value, `${name} is required`);
	return value;
}
