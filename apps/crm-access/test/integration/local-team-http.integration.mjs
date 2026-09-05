import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export function teamHttpBrokerEnvironment(environment, registerSecret) {
	try {
		const result = {};
		const urls = [
			'provisioner',
			'worker',
			'publisher',
			'identity_publisher'
		].map(kind => {
			const value =
				environment[
					`CRM_ACCESS_TEAM_HTTP_TEST_${kind.toUpperCase()}_RABBITMQ_URL`
				];
			if (value) registerSecret(value);
			const url = new URL(value);
			registerSecret(url.password);
			registerSecret(decodeURIComponent(url.password));
			assert.equal(url.protocol, 'amqp:');
			assert.equal(url.hostname, '127.0.0.1');
			assert.equal(url.port, '5673');
			assert.ok(url.username && url.password && !url.search && !url.hash);
			assert.match(
				decodeURIComponent(url.pathname),
				/^\/[a-z0-9_-]+_(test|ci)$/
			);
			result[kind] = value;
			return url;
		});
		assert.ok(urls.every(url => url.pathname === urls[0].pathname));
		assert.equal(
			new Set(urls.map(url => decodeURIComponent(url.username))).size,
			4
		);
		return result;
	} catch {
		throw new Error(
			'Team HTTP proof requires four distinct scoped principals on one loopback 127.0.0.1:5673 test vhost; values suppressed'
		);
	}
}

