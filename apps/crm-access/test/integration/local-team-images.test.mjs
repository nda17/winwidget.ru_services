import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	TEAM_IMAGE_ROLES,
	TeamImageRuntime,
	teamImageArguments,
	validateTeamImageAccounts,
	assertPendingTeamRetry
} from './local-team-images.mjs';
import { accessTeamBrokerPermissions } from './local-crm-image-topology.mjs';

const runId = '0123456789';
const runtime = () =>
	new TeamImageRuntime({
		servicesRoot: '.',
		stateDirectory: '.',
		runId,
		log() {}
	});

test('team images require the isolated non-interactive profile without direct CRM seeding or extra flags', () => {
	const flags = [
		'--backend-only',
		'--smoke-and-stop',
		'--verify-team-images'
	];
	assert.equal(teamImageArguments(flags), true);
	assert.equal(teamImageArguments([]), false);
	for (const flag of [
		'--activate-owner',
		'--with-widgets',
		'--browser-team',
		'--verify-team-http',
		'--verify-native-images',
		'--verify-billing-http',
		'--verify-team-images'
	])
		assert.throws(() => teamImageArguments([...flags, flag]));
	for (const flag of flags.slice(0, 2))
		assert.throws(() =>
			teamImageArguments(flags.filter(value => value !== flag))
		);
	assert.equal(runtime().profile, 'team');
	assert.equal(runtime().label, 'team-images-' + runId);
	assert.ok(Object.isFrozen(TEAM_IMAGE_ROLES));
	assert.ok(TEAM_IMAGE_ROLES.every(Object.isFrozen));
});

test('only fresh synthetic personas and four separate workspaces are admitted without printing credentials', () => {
	const accounts = Object.fromEntries(
		['owner', 'manager', 'teamLead', 'analyst'].map((name, index) => [
			name,
			{
				userId: 'wincrm-local-' + name + '-' + runId,
				email: 'wincrm-' + name.toLowerCase() + '@example.test',
				workspaceId: '12345678-1234-4234-8234-12345678900' + index,
				password: 'synthetic-test-only-secret'
			}
		])
	);
	validateTeamImageAccounts(accounts, runId);
	for (const field of ['userId', 'email', 'workspaceId', 'password']) {
		const changed = structuredClone(accounts);
		changed.owner[field] = 'sensitive-canary';
		assert.throws(
			() => validateTeamImageAccounts(changed, runId),
			error =>
				error.message ===
				'Team image account admission failed; values suppressed'
		);
	}
	accounts.analyst.workspaceId = accounts.owner.workspaceId;
	assert.throws(() => validateTeamImageAccounts(accounts, runId));
});

test('three image roles retain separate credentials and canonical process names, with topology assertion disabled', async () => {
	const value = runtime();
	for (const [label] of TEAM_IMAGE_ROLES)
		value.brokerUrls.set(label, 'amqp://synthetic-' + label);
	const calls = [];
	value.start = async (...args) => calls.push(args);
	await value.startTeamRoles(app => ({
		OWNER_APP: app,
		WINCRM_INVITATION_EMAIL_ENABLED: 'false'
	}));
	assert.equal(calls.length, 3);
	for (const [index, [label, app, env, port]] of calls.entries()) {
		const definition = TEAM_IMAGE_ROLES[index];
		const prefix = app === 'identity' ? 'IDENTITY' : 'CRM_ACCESS';
		assert.equal(label, definition[0]);
		assert.equal(app, definition[1]);
		assert.equal(env[prefix + '_PROCESS_ROLE'], definition[2]);
		assert.equal(port, definition[3]);
		assert.equal(env[prefix + '_PORT'], String(port));
		assert.equal(env.RABBITMQ_CONNECTION_NAME, 'winwidget-' + label);
		assert.equal(env.RABBITMQ_URL, value.brokerUrls.get(label));
		assert.equal(
			env[
				app === 'identity'
					? 'RABBITMQ_ASSERT_TOPOLOGY'
					: 'CRM_ACCESS_RABBITMQ_ASSERT_TOPOLOGY'
			],
			'false'
		);
		assert.equal(env.OWNER_APP, app);
		assert.equal(env.WINCRM_INVITATION_EMAIL_ENABLED, 'false');
	}
});

