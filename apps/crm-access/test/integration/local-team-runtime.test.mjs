import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
	assertRuntimeHealth,
	readBoundedJson,
	validateTeamRuntimeFixture
} from './local-team-runtime.mjs';

const runId = '012345abcd';
const canary = 'private-credential-must-not-be-returned';
function fixture() {
	return {
		runId,
		ownedMarker: `wincrm-local-stack:${runId}`,
		apiUrl: 'http://localhost:4100/api/v1',
		activatedOwner: false,
		browserTeam: {
			backgroundReady: true,
			startupLoginRequests: 0,
			browserVerified: false,
			releaseImagesVerified: false,
			personas: ['browserOwner', 'browserInviteeA', 'browserInviteeB']
		},
		databases: [
			'identity',
			'billing',
			'crm_access',
			'crm_intake',
			'crm_customers',
			'crm_sales'
		].map(schema => ({
			database: `winwidget_${schema}_test_browser_${runId}_test`,
			migrationRole: `wcrm_${schema}_m_${runId}`,
			runtimeRole: `wcrm_${schema}_r_${runId}`
		})),
		accounts: Object.fromEntries(
			['owner', 'manager', 'teamLead'].map((name, index) => [
				name,
				{
					userId: `wincrm-local-${name}-${runId}`,
					email: `wincrm-${name.toLowerCase()}@example.test`,
					workspaceId: `12345678-1234-4234-8234-12345678900${index}`,
					password: canary
				}
			])
		),
		children: {
			'crm-access-worker': 2001,
			'crm-access-outbox-publisher': 2002,
			'identity-outbox-publisher': 2003
		}
	};
}

test('accepts only an isolated unactivated companion workspace on the actual browser-team runtime', () => {
	const value = fixture();
	assert.equal(validateTeamRuntimeFixture(value), value);
});

for (const [name, change] of [
	[
		'remote API',
		f => {
			f.apiUrl = `https://${canary}.invalid`;
		}
	],
	[
		'foreign database',
		f => {
			f.databases[0].database = canary;
		}
	],
	[
		'privileged role',
		f => {
			f.databases[0].runtimeRole = canary;
		}
	],
	[
		'existing activated workspace',
		f => {
			f.activatedOwner = true;
		}
	],
	[
		'missing background process',
		f => {
			delete f.children['crm-access-worker'];
		}
	],
	[
		'non-fixture account',
		f => {
			f.accounts.owner.userId = canary;
		}
	],
	[
		'shared workspace',
		f => {
			f.accounts.manager.workspaceId = f.accounts.owner.workspaceId;
		}
	],
	[
		'false browser claim',
		f => {
			f.browserTeam.browserVerified = true;
		}
	],
	[
		'false image claim',
		f => {
			f.browserTeam.releaseImagesVerified = true;
		}
	]
])
	test(`rejects ${name} without disclosing values`, () => {
		const value = fixture();
		change(value);
		assert.throws(
			() => validateTeamRuntimeFixture(value),
			error =>
				error.message ===
					'Team runtime fixture admission failed; values suppressed' &&
				!error.message.includes(canary)
		);
	});

test('health requires actual service, run revision and readiness', () => {
	const body = {
		status: 'ready',
		service: 'crm-access',
		revision: `local-browser-${runId}`
	};
	assertRuntimeHealth(body, 'crm-access', runId);
	for (const patch of [
		{ status: 'starting' },
		{ service: 'identity' },
		{ revision: 'old' }
	])
		assert.throws(() =>
			assertRuntimeHealth({ ...body, ...patch }, 'crm-access', runId)
		);
});

test('HTTP body is bounded before parsing', async () => {
	assert.deepEqual(await readBoundedJson(new Response('{"ok":true}')), {
		ok: true
	});
	await assert.rejects(
		readBoundedJson(new Response('x'.repeat(512 * 1024 + 1))),
		/response bound/
	);
});

test('companion never composes workers or changes business tables directly', async () => {
	const source = await readFile(
		new URL('./local-team-runtime.mjs', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(
		source,
		/publishOne\(|onModuleInit\(|new Crm|globalThis\.fetch\s*=|\.sign\(|\.createMany\(|\.updateMany\(|\.deleteMany\(/
	);
	assert.match(source, /pg_advisory_xact_lock/);
	assert.match(source, /l\.locktype='advisory' AND NOT l\.granted/);
	assert.match(source, /concurrentBlockedConsumers: 2/);
	assert.match(source, /browserVerified: false/);
	assert.match(source, /resourceCleanupPending: true/);
	assert.match(source, /flag: 'wx'/);
});
