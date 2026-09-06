import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
	NativeImageRuntime,
	nativeRevisionPath
} from './local-native-images.mjs';
import {
	accessTeamBrokerPermissions,
	provisionAccessTeamTopology
} from './local-crm-image-topology.mjs';
import {
	readBoundedJson,
	verifyTeamWorkflow
} from './local-team-runtime.mjs';

export const TEAM_IMAGE_ROLES = Object.freeze(
	[
		['crm-access-worker', 'crm-access', 'worker', 5301],
		[
			'crm-access-outbox-publisher',
			'crm-access',
			'outbox-publisher',
			5302
		],
		['identity-outbox-publisher', 'identity', 'outbox-publisher', 4902]
	].map(Object.freeze)
);
const consumers = ['provision', 'acceptance', 'admission'];

export function teamImageArguments(args) {
	if (!args.includes('--verify-team-images')) return false;
	assert.deepEqual([...args].sort(), [
		'--backend-only',
		'--smoke-and-stop',
		'--verify-team-images'
	]);
	return true;
}

export function validateTeamImageAccounts(accounts, runId) {
	try {
		assert.match(runId, /^[a-f0-9]{10}$/);
		const names = ['owner', 'manager', 'teamLead', 'analyst'];
		for (const name of names) {
			const account = accounts[name];
			assert.equal(account.userId, 'wincrm-local-' + name + '-' + runId);
			assert.equal(
				account.email,
				'wincrm-' + name.toLowerCase() + '@example.test'
			);
			assert.match(account.workspaceId, /^[a-f0-9-]{36}$/);
			assert.ok(account.password.length >= 20);
		}
		assert.equal(
			new Set(names.map(name => accounts[name].workspaceId)).size,
			4
		);
	} catch {
		throw new Error(
			'Team image account admission failed; values suppressed'
		);
	}
}

