import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/crm-access-client');
const { CrmTeamService } = require('../../dist/src/team/team.service.js');
const {
	CrmAssigneeService
} = require('../../dist/src/team/team-assignee.service.js');
const {
	CrmEmployeeProfileService
} = require('../../dist/src/team/team-profile.service.js');
const {
	CrmWorkspaceBrandingService
} = require('../../dist/src/branding/workspace-branding.service.js');
const {
	CrmTeamAdmissionService
} = require('../../dist/src/team/team-admission.service.js');
const {
	CrmTeamWorkerService
} = require('../../dist/src/team/team-worker.service.js');
const {
	CrmTeamOutboxService
} = require('../../dist/src/team/team-outbox.service.js');
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
	teams,
	{ syncPending: async () => undefined }
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
	// Optional CRM-owned branding: no backfill, exact command receipts, SQL CAS,
	// least-privilege writes and no extra copies of the name in local audit.
	const branding = new CrmWorkspaceBrandingService(prisma, auth);
	const brandingCommand = data =>
		command({
			expectedActorSubject: ownerSubject,
			expectedVersion: 0,
			displayName: ' Cafe\u0301 ',
			...data
		});
	assert.deepEqual(
		await branding.get('Bearer local-test', { workspaceId }),
		{
			schemaVersion: 1,
			workspaceId,
			subject: ownerSubject,
			branding: { displayName: null, version: 0, updatedAt: null }
		}
	);
	const initialBranding = brandingCommand();
	const brandingResults = await Promise.all([
		branding.update('Bearer local-test', initialBranding),
		branding.update('Bearer local-test', initialBranding)
	]);
	assert.deepEqual(brandingResults[0], brandingResults[1]);
	assert.equal(brandingResults[0].branding.displayName, 'Café');
	assert.equal(brandingResults[0].branding.version, 1);
	assert.equal(brandingResults[0].subject, ownerSubject);
	assert.equal(brandingResults[0].commandId, initialBranding.commandId);
	assert.equal(
		await prisma.crmTeamCommandReceipt.count({
			where: { commandId: initialBranding.commandId }
		}),
		1
	);
	const brandingAudit = await prisma.crmTeamAudit.findUniqueOrThrow({
		where: { commandId: initialBranding.commandId }
	});
	assert.deepEqual(brandingAudit.before, { version: 0 });
	assert.deepEqual(brandingAudit.after, { version: 1, changed: true });
	assert.equal(brandingAudit.action, 'WORKSPACE_BRANDING_UPDATED');
	assert.equal(JSON.stringify(brandingAudit).includes('Café'), false);
	await assert.rejects(
		branding.update('Bearer local-test', {
			...initialBranding,
			displayName: 'Other'
		}),
		error =>
			error.status === 409 &&
			error.response.code === 'crm_branding_command_conflict'
	);
	const competingCommands = [
		brandingCommand({ expectedVersion: 1, displayName: 'First' }),
		brandingCommand({ expectedVersion: 1, displayName: 'Second' })
	];
	const competingBranding = await Promise.allSettled(
		competingCommands.map(dto => branding.update('Bearer local-test', dto))
	);
	assert.equal(
		competingBranding.filter(result => result.status === 'fulfilled')
			.length,
		1
	);
	const lostBrandingIndex = competingBranding.findIndex(
		result => result.status === 'rejected'
	);
	assert.equal(
		competingBranding[lostBrandingIndex].reason.response.code,
		'crm_branding_version_conflict'
	);
	assert.equal(
		await prisma.crmTeamCommandReceipt.count({
			where: { commandId: competingCommands[lostBrandingIndex].commandId }
		}),
		0
	);
	assert.equal(
		await prisma.crmTeamAudit.count({
			where: { commandId: competingCommands[lostBrandingIndex].commandId }
		}),
		0
	);
	const clearedBranding = await branding.update(
		'Bearer local-test',
		brandingCommand({ expectedVersion: 2, displayName: null })
	);
	assert.equal(clearedBranding.branding.version, 3);
	assert.equal(clearedBranding.branding.displayName, null);
	await assert.rejects(
		branding.update('Bearer local-test', brandingCommand()),
		error => error.status === 409
	);
	const unicodeBranding = await branding.update(
		'Bearer local-test',
		brandingCommand({ expectedVersion: 3, displayName: '😀'.repeat(40) })
	);
	assert.equal(unicodeBranding.branding.version, 4);
	assert.equal(unicodeBranding.branding.displayName, '😀'.repeat(40));
	await assert.rejects(
		branding.update(
			'Bearer local-test',
			brandingCommand({ expectedVersion: 4, displayName: '😀'.repeat(41) })
		),
		error => error.status === 400
	);
	actor.state = 'READ_ONLY';
	assert.equal(
		(await branding.get('Bearer local-test', { workspaceId })).branding
			.version,
		4
	);
	await assert.rejects(
		branding.update('Bearer local-test', initialBranding),
		error => error.status === 403
	);
	actor.state = 'ACTIVE';
	await assert.rejects(
		branding.update(
			'Bearer local-test',
			brandingCommand({
				expectedActorSubject: 'foreign-actor',
				expectedVersion: 4
			})
		),
		error => error.status === 403
	);

	// The mutation must observe a lifecycle change committed while it awaited
	// the existing workspace lock, even if the initial authority was ACTIVE.
	let releaseBrandingLock;
	let lockedBrandingWorkspace;
	const brandingLockHeld = new Promise(resolve => {
		lockedBrandingWorkspace = resolve;
	});
	const releaseBranding = new Promise(resolve => {
		releaseBrandingLock = resolve;
	});
	const lockingBrandingChange = prisma.$transaction(async tx => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-team:${workspaceId}`}, 0))`;
		await tx.crmWorkspaceAccess.update({
			where: { workspaceId },
			data: { lifecycle: 'READ_ONLY' }
		});
		lockedBrandingWorkspace();
		await releaseBranding;
	});
	await brandingLockHeld;
	let initialBrandingAuthority;
	const brandingAuthorityChecked = new Promise(resolve => {
		initialBrandingAuthority = resolve;
	});
	const waitingBranding = new CrmWorkspaceBrandingService(prisma, {
		authorize: async (...args) => {
			const value = await auth.authorize(...args);
			initialBrandingAuthority();
			return value;
		}
	});
	const deniedWaitingBranding = assert.rejects(
		waitingBranding.update(
			'Bearer local-test',
			brandingCommand({ expectedVersion: 4 })
		),
		error => error.status === 403
	);
	try {
		await brandingAuthorityChecked;
		let observedBrandingWait = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			const [waiting] =
				await prisma.$queryRaw`SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = current_database() AND a.usename = current_user) AS present`;
			if (waiting.present) {
				observedBrandingWait = true;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 10));
		}
		assert.equal(
			observedBrandingWait,
			true,
			'branding must await the workspace lock before it is released'
		);
	} finally {
		releaseBrandingLock();
	}
	await lockingBrandingChange;
	await deniedWaitingBranding;
	await prisma.crmWorkspaceAccess.update({
		where: { workspaceId },
		data: { lifecycle: 'ACTIVE' }
	});
	assert.equal(
		(await branding.get('Bearer local-test', { workspaceId })).branding
			.version,
		4
	);
	for (const invalidName of [
		'',
		'<brand>',
		'a\nb',
		'e\u0301',
		'\u2028Brand',
		'x'.repeat(41)
	])
		await assert.rejects(
			prisma.$executeRaw`UPDATE crm_access.crm_workspace_branding SET display_name = ${invalidName} WHERE workspace_id = ${workspaceId}::uuid`
		);
	await assert.rejects(
		prisma.$executeRaw`UPDATE crm_access.crm_workspace_branding SET version = 0 WHERE workspace_id = ${workspaceId}::uuid`
	);
	await assert.rejects(
		prisma.crmWorkspaceBranding.create({
			data: { workspaceId: randomUUID(), displayName: 'Foreign' }
		})
	);
	assert.equal(
		(await branding.get('Bearer local-test', { workspaceId })).branding
			.displayName,
		'😀'.repeat(40)
	);
	console.log(
		'PASS CRM workspace branding PG18: optional state, Unicode, concurrent replay/CAS, clear version, fresh locked authority, READ_ONLY, audit and constraints'
	);

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
			ttlDays: 7,
			...(index === 0
				? {
						profile: {
							firstName: 'Иван',
							lastName: 'Петров',
							middleName: 'Иванович'
						}
					}
				: {})
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
		await prisma.crmEmployeeProfile.count({ where: { workspaceId } }),
		0,
		'Pending invitation names do not create an active employee profile'
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
	const admittedProfile =
		await prisma.crmEmployeeProfile.findUniqueOrThrow({
			where: {
				workspaceId_subject: {
					workspaceId,
					subject: invited[0].proof.subject
				}
			}
		});
	assert.equal(admittedProfile.firstName, 'Иван');
	assert.equal(admittedProfile.lastName, 'Петров');
	assert.equal(admittedProfile.middleName, 'Иванович');
	assert.equal(
		await prisma.crmEmployeeProfile.count({ where: { workspaceId } }),
		1,
		'Legacy accepted invitations keep no invented employee profile'
	);
	const namedDirectory = await teams.members('Bearer local-test', {
		workspaceId,
		page: 1,
		pageSize: 100
	});
	assert.equal(
		namedDirectory.items.find(
			item => item.subject === invited[0].proof.subject
		).displayName,
		'Петров Иван Иванович'
	);
	assert.equal(
		namedDirectory.items.find(
			item => item.subject === invited[1].proof.subject
		).displayName,
		null
	);
	const profiles = new CrmEmployeeProfileService(prisma, auth);
	const ownerProfileCommand = command({
		subject: ownerSubject,
		expectedVersion: 0,
		profile: { firstName: 'Анна', lastName: 'Соколова' }
	});
	const membersBeforeProfileEdit =
		await prisma.crmWorkspaceMember.findMany({
			where: { workspaceId },
			orderBy: { id: 'asc' }
		});
	const profileResults = await Promise.all([
		profiles.update('Bearer local-test', ownerProfileCommand),
		profiles.update('Bearer local-test', ownerProfileCommand)
	]);
	assert.deepEqual(profileResults[0], profileResults[1]);
	assert.equal(profileResults[0].profile.version, 1);
	assert.equal(
		await prisma.crmTeamAudit.count({
			where: { commandId: ownerProfileCommand.commandId }
		}),
		1
	);
	await assert.rejects(
		profiles.update('Bearer local-test', {
			...ownerProfileCommand,
			profile: { firstName: 'Изменено', lastName: 'Соколова' }
		}),
		error => error.status === 409
	);
	const competingProfiles = await Promise.allSettled(
		['Анна', 'Мария'].map(firstName =>
			profiles.update(
				'Bearer local-test',
				command({
					subject: ownerSubject,
					expectedVersion: 1,
					profile: { firstName, lastName: 'Соколова' }
				})
			)
		)
	);
	assert.equal(
		competingProfiles.filter(result => result.status === 'fulfilled')
			.length,
		1
	);
	assert.equal(
		competingProfiles.filter(
			result =>
				result.status === 'rejected' && result.reason.status === 409
		).length,
		1
	);
	assert.equal(
		(await profiles.get('Bearer local-test', { workspaceId })).profile
			.version,
		2
	);
	assert.deepEqual(
		await prisma.crmWorkspaceMember.findMany({
			where: { workspaceId },
			orderBy: { id: 'asc' }
		}),
		membersBeforeProfileEdit,
		'Employee names never change memberships, roles, assignments or seat usage'
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
	// Real PostgreSQL retry boundary; transport double is not a broker/image proof.
	const retryEvent = {
		schemaVersion: 1,
		eventId: randomUUID(),
		eventType: 'crm.access.admission-wake.v1',
		workspaceId,
		occurredAt: new Date().toISOString()
	};
	const retryMessage = (messageId = retryEvent.eventId, headers = {}) => ({
		content: Buffer.from(JSON.stringify(retryEvent)),
		properties: {
			messageId,
			headers,
			contentType: 'application/json',
			type: retryEvent.eventType
		}
	});
	let ready = false,
		retryCalls = 0,
		retryAcks = 0;
	const retryWorker = new CrmTeamWorkerService(
		prisma,
		{ workerEnabled: true },
		{
			ack: () => {
				retryAcks++;
			}
		},
		{
			admitNext: async () => {
				retryCalls++;
				if (!ready) throw new Error('SYNTHETIC_DEPENDENCY_UNAVAILABLE');
			}
		}
	);
	await retryWorker.handle('admission', retryMessage());
	const retryReceipt = await prisma.crmTeamDelivery.findUniqueOrThrow({
		where: {
			eventId_consumer: {
				eventId: retryEvent.eventId,
				consumer: 'admission'
			}
		}
	});
	assert.equal(retryReceipt.status, 'RETRY_SCHEDULED');
	assert.equal(retryAcks, 1);
	const retries = await prisma.crmTeamOutbox.findMany({
		where: {
			deduplicationKey: { startsWith: `retry:${retryReceipt.id}:` }
		}
	});
	assert.equal(retries.length, 1);
	const retryRow = retries[0];
	assert.equal(retryRow.exchange, 'winwidget.manual-retry');
	assert.equal(retryRow.routingKey, 'crm-access.team.admission');
	assert.ok(
		retryRow.availableAt.getTime() - retryRow.createdAt.getTime() >= 29000
	);
	const scopedOutbox = id => ({
		crmTeamOutbox: {
			findFirst: query =>
				prisma.crmTeamOutbox.findFirst({
					...query,
					where: { AND: [query.where, { id }] }
				}),
			updateMany: query => prisma.crmTeamOutbox.updateMany(query)
		}
	});
	const publications = [];
	const retryTransport = {
		publish: async (exchange, route, payload, options) => {
			publications.push({ exchange, route });
			assert.equal(exchange, 'winwidget.manual-retry');
			assert.equal(route, 'crm-access.team.admission');
			assert.deepEqual(payload, retryEvent);
			await retryWorker.handle(
				'admission',
				retryMessage(options.messageId, options.headers)
			);
		}
	};
	const earlyPublisher = new CrmTeamOutboxService(
		scopedOutbox(retryRow.id),
		{},
		retryTransport
	);
	assert.equal(await earlyPublisher.publishOne(), false);
	assert.equal(publications.length, 0);
	ready = true;
	// Recreate the publisher object: scheduling remains in PostgreSQL, not memory.
	const restartedPublisher = new CrmTeamOutboxService(
		scopedOutbox(retryRow.id),
		{},
		retryTransport
	);
	await new Promise(resolve =>
		setTimeout(
			resolve,
			Math.max(0, retryRow.availableAt.getTime() - Date.now()) + 25
		)
	);
	assert.equal(await restartedPublisher.publishOne(), true);
	assert.equal(publications.length, 1);
	const deliveredRetry = await prisma.crmTeamOutbox.findUniqueOrThrow({
		where: { id: retryRow.id }
	});
	assert.equal(deliveredRetry.status, 'PUBLISHED');
	assert.equal(
		deliveredRetry.availableAt.getTime(),
		retryRow.availableAt.getTime()
	);
	assert.ok(deliveredRetry.publishedAt >= retryRow.availableAt);
	assert.equal(await restartedPublisher.publishOne(), false);
	await retryWorker.handle(
		'admission',
		retryMessage(retryRow.messageId, retryRow.headers)
	);
	assert.equal(retryCalls, 2); // One failed attempt, one success; no replay effect.
	assert.equal(retryAcks, 3);
	assert.equal(
		(
			await prisma.crmTeamDelivery.findUniqueOrThrow({
				where: { id: retryReceipt.id }
			})
		).status,
		'DELIVERED'
	);

	const legacyNow = new Date();
	const legacy = await prisma.crmTeamOutbox.create({
		data: {
			messageId: randomUUID(),
			deduplicationKey: `legacy:${randomUUID()}`,
			eventType: retryEvent.eventType,
			payload: retryEvent,
			headers: retryRow.headers,
			exchange: 'winwidget.retry',
			routingKey: 'crm-access.team.admission.retry.1',
			createdAt: legacyNow,
			availableAt: legacyNow
		}
	});
	const legacyTransport = {
		publish: async () => {
			throw new Error('LEGACY_MUST_REMAIN_DEFERRED');
		}
	};
	const legacyPublisher = new CrmTeamOutboxService(
		scopedOutbox(legacy.id),
		{},
		legacyTransport
	);
	await legacyPublisher.publishOne();
	const converted = await prisma.crmTeamOutbox.findUniqueOrThrow({
		where: { id: legacy.id }
	});
	assert.equal(converted.status, 'PENDING');
	assert.equal(converted.exchange, 'winwidget.manual-retry');
	assert.equal(converted.routingKey, 'crm-access.team.admission');
	assert.equal(
		converted.availableAt.getTime(),
		legacyNow.getTime() + 30000
	);
	assert.equal(converted.messageId, legacy.messageId);
	assert.deepEqual(converted.headers, legacy.headers);
	assert.deepEqual(converted.payload, legacy.payload);
	assert.equal(converted.lastError, null);
	assert.equal(await legacyPublisher.publishOne(), false);
	const expiredLegacy = await prisma.crmTeamOutbox.create({
		data: {
			messageId: randomUUID(),
			deduplicationKey: `expired-legacy:${randomUUID()}`,
			eventType: retryEvent.eventType,
			payload: retryEvent,
			headers: retryRow.headers,
			exchange: 'winwidget.retry',
			routingKey: 'crm-access.team.admission.retry.1',
			createdAt: new Date(Date.now() - 60000),
			availableAt: new Date(Date.now() - 1000),
			status: 'PROCESSING',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() - 1000)
		}
	});
	let legacyPublishes = 0;
	const recoveredPublisher = new CrmTeamOutboxService(
		scopedOutbox(expiredLegacy.id),
		{},
		{
			publish: async (exchange, route, payload, options) => {
				legacyPublishes++;
				assert.equal(exchange, 'winwidget.manual-retry');
				assert.equal(route, 'crm-access.team.admission');
				assert.equal(options.messageId, expiredLegacy.messageId);
				assert.deepEqual(options.headers, expiredLegacy.headers);
				assert.deepEqual(payload, expiredLegacy.payload);
			}
		}
	);
	assert.equal(await recoveredPublisher.publishOne(), true);
	assert.equal(legacyPublishes, 1);
	assert.equal(
		(
			await prisma.crmTeamOutbox.findUniqueOrThrow({
				where: { id: expiredLegacy.id }
			})
		).status,
		'PUBLISHED'
	);
	const publishedLegacy = await prisma.crmTeamOutbox.create({
		data: {
			messageId: randomUUID(),
			deduplicationKey: `published-legacy:${randomUUID()}`,
			eventType: retryEvent.eventType,
			payload: retryEvent,
			headers: retryRow.headers,
			exchange: 'winwidget.retry',
			routingKey: 'crm-access.team.admission.retry.1',
			createdAt: new Date(Date.now() - 60000),
			availableAt: new Date(Date.now() - 1000),
			status: 'PUBLISHED',
			publishedAt: new Date(Date.now() - 30000)
		}
	});
	assert.equal(
		await new CrmTeamOutboxService(
			scopedOutbox(publishedLegacy.id),
			{},
			legacyTransport
		).publishOne(),
		false
	);
	assert.deepEqual(
		await prisma.crmTeamOutbox.findUniqueOrThrow({
			where: { id: publishedLegacy.id }
		}),
		publishedLegacy
	);
	for (const table of [
		'crm_workspace_members',
		'crm_workspace_branding',
		'crm_employee_profiles',
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
	// The Intake lookup uses real owner SQL, not a mock directory or client IDs.
	const lookupTeams = Array.from({ length: 21 }, (_, index) => ({
		id: randomUUID(),
		workspaceId,
		name: `Lookup ${String(index).padStart(2, '0')}`
	}));
	const archived = {
		id: randomUUID(),
		workspaceId,
		name: 'Archived lookup',
		archivedAt: new Date()
	};
	const foreign = {
		id: randomUUID(),
		workspaceId: randomUUID(),
		name: 'Foreign lookup'
	};
	const unassigned = {
		id: randomUUID(),
		workspaceId,
		name: 'Other department'
	};
	await prisma.crmWorkspaceAccess.create({
		data: {
			workspaceId: foreign.workspaceId,
			activatedBySubject: `lookup-foreign-owner-${randomUUID()}`,
			billingEntitlementId: randomUUID(),
			provisioningCommandId: randomUUID(),
			provisioningCommandType: 'START_TRIAL'
		}
	});
	await prisma.crmTeam.createMany({
		data: [...lookupTeams, archived, foreign, unassigned]
	});
	actor = {
		...actor,
		role: 'MANAGER',
		state: 'READ_ONLY',
		permissions: ['intake:read'],
		teamIds: [...lookupTeams, archived, foreign].map(item => item.id)
	};
	const lookupQuery = {
		workspaceId,
		page: 2,
		pageSize: 20,
		selectedId: lookupTeams[0].id
	};
	const lookup = await teams.options('Bearer local-test', lookupQuery);
	assert.equal(lookup.total, 21);
	assert.deepEqual(lookup.items, [
		{ id: lookupTeams[20].id, name: lookupTeams[20].name }
	]);
	assert.deepEqual(lookup.selected, {
		id: lookupTeams[0].id,
		name: lookupTeams[0].name
	});
	for (const selectedId of [
		archived.id,
		foreign.id,
		unassigned.id,
		randomUUID()
	]) {
		assert.equal(
			(
				await teams.options('Bearer local-test', {
					...lookupQuery,
					selectedId
				})
			).selected,
			null
		);
	}
	await assert.rejects(
		teams.teams('Bearer local-test', lookupQuery),
		error => error.status === 403
	);
	actor = { ...actor, teamIds: [] };
	assert.deepEqual(await teams.options('Bearer local-test', lookupQuery), {
		schemaVersion: 1,
		workspaceId,
		subject: ownerSubject,
		page: 2,
		pageSize: 20,
		total: 0,
		items: [],
		selected: null
	});
	// Real Access predicates, membership joins and profile search; Identity
	// transport is a scoped active-binding double, tested separately on PG18.
	const pickerMembers = Array.from({ length: 4 }, (_, index) => ({
		id: randomUUID(),
		workspaceId,
		subject: `picker-${index}-${randomUUID()}`,
		membershipId: randomUUID(),
		role: index === 0 ? 'TEAM_LEAD' : 'MANAGER',
		disabledAt: index === 3 ? new Date() : null
	}));
	await prisma.crmWorkspaceMember.createMany({ data: pickerMembers });
	await prisma.crmMemberTeam.createMany({
		data: pickerMembers.map((member, index) => ({
			workspaceId,
			memberId: member.id,
			teamId: index === 2 ? unassigned.id : lookupTeams[0].id
		}))
	});
	await prisma.crmEmployeeProfile.createMany({
		data: pickerMembers.map((member, index) => ({
			workspaceId,
			subject: member.subject,
			firstName: 'Иван',
			lastName: index === 1 ? 'Петров' : 'Сидоров'
		}))
	});
	const currentBindings = new Map(
		pickerMembers.map(member => [member.membershipId, member.subject])
	);
	let pickerActor = {
		schemaVersion: 1,
		workspaceId,
		subject: pickerMembers[0].subject,
		role: 'TEAM_LEAD',
		state: 'ACTIVE',
		dataScope: 'TEAM',
		teamIds: [lookupTeams[0].id],
		permissions: ['sales:read', 'sales:write']
	};
	const picker = new CrmAssigneeService(
		prisma,
		{
			authorize: async () => ({ ...pickerActor }),
			assignmentSubject: async (_workspaceId, subject) => {
				const member = pickerMembers.find(
					item => item.subject === subject
				);
				return {
					...pickerActor,
					subject,
					membershipId: member.membershipId,
					role: member.role,
					dataScope: member.role === 'MANAGER' ? 'OWN' : 'TEAM'
				};
			}
		},
		{
			assignees: async (_workspaceId, members) =>
				members
					.filter(
						item => currentBindings.get(item.membershipId) === item.subject
					)
					.map(item => ({
						membershipId: item.membershipId,
						subject: item.subject,
						workspaceRole: 'MEMBER',
						displayName: 'Legacy picker name',
						verifiedEmail: null
					}))
		}
	);
	const pickerQuery = { workspaceId, page: 1, pageSize: 1 };
	const firstPage = await picker.options('Bearer local-test', pickerQuery);
	assert.equal(firstPage.total, 2);
	assert.equal(firstPage.items.length, 1);
	assert.equal(
		(
			await picker.options('Bearer local-test', {
				...pickerQuery,
				search: 'петров ИВАН'
			})
		).items[0].subject,
		pickerMembers[1].subject
	);
	for (const hidden of [pickerMembers[2], pickerMembers[3]])
		assert.equal(
			(
				await picker.options('Bearer local-test', {
					...pickerQuery,
					selectedSubject: hidden.subject
				})
			).selected,
			null
		);
	const bindingCommand = {
		schemaVersion: 1,
		purpose: 'SALES_ASSIGNMENT',
		workspaceId,
		subject: pickerMembers[1].subject,
		membershipId: pickerMembers[1].membershipId,
		teamId: lookupTeams[0].id
	};
	assert.equal(
		(await picker.authorize('Bearer local-test', bindingCommand)).assignee
			.subject,
		pickerMembers[1].subject
	);
	currentBindings.delete(pickerMembers[1].membershipId);
	assert.equal(
		(await picker.options('Bearer local-test', pickerQuery)).total,
		1
	);
	await prisma.crmWorkspaceMember.update({
		where: { id: pickerMembers[1].id },
		data: { disabledAt: new Date() }
	});
	await assert.rejects(
		picker.authorize('Bearer local-test', bindingCommand),
		error => error.status === 404
	);
	pickerActor = {
		...pickerActor,
		state: 'READ_ONLY',
		permissions: ['sales:read']
	};
	assert.equal(
		(await picker.options('Bearer local-test', pickerQuery)).total,
		1
	);
	await assert.rejects(
		picker.authorize('Bearer local-test', bindingCommand),
		error => error.status === 403
	);
	console.log(
		'PASS CRM assignee PG18: scoped department selection, FIO, pagination, current binding, disabled exclusion and READ_ONLY'
	);

	console.log(
		'PASS WinCRM team PostgreSQL18: least privilege, page directory binding, scoped department names and selected pagination, archive/foreign/revoked exclusion, parallel command/acceptance replay, FIFO Trial quota including owner, disabled/pending no seat, tenant joins, read-only deny, revoke race, receipt-before-effect, real 30s durable retry across publisher recreation, replay, unpublished legacy conversion (transport double)'
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