// Test-only composition of built owner classes; all authorization, invitation,
// entitlement and command calls use real local HTTP. No member/admission seed.
export async function verifyTeamHttp({
	servicesRoot,
	runId,
	apiUrl,
	accounts,
	identityDatabaseUrl,
	accessDatabaseUrl,
	accessEnvironment,
	broker,
	registerSecret,
	log
}) {
	let phase = 'admission';
	let identityDb, accessDb, inspector, inspectorChannel;
	let provisionRabbit, workerRabbit, accessRabbit, identityRabbit, worker;
	let accessPublisher, identityPublisher, releaseBarrier, barrier;
	const originalFetch = globalThis.fetch;
	const deadline = Date.now() + 120_000;
	const quiet = { log() {}, warn() {}, error() {} };
	const until = async check => {
		while (Date.now() < deadline) {
			const result = await check();
			if (result) return result;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error('Team HTTP proof deadline');
	};
	const request = async (path, { token, body, expected = 200 } = {}) => {
		const response = await fetch(apiUrl + path, {
			method: body ? 'POST' : 'GET',
			redirect: 'error',
			cache: 'no-store',
			signal: AbortSignal.timeout(15_000),
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body?.commandId ? { 'idempotency-key': body.commandId } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		});
		if (response.status !== expected) {
			await response.body?.cancel();
			const error = new Error('Unexpected team HTTP status');
			error.httpStatus = response.status;
			throw error;
		}
		const reader = response.body.getReader(),
			chunks = [];
		let length = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > 512 * 1024) {
				await reader.cancel();
				throw new Error('Team response bound');
			}
			chunks.push(Buffer.from(value));
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	};
	try {
		assert.match(runId, /^[a-f0-9]{10}$/);
		assert.equal(apiUrl, 'http://localhost:4100/api/v1');
		assert.equal(accounts.owner.userId, `wincrm-local-teamOwner-${runId}`);
		assert.equal(accounts.first.userId, `wincrm-local-inviteeA-${runId}`);
		assert.equal(accounts.second.userId, `wincrm-local-inviteeB-${runId}`);
		for (const [value, schema] of [
			[identityDatabaseUrl, 'identity'],
			[accessDatabaseUrl, 'crm_access']
		]) {
			const url = new URL(value);
			assert.equal(url.hostname, '127.0.0.1');
			assert.equal(url.port, '55440');
			assert.equal(
				url.pathname,
				`/winwidget_${schema}_test_browser_${runId}_test`
			);
			assert.equal(url.username, `wcrm_${schema}_r_${runId}`);
			assert.equal(url.searchParams.get('schema'), schema);
		}
		for (const value of Object.values(broker)) registerSecret(value);
		globalThis.fetch = (input, options) => {
			const url = new URL(input);
			assert.ok(
				[
					'http://localhost:4100',
					'http://127.0.0.1:4900',
					'http://127.0.0.1:4800'
				].includes(url.origin)
			);
			assert.equal(options?.redirect, 'error');
			return originalFetch(input, options);
		};
		const accessRequire = createRequire(
			join(servicesRoot, 'apps/crm-access/package.json')
		);
		const identityRequire = createRequire(
			join(servicesRoot, 'apps/identity/package.json')
		);
		accessRequire('reflect-metadata');
		const load = (path, name) =>
			accessRequire(join(servicesRoot, 'apps/crm-access/dist/src', path))[
				name
			];
		const identityLoad = (path, name) =>
			identityRequire(join(servicesRoot, 'apps/identity/dist/src', path))[
				name
			];
		const { ConfigService } = accessRequire('@nestjs/config');
		const { connect } = accessRequire('amqplib');
		const CrmAccessRuntimeService = load(
			'runtime/crm-access-runtime.service.js',
			'CrmAccessRuntimeService'
		);
		const CrmTeamRabbitService = load(
			'team/team-rabbit.service.js',
			'CrmTeamRabbitService'
		);
		const CrmTeamOutboxService = load(
			'team/team-outbox.service.js',
			'CrmTeamOutboxService'
		);
		const CrmTeamWorkerService = load(
			'team/team-worker.service.js',
			'CrmTeamWorkerService'
		);
		const CrmTeamService = load('team/team.service.js', 'CrmTeamService');
		const CrmTeamAdmissionService = load(
			'team/team-admission.service.js',
			'CrmTeamAdmissionService'
		);
		const CrmAuthorizationService = load(
			'authorization/crm-authorization.service.js',
			'CrmAuthorizationService'
		);
		const IdentityAuthContextClient = load(
			'internal/identity-auth-context.client.js',
			'IdentityAuthContextClient'
		);
		const IdentityInvitationClient = load(
			'internal/identity-invitation.client.js',
			'IdentityInvitationClient'
		);
		const BillingEntitlementClient = load(
			'internal/billing-entitlement.client.js',
			'BillingEntitlementClient'
		);
		const BillingCommerceClient = load(
			'billing/billing-commerce.client.js',
			'BillingCommerceClient'
		);
		const CrmBillingCapacityService = load(
			'billing/billing-capacity.service.js',
			'CrmBillingCapacityService'
		);
		const { TEAM_CONSUMERS, teamQueue } = accessRequire(
			join(
				servicesRoot,
				'apps/crm-access/dist/src/team/team-messaging.contract.js'
			)
		);
		const { workspaceLock } = accessRequire(
			join(servicesRoot, 'apps/crm-access/dist/src/team/team.util.js')
		);
		identityDb = new (identityRequire(
			'@prisma/identity-client'
		).PrismaClient)({
			datasources: { db: { url: identityDatabaseUrl } },
			log: []
		});
		accessDb = new (accessRequire(
			'@prisma/crm-access-client'
		).PrismaClient)({
			datasources: { db: { url: accessDatabaseUrl } },
			log: []
		});
		const workspaceId = accounts.owner.workspaceId;
		assert.equal(
			await accessDb.crmWorkspaceMember.count({ where: { workspaceId } }),
			0
		);
		assert.equal(
			await accessDb.crmAdmission.count({ where: { workspaceId } }),
			0
		);
		assert.equal(await identityDb.outboxEvent.count(), 0);
		const config = new ConfigService(accessEnvironment);
		const identity = new IdentityAuthContextClient(config),
			billing = new BillingEntitlementClient(config),
			invitations = new IdentityInvitationClient(config);
		const authority = new CrmAuthorizationService(
			identity,
			billing,
			accessDb
		);
		const team = new CrmTeamService(
			accessDb,
			authority,
			billing,
			invitations
		);
		const capacity = new CrmBillingCapacityService(
			accessDb,
			new BillingCommerceClient(config),
			identity
		);
		const admission = new CrmTeamAdmissionService(
			accessDb,
			authority,
			billing,
			identity,
			invitations,
			team,
			capacity
		);
		const accessRuntime = (role, url) => {
			const config = new ConfigService({
				...accessEnvironment,
				CRM_ACCESS_PROCESS_ROLE: role,
				CRM_ACCESS_PORT: role === 'worker' ? '5301' : '5302',
				RABBITMQ_URL: url,
				RABBITMQ_CONNECTION_NAME: `winwidget-crm-access-${role}`
			});
			const runtime = new CrmAccessRuntimeService(config),
				rabbit = new CrmTeamRabbitService(config, runtime);
			rabbit.logger = quiet;
			return { runtime, rabbit };
		};
		phase = 'scoped broker topology';
		inspector = await connect(broker.provisioner);
		inspector.on('error', () => {});
		inspectorChannel = await inspector.createConfirmChannel();
		provisionRabbit = accessRuntime('worker', broker.provisioner).rabbit;
		await provisionRabbit.onModuleInit();
		for (const consumer of TEAM_CONSUMERS) {
			const queue = await inspectorChannel.checkQueue(teamQueue(consumer));
			assert.equal(queue.messageCount, 0);
			assert.equal(queue.consumerCount, 0);
		}
		await provisionRabbit.onApplicationShutdown();
		provisionRabbit = null;
		const workerParts = accessRuntime('worker', broker.worker);
		workerRabbit = workerParts.rabbit;
		await workerRabbit.onModuleInit();
		worker = new CrmTeamWorkerService(
			accessDb,
			workerParts.runtime,
			workerRabbit,
			admission
		);
		worker.logger = quiet;
		await worker.onModuleInit();
		const publisherParts = accessRuntime(
			'outbox-publisher',
			broker.publisher
		);
		accessRabbit = publisherParts.rabbit;
		await accessRabbit.onModuleInit();
		accessPublisher = new CrmTeamOutboxService(
			accessDb,
			publisherParts.runtime,
			accessRabbit
		);
		accessPublisher.logger = quiet;
		const identityConfig = new (identityRequire(
			'@nestjs/config'
		).ConfigService)({
			IDENTITY_PROCESS_ROLE: 'outbox-publisher',
			RABBITMQ_URL: broker.identity_publisher,
			RABBITMQ_CONNECTION_NAME: 'winwidget-identity-outbox-publisher',
			RABBITMQ_ASSERT_TOPOLOGY: 'false'
		});
		const IdentityRuntimeService = identityLoad(
			'runtime/identity-runtime.service.js',
			'IdentityRuntimeService'
		);
		const IdentityRabbitMqService = identityLoad(
			'messaging/rabbitmq.service.js',
			'IdentityRabbitMqService'
		);
		const IdentityOutboxPublisherService = identityLoad(
			'messaging/outbox-publisher.service.js',
			'IdentityOutboxPublisherService'
		);
		const identityRuntime = new IdentityRuntimeService(identityConfig);
		identityRabbit = new IdentityRabbitMqService(
			identityConfig,
			identityRuntime
		);
		identityRabbit.logger = quiet;
		await identityRabbit.onModuleInit();
		identityPublisher = new IdentityOutboxPublisherService(
			identityDb,
			identityRuntime,
			identityRabbit
		);
		identityPublisher.logger = quiet;
		const pump = async () => {
			await Promise.all([
				accessPublisher.publishOne(),
				identityPublisher.publishOne()
			]);
		};
		const settled = async check =>
			until(async () => {
				await pump();
				return check();
			});
		phase = 'real login and Trial';
		const sessions = {};
		for (const [key, account] of Object.entries(accounts)) {
			phase = `real login (${key})`;
			const session = await request('/auth/login', {
				body: { email: account.email, password: account.password }
			});
			assert.equal(session.user.id, account.userId);
			assert.ok(session.accessToken?.length > 100);
			registerSecret(session.accessToken);
			sessions[key] = session.accessToken;
		}
		const command = data => ({
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId,
			...data
		});
		const activation = command({});
		phase = 'Trial activation';
		const trial = await request('/crm/access/trial', {
			token: sessions.owner,
			body: activation
		});
		assert.equal(trial.activated, true);
		phase = 'Trial activation replay';
		assert.deepEqual(
			await request('/crm/access/trial', {
				token: sessions.owner,
				body: activation
			}),
			{ ...trial, activated: false }
		);
		phase = 'real onboarding';
		await request('/crm/access/onboarding/template', {
			token: sessions.owner,
			body: command({ templateKey: 'universal-sales', templateVersion: 1 })
		});
		const roster = () =>
			request(
				`/crm/access/team/members?workspaceId=${workspaceId}&page=1&pageSize=100`,
				{ token: sessions.owner }
			);
		phase = 'initial owner roster';
		let members = await roster();
		assert.equal(members.ownerSubject, accounts.owner.userId);
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 1,
			waitingCount: 0
		});
		assert.equal(members.total, 0);
		phase = 'real team creation';
		const createdTeam = await request('/crm/access/team/teams', {
			token: sessions.owner,
			body: command({ name: 'HTTP admission QA' })
		});
		const invites = [];
		phase = 'real invitation provisioning';
		for (const key of ['first', 'second']) {
			const dto = command({
				email: accounts[key].email,
				role: 'MANAGER',
				teamIds: [createdTeam.team.id],
				ttlDays: 7
			});
			const result = await request('/crm/access/team/invitations', {
				token: sessions.owner,
				body: dto
			});
			assert.equal(result.invitation.status, 'REGISTERING');
			assert.deepEqual(
				await request('/crm/access/team/invitations', {
					token: sessions.owner,
					body: dto
				}),
				result
			);
			invites.push({ key, id: result.invitation.id });
		}
		await settled(
			async () =>
				(await accessDb.crmInvitationIntent.count({
					where: { workspaceId, status: 'INVITED' }
				})) === 2
		);
		members = await roster();
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 1,
			waitingCount: 0
		});
		for (const invite of invites) {
			const preview = await request(
				`/workspace-invitations/${invite.id}`,
				{ token: sessions[invite.key] }
			);
			assert.equal(preview.invitation.status, 'PENDING');
			invite.command = {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: preview.invitation.version
			};
		}
		assert.equal(
			await identityDb.workspaceInvitation.count({
				where: {
					workspaceId,
					status: 'PENDING',
					notificationEventId: null
				}
			}),
			2
		);
		phase = 'concurrent HTTP acceptance';
		let locked;
		const lockReady = new Promise(resolve => {
			locked = resolve;
		});
		const release = new Promise(resolve => {
			releaseBarrier = resolve;
		});
		// Same real owner lock is held only in this isolated fixture to prove both
		// independent acceptance consumers contend; no business method is replaced.
		barrier = accessDb.$transaction(
			async tx => {
				await workspaceLock(tx, workspaceId);
				locked();
				await release;
			},
			{ maxWait: 3000, timeout: 20000 }
		);
		void barrier.catch(() => {});
		await Promise.race([
			lockReady,
			barrier.then(() => {
				throw new Error('Team concurrency barrier ended before readiness');
			})
		]);
		const accepted = await Promise.all(
			invites.map(invite =>
				request(`/workspace-invitations/${invite.id}/accept`, {
					token: sessions[invite.key],
					body: invite.command
				})
			)
		);
		for (const value of accepted)
			assert.equal(value.acceptance.workspaceId, workspaceId);
		await settled(async () => {
			const [row] = await accessDb.$queryRawUnsafe(
				"SELECT count(*)::integer AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database() AND a.usename=current_user"
			);
			return row.waiting >= 2;
		});
		releaseBarrier();
		await barrier;
		barrier = null;
		releaseBarrier = null;
		phase = 'FIFO admission at last Trial seat';
		await settled(async () => {
			const rows = await accessDb.crmAdmission.findMany({
				where: { workspaceId },
				orderBy: { position: 'asc' }
			});
			return (
				rows.length === 2 &&
				rows[0].status === 'ACTIVE' &&
				rows[1].status === 'WAITING'
			);
		});
		members = await roster();
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 2,
			waitingCount: 1
		});
		assert.equal(members.items.length, 1);
		const firstMember = members.items[0];
		assert.deepEqual(firstMember.teamIds, [createdTeam.team.id]);
		const acceptedEvents = await identityDb.outboxEvent.findMany({
			where: { eventType: 'identity.wincrm.invitation-accepted.v1' }
		});
		assert.equal(acceptedEvents.length, 2);
		phase = 'HTTP and broker duplicate replay';
		for (const [index, invite] of invites.entries())
			assert.deepEqual(
				await request(`/workspace-invitations/${invite.id}/accept`, {
					token: sessions[invite.key],
					body: invite.command
				}),
				accepted[index]
			);
		for (const event of acceptedEvents)
			await identityRabbit.publish(
				'winwidget.events',
				event.routingKey,
				event.payload,
				{ messageId: event.messageId, type: event.eventType }
			);
		await settled(
			async () =>
				(await accessDb.crmTeamDelivery.count({
					where: { consumer: 'acceptance', status: 'DELIVERED' }
				})) === 2
		);
		assert.equal(
			await identityDb.outboxEvent.count({
				where: { eventType: 'identity.wincrm.invitation-accepted.v1' }
			}),
			2
		);
		assert.equal(
			await accessDb.crmAdmission.count({ where: { workspaceId } }),
			2
		);
		phase = 'disabled member releases seat';
		const disable = command({ expectedVersion: firstMember.version });
		const disabled = await request(
			`/crm/access/team/members/${firstMember.id}/disable`,
			{ token: sessions.owner, body: disable }
		);
		assert.ok(disabled.member.disabledAt);
		await settled(async () => {
			const next = await roster();
			return next.items.length === 2 &&
				next.quota.usedSeats === 2 &&
				next.quota.waitingCount === 0 &&
				next.items.some(
					member => member.id === firstMember.id && member.disabledAt
				)
				? next
				: false;
		});
		members = await roster();
		const secondMember = members.items.find(
			member => member.id !== firstMember.id
		);
		assert.equal(secondMember.disabledAt, null);
		phase = 're-enable waits without reserving a seat';
		const enable = command({ expectedVersion: disabled.member.version });
		const enabling = await request(
			`/crm/access/team/members/${firstMember.id}/enable`,
			{ token: sessions.owner, body: enable }
		);
		assert.equal(enabling.admission.status, 'WAITING');
		members = await roster();
		assert.deepEqual(members.quota, {
			seatLimit: 2,
			usedSeats: 2,
			waitingCount: 1
		});
		await request(`/crm/access/team/members/${secondMember.id}/disable`, {
			token: sessions.owner,
			body: command({ expectedVersion: secondMember.version })
		});
		await settled(async () => {
			const next = await roster();
			return (
				next.quota.usedSeats === 2 &&
				next.quota.waitingCount === 0 &&
				next.items.find(member => member.id === firstMember.id)
					?.disabledAt === null
			);
		});
		phase = 'terminal durable evidence';
		await settled(
			async () =>
				(await accessDb.crmTeamOutbox.count({
					where: { status: { not: 'PUBLISHED' } }
				})) === 0
		);
		await settled(
			async () =>
				(await accessDb.crmTeamDelivery.count({
					where: { status: { not: 'DELIVERED' } }
				})) === 0
		);
		assert.equal(
			await accessDb.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			}),
			1
		);
		assert.equal(
			await identityDb.workspaceMember.count({
				where: { workspaceId, status: 'ACTIVE' }
			}),
			3
		);
		assert.equal(
			await identityDb.outboxEvent.count({
				where: {
					eventType: { not: 'identity.wincrm.invitation-accepted.v1' }
				}
			}),
			0
		);
		for (const consumer of TEAM_CONSUMERS) {
			const queue = await inspectorChannel.checkQueue(teamQueue(consumer));
			assert.equal(queue.consumerCount, 1);
			assert.equal(queue.messageCount, 0);
		}
		// Cancel push consumers and await their real in-flight handlers before
		// certifying duplicate replay; passive messageCount excludes unacked work.
		await worker.beforeApplicationShutdown();
		worker = null;
		for (const consumer of TEAM_CONSUMERS)
			for (const suffix of [
				'',
				'.dead-letter',
				'.retry.1',
				'.retry.2',
				'.retry.3'
			]) {
				const queue = await inspectorChannel.checkQueue(
					teamQueue(consumer) + suffix
				);
				assert.equal(queue.consumerCount, 0);
				assert.equal(queue.messageCount, 0);
			}
		assert.equal(
			await accessDb.crmTeamDelivery.count({
				where: {
					OR: [
						{ status: { not: 'DELIVERED' } },
						{ retryAttempt: { gt: 0 } },
						{ manualRetryCycle: { gt: 0 } }
					]
				}
			}),
			0
		);
		assert.equal(
			await accessDb.crmTeamOutbox.count({
				where: {
					OR: [{ status: { not: 'PUBLISHED' } }, { attempts: { not: 1 } }]
				}
			}),
			0
		);
		assert.equal(
			await accessDb.crmTeamDelivery.count({
				where: { consumer: 'acceptance' }
			}),
			2
		);
		assert.equal(
			await identityDb.outboxEvent.count({
				where: {
					eventType: 'identity.wincrm.invitation-accepted.v1',
					status: 'PUBLISHED',
					attempts: 1
				}
			}),
			2
		);
		assert.equal(
			await accessDb.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			}),
			1
		);
		const evidence = {
			realHttpInvitations: 2,
			concurrentAcceptances: 2,
			blockedAcceptanceConsumersObserved: 2,
			seatLimit: 2,
			ownerIncluded: true,
			pendingConsumesSeat: false,
			disabledConsumesSeat: false,
			fifoWaitingVerified: true,
			duplicateVerified: true,
			reenableVerified: true,
			rabbitTransportVerified: true,
			releaseImagesVerified: false,
			browserVerified: false,
			emailDeliveryVerified: false,
			externalProvidersVerified: false
		};
		log(
			'Team HTTP proof passed: real Trial2, Identity invitation/acceptance, scoped Outbox/Rabbit push, concurrent last-slot FIFO, duplicate replay and disabled/re-enable capacity; no browser, release-image or email-delivery claim'
		);
		return evidence;
	} catch (error) {
		const status = Number.isInteger(error?.httpStatus)
			? ` (HTTP ${error.httpStatus})`
			: '';
		throw new Error(
			`Team HTTP proof failed during ${phase}${status}; credentials and response details suppressed`
		);
	} finally {
		releaseBarrier?.();
		await barrier?.catch(() => {});
		const stopped = await Promise.allSettled([
			worker?.beforeApplicationShutdown(),
			accessPublisher?.beforeApplicationShutdown()
		]);
		const connections = await Promise.allSettled([
			workerRabbit?.onApplicationShutdown(),
			accessRabbit?.onApplicationShutdown(),
			identityRabbit?.onApplicationShutdown(),
			provisionRabbit?.onApplicationShutdown(),
			inspectorChannel?.close()
		]);
		const closed = await Promise.allSettled([
			inspector?.close(),
			identityDb?.$disconnect(),
			accessDb?.$disconnect()
		]);
		globalThis.fetch = originalFetch;
		if (
			[...stopped, ...connections, ...closed].some(
				result => result.status === 'rejected'
			)
		)
			throw new Error(
				'Team HTTP proof cleanup failed; local owned resources require review'
			);
	}
}