export class TeamImageRuntime extends NativeImageRuntime {
	constructor(options) {
		super({ ...options, profile: 'team' });
	}
	async prepareBroker() {
		await this.createBroker();
		const connection = await this.amqp.connect(this.provisionerUrl);
		connection.on('error', () => {});
		try {
			const channel = await connection.createChannel();
			await provisionAccessTeamTopology(channel);
			await channel.close();
		} finally {
			await connection.close();
		}
		for (const [label, app, role] of TEAM_IMAGE_ROLES) {
			const user = 'team_' + label.replaceAll('-', '_');
			const secret = randomBytes(24).toString('hex');
			await this.ctl(['add_user', user, secret]);
			await this.ctl([
				'set_permissions',
				'-p',
				this.vhost,
				user,
				...(app === 'identity'
					? ['^$', '^winwidget\\.events$', '^$']
					: accessTeamBrokerPermissions(role))
			]);
			await this.ctl([
				'set_topic_permissions',
				'-p',
				this.vhost,
				user,
				'winwidget.events',
				app === 'identity'
					? '^identity\\.wincrm\\.invitation-accepted\\.v1$'
					: role === 'worker'
						? '^$'
						: '^crm\\.access\\.(invitation-provision|admission-wake)\\.v1$',
				'^$'
			]);
			if (app === 'crm-access')
				await this.ctl([
					'set_topic_permissions',
					'-p',
					this.vhost,
					user,
					'winwidget.dead-letter',
					role === 'worker'
						? '^$'
						: '^crm-access\\.team\\.(provision|acceptance|admission)\\.dead-letter$',
					'^$'
				]);
			this.brokerUrls.set(
				label,
				'amqp://' + user + ':' + secret + '@127.0.0.1:5675/' + this.vhost
			);
		}
		this.log(
			'Team broker ready: three distinct runtime principals, pre-provisioned queues, no runtime configure permission'
		);
	}
	async startTeamRoles(serviceEnvironment) {
		for (const [label, app, role, port] of TEAM_IMAGE_ROLES) {
			const prefix = app === 'identity' ? 'IDENTITY' : 'CRM_ACCESS';
			await this.start(
				label,
				app,
				{
					...serviceEnvironment(app),
					[prefix + '_PROCESS_ROLE']: role,
					[prefix + '_PORT']: String(port),
					RABBITMQ_URL: this.brokerUrls.get(label),
					RABBITMQ_CONNECTION_NAME: 'winwidget-' + label,
					...(app === 'identity'
						? {
								RABBITMQ_ASSERT_TOPOLOGY: 'false',
								IDENTITY_OUTBOX_POLL_INTERVAL_MS: '100',
								IDENTITY_OUTBOX_BATCH_SIZE: '10'
							}
						: { CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY: 'false' })
				},
				port
			);
		}
	}
	async ready(label) {
		const process = this.processes.get(label);
		assert.ok(process, 'Unknown team image process');
		await this.wait(async () => {
			const item = await this.inspect(process.id);
			assert.equal(item.State.OOMKilled, false);
			assert.equal(item.Image, this.images.get(process.app));
			assert.ok(item.Config.Env.includes('APP_REVISION=' + this.revision));
			if (!item.State.Running) return false;
			try {
				const response = await fetch(
					'http://127.0.0.1:' + process.port + '/health/ready',
					{ signal: AbortSignal.timeout(2000) }
				);
				await response.body?.cancel();
				return response.status === 200;
			} catch {
				return false;
			}
		}, 'Team image readiness deadline');
		const path = nativeRevisionPath(process.app);
		if (path) {
			const response = await fetch(
				'http://127.0.0.1:' + process.port + path,
				{ signal: AbortSignal.timeout(2000) }
			);
			assert.equal(response.status, 200);
			assert.equal(
				(await readBoundedJson(response)).revision,
				this.revision
			);
		}
	}
	async resume(label) {
		const process = this.processes.get(label);
		await this.inspect(process.id);
		await this.docker(['start', process.id]);
		await this.ready(label);
	}
	async queues() {
		return JSON.parse(
			await this.ctl([
				'list_queues',
				'-p',
				this.vhost,
				'name',
				'messages_ready',
				'messages_unacknowledged',
				'consumers',
				'--formatter=json'
			])
		);
	}
	async quiet() {
		await this.wait(async () => {
			const rows = await this.queues();
			return (
				rows.length === 6 &&
				consumers.every(consumer => {
					const queue = 'winwidget.crm-access.team.' + consumer;
					return [queue, queue + '.dead-letter'].every(name =>
						rows.some(
							row =>
								row.name === name &&
								row.messages_ready === 0 &&
								row.messages_unacknowledged === 0 &&
								row.consumers === (name === queue ? 1 : 0)
						)
					);
				})
			);
		}, 'Team image queues did not drain');
	}
}

export function assertPendingTeamRetry(receipt, outbox) {
	assert.equal(receipt.status, 'RETRY_SCHEDULED');
	assert.equal(receipt.retryAttempt, 1);
	assert.equal(outbox.status, 'PENDING');
	assert.equal(outbox.exchange, 'winwidget.manual-retry');
	assert.equal(outbox.routingKey, 'crm-access.team.' + receipt.consumer);
	assert.equal(outbox.headers['x-original-event-id'], receipt.eventId);
	assert.equal(outbox.headers['x-retry-attempt'], 1);
	assert.equal(outbox.headers['x-delivery-token'], receipt.leaseToken);
	assert.deepEqual(outbox.payload, receipt.payload);
	const delay = outbox.availableAt.getTime() - outbox.createdAt.getTime();
	assert.ok(
		delay >= 29_000 && delay <= 31_000,
		'Real first retry must retain its 30-second deadline'
	);
	assert.notEqual(outbox.messageId, receipt.eventId);
}