test('team broker credentials cannot configure resources or publish unrelated topic events', async () => {
	const value = runtime();
	const calls = [];
	value.ctl = async args => {
		calls.push(args);
	};
	value.createBroker = async () => {
		value.vhost = 'synthetic_team_test';
		value.amqp = {
			connect: async () => ({
				on() {},
				close: async () => {},
				createChannel: async () => ({
					assertExchange: async () => {},
					assertQueue: async () => {},
					bindQueue: async () => {},
					close: async () => {}
				})
			})
		};
	};
	await value.prepareBroker();
	assert.equal(value.brokerUrls.size, 3);
	for (const [label, app, role] of TEAM_IMAGE_ROLES) {
		const user = 'team_' + label.replaceAll('-', '_');
		const row = calls.find(
			args => args[0] === 'set_permissions' && args[3] === user
		);
		assert.deepEqual(
			row.slice(4),
			app === 'identity'
				? ['^$', '^winwidget\\.events$', '^$']
				: accessTeamBrokerPermissions(role)
		);
		const topic = calls.find(
			args =>
				args[0] === 'set_topic_permissions' &&
				args[3] === user &&
				args[4] === 'winwidget.events'
		);
		assert.equal(topic[6], '^$');
		const write = new RegExp(topic[5]);
		assert.equal(
			write.test('identity.wincrm.invitation-accepted.v1'),
			app === 'identity'
		);
		assert.equal(
			write.test('crm.access.invitation-provision.v1'),
			app === 'crm-access' && role === 'outbox-publisher'
		);
		assert.equal(
			write.test('crm.access.admission-wake.v1'),
			app === 'crm-access' && role === 'outbox-publisher'
		);
		assert.equal(write.test('identity.user.changed.v1'), false);
		assert.equal(
			write.test('widgets.wincrm.lead-transfer.requested.v1'),
			false
		);
	}
});

for (const consumer of ['provision', 'acceptance', 'admission']) {
	test(
		consumer +
			': durable retry requires exact payload/token, direct destination and the actual 30-second delay',
		() => {
			const receipt = {
				status: 'RETRY_SCHEDULED',
				retryAttempt: 1,
				eventId: 'event',
				consumer,
				leaseToken: 'claim',
				payload: { eventId: 'event' }
			};
			const outbox = {
				status: 'PENDING',
				exchange: 'winwidget.manual-retry',
				routingKey: 'crm-access.team.' + consumer,
				headers: {
					'x-original-event-id': 'event',
					'x-retry-attempt': 1,
					'x-delivery-token': 'claim'
				},
				payload: receipt.payload,
				createdAt: new Date('2026-09-06T10:00:00Z'),
				availableAt: new Date('2026-09-06T10:00:30Z'),
				messageId: 'delivery'
			};
			assertPendingTeamRetry(receipt, outbox);
			for (const patch of [
				{ status: 'PUBLISHED' },
				{ exchange: 'winwidget.retry' },
				{ routingKey: 'wrong' },
				{ headers: {} },
				{ payload: {} },
				{ availableAt: outbox.createdAt },
				{ messageId: receipt.eventId }
			])
				assert.throws(() =>
					assertPendingTeamRetry(receipt, { ...outbox, ...patch })
				);
		}
	);
}

test('team image profile uses real entrypoints and HTTP commands, not host-composed workers or database mutation shortcuts', async () => {
	const source = await readFile(
		new URL('./local-team-images.mjs', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(
		source,
		/publishOne\(|onModuleInit\(|new Crm|globalThis\.fetch\s*=|\.sign\(|\.createMany\(|\.updateMany\(|\.deleteMany\(/
	);
	assert.match(source, /verifyTeamWorkflow\(/);
	assert.match(source, /assertPendingTeamRetry\(receipt, outbox\)/);
	assert.match(
		source,
		/published\.publishedAt\.getTime\(\) >= outbox\.availableAt\.getTime\(\)/
	);
	assert.match(source, /await retry\('provision'\)/);
	assert.match(source, /await retry\('acceptance'\)/);
	assert.match(source, /await retry\('admission'\)/);
	assert.match(source, /await channel\.waitForConfirms\(\)/);
	assert.match(source, /browserVerified: false/);
	assert.match(source, /capacityVerified: false/);
	const harness = await readFile(
		new URL('./local-wincrm-stack.mjs', import.meta.url),
		'utf8'
	);
	assert.ok(
		/withTeamImages\s*\? TeamImageRuntime\s*: NativeImageRuntime/.test(
			harness
		)
	);
	assert.match(
		harness,
		/if \(withImageRuntime && command === 'migrate'\)/
	);
	assert.match(
		harness,
		/if \(withTeamImages\) \{\s*nativeImageEvidence = await verifyTeamImages/
	);
});
