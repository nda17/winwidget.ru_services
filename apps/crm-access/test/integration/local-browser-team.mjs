import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const BROWSER_TEAM_ROLES = Object.freeze([
	{
		app: 'crm-access',
		role: 'worker',
		label: 'crm-access-worker',
		port: 5301
	},
	{
		app: 'crm-access',
		role: 'outbox-publisher',
		label: 'crm-access-outbox-publisher',
		port: 5302
	},
	{
		app: 'identity',
		role: 'outbox-publisher',
		label: 'identity-outbox-publisher',
		port: 4902
	}
]);
export const BROWSER_TEAM_PERSONAS = Object.freeze([
	'browserOwner',
	'browserInviteeA',
	'browserInviteeB'
]);
const consumers = ['provision', 'acceptance', 'admission'];
const suffixes = ['', '.dead-letter', '.retry.1', '.retry.2', '.retry.3'];
const delay = milliseconds =>
	new Promise(resolve => setTimeout(resolve, milliseconds));

export function browserTeamRequested(arguments_) {
	const enabled = arguments_.includes('--browser-team');
	assert.ok(
		!enabled ||
			(arguments_.length === 1 && arguments_[0] === '--browser-team'),
		'--browser-team must run separately from all verification, activation and stop profiles'
	);
	return enabled;
}

function runtimeUrl(value, schema, runId) {
	const url = new URL(value);
	assert.equal(url.protocol, 'postgresql:');
	assert.equal(url.hostname, '127.0.0.1');
	assert.equal(url.port, '55440');
	assert.equal(
		url.pathname,
		`/winwidget_${schema}_test_browser_${runId}_test`
	);
	assert.equal(url.username, `wcrm_${schema}_r_${runId}`);
	assert.equal(url.searchParams.get('schema'), schema);
	assert.equal(url.searchParams.get('sslmode'), 'disable');
	assert.equal(url.searchParams.get('connection_limit'), '3');
	assert.deepEqual([...url.searchParams.keys()].sort(), [
		'connection_limit',
		'schema',
		'sslmode'
	]);
	assert.ok(!url.password && !url.hash);
	return url;
}

export function browserTeamProcessSpecs({
	servicesRoot,
	runId,
	broker,
	environments,
	databaseUrls
}) {
	try {
		assert.match(runId, /^[a-f0-9]{10}$/);
		assert.deepEqual(Object.keys(broker).sort(), [
			'identity_publisher',
			'provisioner',
			'publisher',
			'worker'
		]);
		const brokerUrls = Object.values(broker).map(value => new URL(value));
		assert.equal(brokerUrls.length, 4);
		assert.equal(new Set(brokerUrls.map(url => url.username)).size, 4);
		for (const url of brokerUrls) {
			assert.equal(url.protocol, 'amqp:');
			assert.equal(url.hostname, '127.0.0.1');
			assert.equal(url.port, '5673');
			assert.ok(url.username && url.password && !url.search && !url.hash);
			assert.match(
				decodeURIComponent(url.pathname),
				/^\/[a-z0-9_-]+_(test|ci)$/
			);
			assert.equal(url.pathname, brokerUrls[0].pathname);
		}
		assert.equal(
			environments.identity.WINCRM_INVITATION_EMAIL_ENABLED,
			'false'
		);
		assert.equal(
			environments['crm-access'].CRM_ACCESS_BILLING_ENABLED,
			'false'
		);
		return BROWSER_TEAM_ROLES.map(spec => {
			const identity = spec.app === 'identity';
			const prefix = identity ? 'IDENTITY' : 'CRM_ACCESS';
			const database = runtimeUrl(
				databaseUrls[spec.app],
				identity ? 'identity' : 'crm_access',
				runId
			);
			const rabbit = identity
				? broker.identity_publisher
				: broker[spec.role === 'worker' ? 'worker' : 'publisher'];
			return {
				...spec,
				entrypoint: join(
					servicesRoot,
					'apps',
					spec.app,
					'dist/src/main.js'
				),
				env: {
					...environments[spec.app],
					[`${prefix}_PROCESS_ROLE`]: spec.role,
					[`${prefix}_PORT`]: String(spec.port),
					[`${prefix}_LISTEN_HOST`]: '127.0.0.1',
					[`${prefix}_DATABASE_URL`]: database.toString(),
					RABBITMQ_URL: rabbit,
					RABBITMQ_CONNECTION_NAME: `winwidget-${spec.label}`,
					...(identity ? { RABBITMQ_ASSERT_TOPOLOGY: 'false' } : {})
				}
			};
		});
	} catch {
		throw new Error(
			'Browser team runtime admission failed; values suppressed'
		);
	}
}

export async function browserTeamAnonymousPreflight(request = fetch) {
	for (const path of ['/crm/access/bootstrap', '/billing-settings/crm']) {
		const response = await request(`http://localhost:4100/api/v1${path}`, {
			method: 'GET',
			redirect: 'error',
			signal: AbortSignal.timeout(5000)
		});
		assert.equal(
			response.status,
			401,
			'Browser preflight must preserve anonymous access guards'
		);
		await response.body?.cancel();
	}
	return { startupLoginRequests: 0 };
}