// Fault injection controls only owned containers and replays immutable committed
// events. No business worker/publisher is instantiated or replaced in this driver.
export async function verifyTeamImages({
	runtime,
	servicesRoot,
	runId,
	accounts,
	serviceEnvironment
}) {
	validateTeamImageAccounts(accounts, runId);
	assert.equal(runtime.profile, 'team');
	assert.match(runtime.revision, /^[a-f0-9]{40}$/);
	let phase = 'start-team-roles';
	let accessDb, identityDb;
	const stage = value => {
		phase = value;
		runtime.stage = value;
		runtime.log('Team image phase: ' + value);
	};
	try {
		await runtime.startTeamRoles(serviceEnvironment);
		stage('normal-team-workflow');
		const workflow = await verifyTeamWorkflow({
			runId,
			accounts,
			foreignWorkspaceId: accounts.analyst.workspaceId,
			assertReady: async () => {
				for (const label of runtime.processes.keys())
					await runtime.ready(label);
			},
			log: runtime.log
		});
		await runtime.quiet();
		stage('three-consumer-durable-retries');
		const db = (app, schema) => {
			const require = createRequire(
				join(servicesRoot, 'apps', app, 'package.json')
			);
			return new (require('@prisma/' + app + '-client').PrismaClient)({
				datasources: {
					db: {
						url: `postgresql://wcrm_${schema}_r_${runId}@127.0.0.1:55440/winwidget_${schema}_test_browser_${runId}_test?schema=${schema}&sslmode=disable&connection_limit=3`
					}
				},
				log: []
			});
		};
		accessDb = db('crm-access', 'crm_access');
		identityDb = db('identity', 'identity');
		const workspaceId = accounts.analyst.workspaceId;
		const request = async (path, { body, token, expected = 200 } = {}) => {
			const response = await fetch('http://localhost:4100/api/v1' + path, {
				method: body ? 'POST' : 'GET',
				redirect: 'error',
				signal: AbortSignal.timeout(15000),
				headers: {
					'content-type': 'application/json',
					...(token ? { authorization: 'Bearer ' + token } : {}),
					...(body?.commandId ? { 'idempotency-key': body.commandId } : {})
				},
				...(body ? { body: JSON.stringify(body) } : {})
			});
			if (response.status !== expected) {
				await response.body?.cancel();
				const error = new Error('Team image HTTP contract mismatch');
				error.httpStatus = response.status;
				throw error;
			}
			return readBoundedJson(response);
		};
		const login = async account => {
			const session = await request('/auth/login', {
				body: { email: account.email, password: account.password }
			});
			assert.equal(session.user.id, account.userId);
			assert.ok(session.accessToken?.length > 100);
			return session.accessToken;
		};
		const ownerToken = await login(accounts.analyst);
		const inviteeToken = await login(accounts.owner);
		const command = data => ({
			schemaVersion: 1,
			commandId: randomUUID(),
			workspaceId,
			...data
		});
		assert.equal(
			await accessDb.crmWorkspaceAccess.count({ where: { workspaceId } }),
			0
		);
		assert.equal(
			(
				await request('/crm/access/trial', {
					token: ownerToken,
					body: command({})
				})
			).activated,
			true
		);
		await request('/crm/access/onboarding/template', {
			token: ownerToken,
			body: command({ templateKey: 'universal-sales', templateVersion: 1 })
		});
		const stop = label => runtime.stop(runtime.processes.get(label).id);
		const observedRetries = [];
		const retry = async consumer => {
			stage(consumer + '-retry-persisted');
			const receipt = await runtime.wait(
				async () =>
					accessDb.crmTeamDelivery.findFirst({
						where: {
							workspaceId,
							consumer,
							status: 'RETRY_SCHEDULED',
							retryAttempt: 1
						}
					}),
				'Missing durable ' + consumer + ' retry'
			);
			const outbox = await accessDb.crmTeamOutbox.findUniqueOrThrow({
				where: {
					deduplicationKey: `retry:${receipt.id}:${receipt.manualRetryCycle}:1:RETRY_SCHEDULED`
				}
			});
			assertPendingTeamRetry(receipt, outbox);
			assert.ok(
				Date.now() < outbox.availableAt.getTime(),
				'Observe persisted delay before its deadline'
			);
			await stop('crm-access-outbox-publisher');
			await stop('crm-access-worker');
			const pending = await accessDb.crmTeamOutbox.findUniqueOrThrow({
				where: { id: outbox.id }
			});
			assert.equal(pending.status, 'PENDING');
			assert.equal(
				pending.availableAt.getTime(),
				outbox.availableAt.getTime()
			);
			await runtime.stop(runtime.brokerId);
			assert.equal(
				(await runtime.inspect(runtime.brokerId)).State.Running,
				false
			);
			return { receipt, outbox };
		};
		const recover = async ({ receipt, outbox }, dependency) => {
			stage(receipt.consumer + '-retry-recovery');
			await runtime.resume(dependency);
			await runtime.docker(['start', runtime.brokerId]);
			await runtime.wait(
				async () =>
					(
						await runtime.command('docker', [
							'--context',
							'colima',
							'exec',
							'--user=rabbitmq',
							runtime.brokerId,
							'rabbitmq-diagnostics',
							'-q',
							'check_port_connectivity'
						])
					).code === 0,
				'Team broker restart deadline'
			);
			await runtime.resume('crm-access-worker');
			await runtime.resume('crm-access-outbox-publisher');
			await runtime.ready('identity-outbox-publisher');
			await runtime.wait(
				async () =>
					(
						await accessDb.crmTeamDelivery.findUniqueOrThrow({
							where: { id: receipt.id }
						})
					).status === 'DELIVERED',
				'Team delayed retry did not complete'
			);
			const published = await accessDb.crmTeamOutbox.findUniqueOrThrow({
				where: { id: outbox.id }
			});
			assert.equal(published.status, 'PUBLISHED');
			assert.equal(
				published.availableAt.getTime(),
				outbox.availableAt.getTime()
			);
			assert.ok(
				published.publishedAt.getTime() >= outbox.availableAt.getTime()
			);
			assert.equal(published.messageId, outbox.messageId);
			assert.deepEqual(published.payload, outbox.payload);
			assert.deepEqual(published.headers, outbox.headers);
			observedRetries.push({
				consumer: receipt.consumer,
				eventId: receipt.eventId,
				deadline: outbox.availableAt.toISOString(),
				publishedAt: published.publishedAt.toISOString(),
				persistedAcrossProcessAndBrokerRestart: true
			});
			return receipt;
		};
		await stop('crm-access-worker');
		const invitation = (
			await request('/crm/access/team/invitations', {
				token: ownerToken,
				body: command({
					email: accounts.owner.email,
					role: 'MANAGER',
					teamIds: [],
					ttlDays: 7
				})
			})
		).invitation;
		await stop('identity');
		await runtime.resume('crm-access-worker');
		const provision = await retry('provision');
		await recover(provision, 'identity');
		assert.equal(
			(
				await accessDb.crmInvitationIntent.findUniqueOrThrow({
					where: { id: invitation.id }
				})
			).status,
			'INVITED'
		);
		const preview = await request(
			'/workspace-invitations/' + invitation.id,
			{ token: inviteeToken }
		);
		await stop('crm-access-worker');
		await request('/workspace-invitations/' + invitation.id + '/accept', {
			token: inviteeToken,
			body: {
				schemaVersion: 1,
				commandId: randomUUID(),
				expectedVersion: preview.invitation.version
			}
		});
		await stop('identity');
		await runtime.resume('crm-access-worker');
		const acceptance = await retry('acceptance');
		await stop('billing');
		await recover(acceptance, 'identity');
		const admission = await retry('admission');
		await recover(admission, 'billing');
		await runtime.quiet();
		const roster = await request(
			'/crm/access/team/members?workspaceId=' +
				workspaceId +
				'&page=1&pageSize=25',
			{ token: ownerToken }
		);
		assert.deepEqual(roster.quota, {
			seatLimit: 2,
			usedSeats: 2,
			waitingCount: 0
		});
		assert.equal(roster.items.length, 1);
		assert.equal(roster.items[0].subject, accounts.owner.userId);
		stage('committed-event-replay');
		const snapshot = async () => ({
			invites: await identityDb.workspaceInvitation.count({
				where: { workspaceId }
			}),
			members: await identityDb.workspaceMember.count({
				where: { workspaceId, status: 'ACTIVE' }
			}),
			admissions: await accessDb.crmAdmission.count({
				where: { workspaceId }
			}),
			crmMembers: await accessDb.crmWorkspaceMember.count({
				where: { workspaceId, disabledAt: null }
			}),
			receipts: await accessDb.crmTeamDelivery.findMany({
				where: { workspaceId },
				orderBy: { id: 'asc' }
			})
		});
		const before = await snapshot();
		assert.equal(before.invites, 1);
		assert.equal(before.members, 2);
		assert.equal(before.admissions, 1);
		assert.equal(before.crmMembers, 1);
		for (const { receipt } of [provision, acceptance, admission]) {
			const label =
				receipt.consumer === 'acceptance'
					? 'identity-outbox-publisher'
					: 'crm-access-outbox-publisher';
			const connection = await runtime.amqp.connect(
				runtime.brokerUrls.get(label)
			);
			connection.on('error', () => {});
			try {
				const channel = await connection.createConfirmChannel();
				let returned = false;
				channel.on('return', () => {
					returned = true;
				});
				for (let index = 0; index < 2; index += 1)
					channel.publish(
						'winwidget.events',
						receipt.payload.eventType,
						Buffer.from(JSON.stringify(receipt.payload)),
						{
							contentType: 'application/json',
							persistent: true,
							mandatory: true,
							messageId: receipt.eventId,
							type: receipt.payload.eventType
						}
					);
				await channel.waitForConfirms();
				assert.equal(
					returned,
					false,
					'Committed team event replay was unroutable'
				);
				await channel.close();
			} finally {
				await connection.close();
			}
		}
		await runtime.quiet();
		assert.deepEqual(await snapshot(), before);
		assert.equal(
			await accessDb.crmTeamOutbox.count({
				where: { status: { not: 'PUBLISHED' } }
			}),
			0
		);
		assert.equal(
			await identityDb.outboxEvent.count({
				where: { status: { not: 'PUBLISHED' } }
			}),
			0
		);
		for (const label of runtime.processes.keys())
			await runtime.ready(label);
		return {
			...workflow,
			revision: runtime.revision,
			runId,
			releaseImagesVerified: true,
			apiImages: 7,
			backgroundImageProcesses: 3,
			logicalDatabases: 6,
			postgresInstances: 1,
			postgresAuthentication: 'local-test-trust',
			durableRetries: observedRetries,
			committedReplayConsumers: consumers,
			browserVerified: false,
			emailDeliveryVerified: false,
			capacityVerified: false,
			externalProvidersVerified: false,
			images: Object.fromEntries(runtime.images)
		};
	} catch (error) {
		await runtime.failureEvidence(phase).catch(() => {});
		if (
			/^Team runtime proof failed during [A-Za-z0-9 ,/-]+(?: \(HTTP [0-9]{3}\))?; values suppressed$/.test(
				error?.message
			)
		)
			throw error;
		const status = Number.isInteger(error?.httpStatus)
			? '; HTTP=' + error.httpStatus
			: '';
		const match = String(error?.stack || '').match(
			/local-team-images\.mjs:(\d+):\d+/
		);
		throw new Error(
			'Team image proof failed phase=' +
				phase +
				status +
				(match ? '; line=' + match[1] : '') +
				'; values suppressed'
		);
	} finally {
		await Promise.all([
			accessDb?.$disconnect(),
			identityDb?.$disconnect()
		]);
	}
}
