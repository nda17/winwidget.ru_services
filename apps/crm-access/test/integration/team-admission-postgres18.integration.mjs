import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-access-client');
const { CrmTeamService } = require('../../dist/src/team/team.service.js');
const {
	CrmTeamAdmissionService
} = require('../../dist/src/team/team-admission.service.js');
const {
	CrmTeamWorkerService
} = require('../../dist/src/team/team-worker.service.js');
assert.equal(process.env.CRM_ACCESS_INTEGRATION_ALLOW_MUTATION, 'true');
const databaseUrl = required('CRM_ACCESS_TEST_DATABASE_URL');
const runtimeRole = required('CRM_ACCESS_TEST_RUNTIME_ROLE');
const url = new URL(databaseUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.match(url.pathname, /^\/winwidget_crm_access_test(?:_[a-z0-9]+)*$/);
assert.equal(decodeURIComponent(url.username), runtimeRole);
assert.equal(url.searchParams.get('schema'), 'crm_access');
const prisma = new PrismaClient({
	datasources: { db: { url: databaseUrl } }
});
const workspaceId = randomUUID();
const ownerSubject = `team-owner-${randomUUID()}`;
let actor = {
	workspaceId,
	subject: ownerSubject,
	role: 'OWNER',
	state: 'ACTIVE',
	permissions: [
		'access:read-team',
		'access:manage-team',
		'access:revoke-access'
	]
};
let entitlement;
const auth = {
	authorize: async (_token, id) => {
		assert.equal(id, workspaceId);
		return { ...actor };
	},
	authorizeSubject: async (id, subject) => {
		assert.equal(id, workspaceId);
		assert.equal(subject, ownerSubject);
		return { ...actor };
	}
};
const billing = {
	get: async id => {
		assert.equal(id, workspaceId);
		return {
			schemaVersion: 1,
			workspaceId,
			status: actor.state === 'READ_ONLY' ? 'READ_ONLY' : 'ACTIVE',
			entitlement
		};
	}
};
const proofs = new Map();
const identities = new Map();
const identity = {
	sourceContext: async (id, subject) => {
		assert.equal(id, workspaceId);
		return {
			subject,
			membership: {
				workspaceId,
				membershipId: identities.get(subject),
				role: 'MEMBER'
			}
		};
	}
};
const invitations = {
	create: async intent => ({
		version: 1,
		id: intent.id,
		status: 'PENDING'
	}),
	revoke: async () => ({ status: 'REVOKED' }),
	acceptance: async id => {
		assert.ok(proofs.has(id));
		return proofs.get(id);
	},
	directory: async (id, members) => {
		assert.equal(id, workspaceId);
		return members.map(member => ({
			membershipId: member.membershipId,
			subject: member.subject,
			displayName: null,
			verifiedEmail: null
		}));
	}
};
const teams = new CrmTeamService(prisma, auth, billing, invitations);
const admission = new CrmTeamAdmissionService(
	prisma,
	auth,
	billing,
	identity,
	invitations,
	teams
);
const command = data => ({
	schemaVersion: 1,
	commandId: randomUUID(),
	workspaceId,
	...data
});

try {
	const [role] =
		await prisma.$queryRaw`SELECT current_user AS name, current_setting('server_version_num')::integer AS version, NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin AS restricted, pg_get_userbyid(nspowner) <> current_user AS not_owner, NOT has_database_privilege(current_user, current_database(), 'CREATE') AS no_db_create, NOT has_schema_privilege(current_user, 'foreign_service_guard', 'USAGE') AS no_foreign FROM pg_roles JOIN pg_namespace ON nspname = 'crm_access' WHERE rolname = current_user`;
	assert.equal(role.name, runtimeRole);
	assert.equal(role.restricted, true);
	assert.equal(role.not_owner, true);
	assert.equal(role.no_db_create, true);
	assert.equal(role.no_foreign, true);
	assert.ok(role.version >= 180000 && role.version < 190000);
	await denied('SELECT id FROM foreign_service_guard.sentinel LIMIT 1');
	const now = new Date();
	const entitlementId = randomUUID();
	entitlement = {
		id: entitlementId,
		seatLimit: 5,
		policyVersion: 1,
		effectiveUntil: new Date(Date.now() + 5 * 86400000).toISOString(),
		graceUntil: new Date(Date.now() + 8 * 86400000).toISOString()
	};
	await prisma.crmWorkspaceAccess.create({
		data: {
			workspaceId,
			lifecycle: 'ACTIVE',
			activatedBySubject: ownerSubject,
			billingEntitlementId: entitlementId,
			provisioningCommandId: randomUUID(),
			provisioningCommandType: 'START_TRIAL',
			onboardingCommandId: randomUUID(),
			onboardingTemplateKey: 'universal-sales',
			onboardingTemplateVersion: 1,
			onboardingTemplateFingerprint: 'a'.repeat(64),
			onboardingPipelineId: randomUUID(),
			onboardingCompletedAt: now
		}
	});
	const createTeam = command({ name: 'Отдел продаж' });
	const teamResults = await Promise.all([
		teams.createTeam('Bearer local-test', createTeam),
		teams.createTeam('Bearer local-test', createTeam)
	]);
	assert.deepEqual(teamResults[0], teamResults[1]);
	const teamId = teamResults[0].team.id;
	await assert.rejects(
		teams.createTeam('Bearer local-test', {
			...createTeam,
			name: 'Changed'
		}),
		error => error.status === 409
	);
	const invited = [];
	for (let index = 0; index < 6; index++) {
		const dto = command({
			email: `qa-${randomUUID()}@example.test`,
			role: 'MANAGER',
			teamIds: [teamId],
			ttlDays: 7
		});
		const result = await teams.invite('Bearer local-test', dto);
		assert.equal(result.invitation.status, 'REGISTERING');
		assert.deepEqual(await teams.invite('Bearer local-test', dto), result);
		await admission.provision(workspaceId, result.invitation.id);
		const subject = `member-${randomUUID()}`;
		const membershipId = randomUUID();
		identities.set(subject, membershipId);
		const proof = {
			id: randomUUID(),
			invitationId: result.invitation.id,
			invitationVersion: 2,
			workspaceId,
			productCode: 'WINCRM',
			subject,
			membershipId,
			acceptedAt: new Date().toISOString(),
			emailVerifiedAt: now.toISOString()
		};
		proofs.set(result.invitation.id, proof);
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			eventType: 'identity.wincrm.invitation-accepted.v1',
			invitationId: proof.invitationId,
			invitationVersion: 2,
			workspaceId,
			acceptanceId: proof.id,
			subject,
			membershipId,
			occurredAt: proof.acceptedAt
		};
		await Promise.all([admission.accept(event), admission.accept(event)]);
		invited.push({ result, proof, event });
	}
	assert.equal(
		await prisma.crmWorkspaceMember.count({ where: { workspaceId } }),
		0,
		'Pending acceptance never allocates a CRM seat'
	);
	assert.equal(
		await prisma.crmAdmission.count({
			where: { workspaceId, status: 'WAITING' }
		}),
		6
	);
	for (let step = 0; step < 6; step++)
		await Promise.all([
			admission.admitNext(workspaceId),
			admission.admitNext(workspaceId)
		]);
	assert.equal(
		await prisma.crmWorkspaceMember.count({
			where: { workspaceId, disabledAt: null }
		}),
		4,
		'Trial quota includes the immutable owner'
	);
	let rows = await prisma.crmAdmission.findMany({
		where: { workspaceId },
		orderBy: { position: 'asc' }
	});
	assert.deepEqual(
		rows.map(row => row.status),
		['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'WAITING', 'WAITING'],
		'Admission is FIFO and never overbooks'
	);
	const differentTeam = await teams.createTeam(
		'Bearer local-test',
		command({ name: 'Другой отдел' })
	);
	await assert.rejects(
		prisma.crmMemberTeam.create({
			data: {
				workspaceId: randomUUID(),
				memberId: rows[0].memberId,
				teamId: differentTeam.team.id
			}
		}),
		error => error.code === 'P2003'
	);
	let member = await prisma.crmWorkspaceMember.findUniqueOrThrow({
		where: { id: rows[0].memberId }
	});
	const disable = command({ expectedVersion: member.version });
	const disabled = await teams.disable(
		'Bearer local-test',
		member.id,
		disable
	);
	assert.deepEqual(
		await teams.disable('Bearer local-test', member.id, disable),
		disabled
	);
	await Promise.all([
		admission.admitNext(workspaceId),
		admission.admitNext(workspaceId)
	]);
	assert.equal(
		(
			await prisma.crmAdmission.findUniqueOrThrow({
				where: { id: rows[4].id }
			})
		).status,
		'ACTIVE'
	);
	assert.equal(
		(
			await prisma.crmAdmission.findUniqueOrThrow({
				where: { id: rows[5].id }
			})
		).status,
		'WAITING'
	);
	const enable = await teams.enable(
		'Bearer local-test',
		member.id,
		command({ expectedVersion: disabled.member.version })
	);
	assert.equal(enable.admission.status, 'WAITING');
	assert.ok(
		(
			await prisma.crmWorkspaceMember.findUniqueOrThrow({
				where: { id: member.id }
			})
		).disabledAt,
		'Enable requests do not bypass older waiting admissions'
	);
	actor = { ...actor, state: 'READ_ONLY' };
	await assert.rejects(
		teams.disable(
			'Bearer local-test',
			member.id,
			command({ expectedVersion: disabled.member.version })
		),
		error => error.status === 403
	);
	await admission.admitNext(workspaceId);
	assert.equal(
		(
			await prisma.crmAdmission.findUniqueOrThrow({
				where: { id: rows[5].id }
			})
		).status,
		'WAITING'
	);
	assert.equal(
		(
			await teams.members('Bearer local-test', {
				workspaceId,
				page: 1,
				pageSize: 2
			})
		).items.length,
		2
	);
	actor = { ...actor, state: 'ACTIVE' };
	const firstWaitingIntent =
		await prisma.crmInvitationIntent.findUniqueOrThrow({
			where: { id: rows[5].intentId }
		});
	await teams.revokeInvitation(
		'Bearer local-test',
		firstWaitingIntent.id,
		command({ expectedVersion: firstWaitingIntent.version })
	);
	await admission.accept(invited[5].event);
	assert.equal(
		(
			await prisma.crmAdmission.findUniqueOrThrow({
				where: { id: rows[5].id }
			})
		).status,
		'CANCELLED',
		'Local revoke wins over a late accepted event'
	);
	const wake = {
		schemaVersion: 1,
		eventId: randomUUID(),
		eventType: 'crm.access.admission-wake.v1',
		workspaceId,
		occurredAt: new Date().toISOString()
	};
	let calls = 0;
	let ack = 0;
	const worker = new CrmTeamWorkerService(
		prisma,
		{ workerEnabled: true },
		{
			ack: () => {
				ack++;
			}
		},
		{
			admitNext: async () => {
				calls++;
			}
		}
	);
	const message = {
		content: Buffer.from(JSON.stringify(wake)),
		properties: {
			messageId: wake.eventId,
			contentType: 'application/json'
		}
	};
	await Promise.all([
		worker.handle('admission', message),
		worker.handle('admission', message)
	]);
	assert.equal(calls, 1);
	assert.equal(ack, 2);
	assert.equal(
		(
			await prisma.crmTeamDelivery.findUniqueOrThrow({
				where: {
					eventId_consumer: {
						eventId: wake.eventId,
						consumer: 'admission'
					}
				}
			})
		).status,
		'DELIVERED'
	);
	for (const table of [
		'crm_workspace_members',
		'crm_teams',
		'crm_invitation_intents',
		'crm_admissions',
		'crm_team_command_receipts',
		'crm_team_audit'
	]) {
		await denied(`DELETE FROM crm_access.${table} WHERE false`);
		await denied(`TRUNCATE crm_access.${table}`);
	}
	await denied(
		'UPDATE crm_access.crm_team_command_receipts SET request_hash = request_hash WHERE false'
	);
	await denied(
		'UPDATE crm_access.crm_team_audit SET action = action WHERE false'
	);
	await assert.rejects(
		prisma.$executeRawUnsafe(
			'CREATE TABLE crm_access.runtime_should_not_create(id integer)'
		),
		error => error?.meta?.code === '42501'
	);
	console.log(
		'PASS WinCRM team PostgreSQL18: least privilege, page directory binding, parallel command/acceptance replay, FIFO Trial quota including owner, disabled/pending no seat, tenant joins, read-only deny, revoke race, receipt-before-effect'
	);
} catch (error) {
	console.error(
		JSON.stringify({
			name: error?.name,
			code: error?.code,
			sqlState: error?.meta?.code,
			constraint: error?.meta?.field_name,
			message: String(error?.message || '')
				.split('\n')
				.slice(-4)
				.join(' ')
				.replace(
					/(?:postgres(?:ql)?|https?):\/\/[^\s]+/g,
					'[redacted-url]'
				)
				.slice(0, 600)
		})
	);
	process.exitCode = 1;
} finally {
	await prisma.$disconnect();
}
async function denied(sql) {
	await assert.rejects(
		prisma.$queryRawUnsafe(sql),
		error => error?.meta?.code === '42501'
	);
}
function required(name) {
	assert.ok(process.env[name]?.trim(), `${name} is required`);
	return process.env[name].trim();
}