async function bounded(work, milliseconds) {
	let timer;
	try {
		return await Promise.race([
			work,
			new Promise((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error('Browser team observation deadline exceeded')
						),
					milliseconds
				);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

export function assertBrowserTeamReadiness(body, spec, revision) {
	assert.equal(body.status, 'ready');
	assert.equal(body.service, spec.app);
	assert.equal(body.revision, revision);
	if (spec.app === 'identity') assert.equal(body.role, spec.role);
}

export function assertBrowserTeamSnapshot(value, stopped = false) {
	for (const key of [
		'identityPending',
		'accessPending',
		'deliveryPending'
	])
		assert.equal(value[key], 0);
	assert.equal(value.queues.length, consumers.length * suffixes.length);
	const expected = consumers.flatMap(consumer =>
		suffixes.map(
			suffix => `winwidget.crm-access.team.${consumer}${suffix}`
		)
	);
	assert.deepEqual(
		value.queues.map(queue => queue.name).sort(),
		expected.sort()
	);
	for (const queue of value.queues) {
		assert.equal(queue.messageCount, 0);
		assert.equal(
			queue.consumerCount,
			!stopped &&
				consumers.some(
					consumer =>
						queue.name === `winwidget.crm-access.team.${consumer}`
				)
				? 1
				: 0
		);
	}
}

// Only read-only owner clients and passive AMQP queue inspection. Publishers and
// consumers belong to real child entrypoints; this observer never pumps work.
export async function createBrowserTeamObserver({
	servicesRoot,
	runId,
	databaseUrls,
	broker
}) {
	let identity, access, connection, channel;
	const close = async () => {
		let failed = false;
		for (const action of [
			() => channel?.close(),
			() => connection?.close(),
			() => identity?.$disconnect(),
			() => access?.$disconnect()
		]) {
			try {
				await bounded(Promise.resolve().then(action), 5000);
			} catch {
				failed = true;
			}
		}
		if (failed) throw new Error('Browser team observer cleanup failed');
	};
	try {
		const requireAccess = createRequire(
			join(servicesRoot, 'apps/crm-access/package.json')
		);
		const requireIdentity = createRequire(
			join(servicesRoot, 'apps/identity/package.json')
		);
		const client = (Constructor, schema, value) => {
			const url = runtimeUrl(value, schema, runId);
			url.searchParams.set('connection_limit', '1');
			url.searchParams.set('pool_timeout', '3');
			url.searchParams.set('connect_timeout', '3');
			return new Constructor({
				datasources: { db: { url: url.toString() } },
				log: []
			});
		};
		identity = client(
			requireIdentity('@prisma/identity-client').PrismaClient,
			'identity',
			databaseUrls.identity
		);
		access = client(
			requireAccess('@prisma/crm-access-client').PrismaClient,
			'crm_access',
			databaseUrls['crm-access']
		);
		connection = await requireAccess('amqplib').connect(
			broker.provisioner,
			{ timeout: 5000 }
		);
		connection.on('error', () => {});
		channel = await connection.createChannel();
		channel.on('error', () => {});
		const readOnly = (prisma, read) =>
			prisma.$transaction(
				async tx => {
					await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
					await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3s'");
					return read(tx);
				},
				{ timeout: 5000 }
			);
		return {
			close,
			async snapshot() {
				try {
					return await bounded(
						(async () => {
							const [identityPending, accessCounts] = await Promise.all([
								readOnly(identity, tx =>
									tx.outboxEvent.count({
										where: { status: { not: 'PUBLISHED' } }
									})
								),
								readOnly(access, async tx => ({
									accessPending: await tx.crmTeamOutbox.count({
										where: { status: { not: 'PUBLISHED' } }
									}),
									deliveryPending: await tx.crmTeamDelivery.count({
										where: { status: { not: 'DELIVERED' } }
									})
								}))
							]);
							const queues = [];
							for (const consumer of consumers)
								for (const suffix of suffixes) {
									const name = `winwidget.crm-access.team.${consumer}${suffix}`;
									const state = await channel.checkQueue(name);
									queues.push({
										name,
										messageCount: state.messageCount,
										consumerCount: state.consumerCount
									});
								}
							return { identityPending, ...accessCounts, queues };
						})(),
						5000
					);
				} catch {
					throw new Error(
						'Browser team read-only observation failed; details suppressed'
					);
				}
			}
		};
	} catch {
		await close().catch(() => {});
		throw new Error(
			'Browser team observer admission failed; values suppressed'
		);
	}
}

export async function waitBrowserTeamQuiet(
	observer,
	{ timeoutMs = 20000, wait = delay, now = Date.now } = {}
) {
	const deadline = now() + timeoutMs;
	let consecutive = 0;
	while (now() < deadline) {
		const snapshot = await observer.snapshot();
		try {
			assertBrowserTeamSnapshot(snapshot);
			consecutive++;
		} catch {
			consecutive = 0;
		}
		if (consecutive === 2) return snapshot;
		await wait(250);
	}
	throw new Error(
		'Browser team did not drain; preserve owned databases and broker for review'
	);
}

export async function stopBrowserTeamChildren(
	children,
	labels,
	{
		timeoutMs = 20000,
		signal = process.kill,
		wait = delay,
		now = Date.now
	} = {}
) {
	const selected = labels
		.map(label => children.get(label))
		.filter(Boolean);
	for (const state of selected) {
		if (state.exited) continue;
		assert.ok(
			Number.isSafeInteger(state.child.pid) && state.child.pid > 1
		);
		try {
			signal(-state.child.pid, 'SIGTERM');
		} catch (error) {
			if (error.code !== 'ESRCH') throw error;
		}
	}
	const deadline = now() + timeoutMs;
	while (selected.some(state => !state.exited) && now() < deadline)
		await wait(100);
	assert.ok(
		selected.every(state => state.exited),
		'Owned browser processes did not exit gracefully; no forced kill, preserve resources'
	);
}
