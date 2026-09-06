import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	BROWSER_TEAM_PERSONAS,
	BROWSER_TEAM_ROLES,
	assertBrowserTeamReadiness,
	assertBrowserTeamSnapshot,
	browserTeamAnonymousPreflight,
	browserTeamProcessSpecs,
	browserTeamRequested,
	stopBrowserTeamChildren,
	waitBrowserTeamQuiet
} from './local-browser-team.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const canary = 'synthetic-private-canary-not-for-errors';
const runId = '012345abcd';
const schemas = { identity: 'identity', 'crm-access': 'crm_access' };
const sample = () => ({
	servicesRoot: '/private/local-test/services',
	runId,
	broker: Object.fromEntries(
		['provisioner', 'worker', 'publisher', 'identity_publisher'].map(
			role => [
				role,
				`amqp://${role}:${canary}@127.0.0.1:5673/browser_${runId}_test`
			]
		)
	),
	environments: {
		identity: {
			WINCRM_INVITATION_EMAIL_ENABLED: 'false',
			IDENTITY_CRM_ACCESS_TOKEN: canary
		},
		'crm-access': {
			CRM_ACCESS_BILLING_ENABLED: 'false',
			IDENTITY_CRM_ACCESS_TOKEN: canary
		}
	},
	databaseUrls: Object.fromEntries(
		Object.entries(schemas).map(([app, schema]) => [
			app,
			`postgresql://wcrm_${schema}_r_${runId}@127.0.0.1:55440/winwidget_${schema}_test_browser_${runId}_test?schema=${schema}&sslmode=disable&connection_limit=3`
		])
	)
});
const snapshot = (stopped = false) => ({
	identityPending: 0,
	accessPending: 0,
	deliveryPending: 0,
	queues: ['provision', 'acceptance', 'admission'].flatMap(consumer =>
		['', '.dead-letter'].map(suffix => ({
			name: `winwidget.crm-access.team.${consumer}${suffix}`,
			messageCount: 0,
			consumerCount: !stopped && suffix === '' ? 1 : 0
		}))
	)
});
function clock() {
	let time = 0;
	return {
		now: () => time,
		wait: async milliseconds => {
			time += milliseconds;
		}
	};
}

test('interactive profile is standalone; all existing profiles remain opt-out', () => {
	assert.equal(browserTeamRequested(['--browser-team']), true);
	assert.equal(browserTeamRequested([]), false);
	const oldFlags = [
		'--backend-only',
		'--activate-owner',
		'--with-widgets',
		'--verify-native-widget-http',
		'--verify-native-widget-http-all',
		'--verify-domain',
		'--verify-billing',
		'--verify-billing-http',
		'--verify-acceptance-http',
		'--verify-team-http',
		'--smoke-and-stop',
		'--help',
		'--refresh-frontends'
	];
	for (const flag of oldFlags) {
		assert.equal(browserTeamRequested([flag]), false);
		assert.throws(
			() => browserTeamRequested([flag, '--browser-team']),
			/must run separately/
		);
		assert.throws(
			() => browserTeamRequested(['--browser-team', flag]),
			/must run separately/
		);
	}
	assert.throws(() =>
		browserTeamRequested(['--browser-team', '--browser-team'])
	);
});

test('actual harness rejects conflicting profiles before private files, Docker or refresh', async t => {
	const directory = await mkdtemp(
		join(tmpdir(), 'wincrm-browser-args-test-')
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const args of [
		['--browser-team', '--activate-owner'],
		['--browser-team', '--backend-only'],
		['--browser-team', '--verify-team-http'],
		['--browser-team', '--smoke-and-stop'],
		['--browser-team', '--browser-team'],
		['--refresh-frontends', '--browser-team'],
		['--help', '--browser-team']
	]) {
		const result = spawnSync(
			process.execPath,
			[join(root, 'local-wincrm-stack.mjs'), ...args],
			{
				cwd: directory,
				env: {
					PATH: '/nonexistent',
					TMPDIR: directory,
					WINCRM_LOCAL_STACK_ALLOW_MUTATION: 'true'
				},
				encoding: 'utf8',
				timeout: 10000
			}
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must run separately/);
		assert.deepEqual(await readdir(directory), []);
	}
});

test('three actual owner entrypoints, exact roles/ports and separate least-privilege principals', () => {
	const input = sample();
	const specs = browserTeamProcessSpecs(input);
	assert.deepEqual(
		specs.map(({ app, role, label, port }) => ({
			app,
			role,
			label,
			port
		})),
		BROWSER_TEAM_ROLES
	);
	assert.deepEqual(BROWSER_TEAM_PERSONAS, [
		'browserOwner',
		'browserInviteeA',
		'browserInviteeB'
	]);
	for (const spec of specs) {
		assert.equal(
			spec.entrypoint,
			join(input.servicesRoot, 'apps', spec.app, 'dist/src/main.js')
		);
		const identity = spec.app === 'identity';
		const prefix = identity ? 'IDENTITY' : 'CRM_ACCESS';
		assert.equal(spec.env[`${prefix}_PROCESS_ROLE`], spec.role);
		assert.equal(spec.env[`${prefix}_PORT`], String(spec.port));
		assert.equal(spec.env[`${prefix}_LISTEN_HOST`], '127.0.0.1');
		assert.equal(
			spec.env[`${prefix}_DATABASE_URL`],
			input.databaseUrls[spec.app]
		);
		assert.equal(
			spec.env.RABBITMQ_CONNECTION_NAME,
			`winwidget-${spec.label}`
		);
		assert.equal(
			spec.env.RABBITMQ_URL,
			input.broker[
				identity
					? 'identity_publisher'
					: spec.role === 'worker'
						? 'worker'
						: 'publisher'
			]
		);
		assert.deepEqual(
			Object.keys(spec.env).filter(key => key.endsWith('_DATABASE_URL')),
			[`${prefix}_DATABASE_URL`]
		);
		if (identity) assert.equal(spec.env.RABBITMQ_ASSERT_TOPOLOGY, 'false');
	}
});

test('runtime admission rejects broker, owner, database and provider drift without private values', () => {
	const mutations = [
		v => {
			v.runId = 'bad';
		},
		v => {
			delete v.broker.worker;
		},
		v => {
			v.broker.other = v.broker.worker;
			delete v.broker.worker;
		},
		v => {
			v.broker.worker = v.broker.publisher;
		},
		...[
			'https://worker:secret@127.0.0.1:5673/a_test',
			'amqp://worker:secret@remote.test:5673/a_test',
			'amqp://worker:secret@127.0.0.1:5672/a_test',
			'amqp://worker@127.0.0.1:5673/a_test',
			'amqp://worker:secret@127.0.0.1:5673/production',
			'amqp://worker:secret@127.0.0.1:5673/other_test',
			`amqp://worker:secret@127.0.0.1:5673/browser_${runId}_test?extra=1`
		].map(url => v => {
			v.broker.worker = url;
		}),
		v => {
			v.environments.identity.WINCRM_INVITATION_EMAIL_ENABLED = 'true';
		},
		v => {
			delete v.environments.identity.WINCRM_INVITATION_EMAIL_ENABLED;
		},
		v => {
			v.environments['crm-access'].CRM_ACCESS_BILLING_ENABLED = 'true';
		},
		...Object.keys(schemas).flatMap(app => [
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					'connection_limit=3',
					'connection_limit=30'
				);
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					'&connection_limit=3',
					''
				);
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					'127.0.0.1',
					'remote.test'
				);
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace('55440', '5432');
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace('_r_', '_m_');
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					'@',
					`:${canary}@`
				);
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					'sslmode=disable',
					'sslmode=require'
				);
			},
			v => {
				v.databaseUrls[app] += '&schema=foreign';
			},
			v => {
				v.databaseUrls[app] += '&options=unsafe';
			},
			v => {
				v.databaseUrls[app] += '#fragment';
			},
			v => {
				v.databaseUrls[app] = v.databaseUrls[app].replace(
					`/winwidget_${schemas[app]}_test_browser_${runId}_test`,
					'/winwidget_production'
				);
			}
		])
	];
	for (const mutate of mutations) {
		const value = sample();
		mutate(value);
		assert.throws(
			() => browserTeamProcessSpecs(value),
			error => {
				assert.equal(
					error.message,
					'Browser team runtime admission failed; values suppressed'
				);
				assert.ok(!error.message.includes(canary));
				return true;
			}
		);
	}
});

test('browser preflight consumes zero login slots, sends only bounded anonymous GETs', async () => {
	const calls = [];
	const result = await browserTeamAnonymousPreflight(
		async (url, options) => {
			calls.push([url, options]);
			return new Response(null, { status: 401 });
		}
	);
	assert.deepEqual(result, { startupLoginRequests: 0 });
	assert.deepEqual(
		calls.map(([url]) => url),
		[
			'http://localhost:4100/api/v1/crm/access/bootstrap',
			'http://localhost:4100/api/v1/billing-settings/crm'
		]
	);
	for (const [, options] of calls) {
		assert.equal(options.method, 'GET');
		assert.equal(options.redirect, 'error');
		assert.ok(options.signal instanceof AbortSignal);
		assert.equal(options.headers, undefined);
		assert.equal(options.body, undefined);
	}
	for (const status of [200, 302, 403, 429, 503])
		await assert.rejects(
			browserTeamAnonymousPreflight(
				async () => new Response(null, { status })
			)
		);
	let requests = 0;
	await assert.rejects(
		browserTeamAnonymousPreflight(async () => {
			requests++;
			throw new Error('unavailable');
		})
	);
	assert.equal(requests, 1, 'failed requests must not retry');
});

test('readiness verifies actual service revision and Identity role without weakening Access contract', () => {
	for (const spec of BROWSER_TEAM_ROLES) {
		const body = {
			status: 'ready',
			service: spec.app,
			revision: `local-browser-${runId}`,
			...(spec.app === 'identity' ? { role: spec.role } : {})
		};
		assertBrowserTeamReadiness(body, spec, body.revision);
		for (const [key, value] of [
			['status', 'ok'],
			['service', 'foreign'],
			['revision', 'old']
		])
			assert.throws(() =>
				assertBrowserTeamReadiness(
					{ ...body, [key]: value },
					spec,
					body.revision
				)
			);
		if (spec.app === 'identity')
			for (const role of ['api', 'worker', undefined])
				assert.throws(() =>
					assertBrowserTeamReadiness(
						{ ...body, role },
						spec,
						body.revision
					)
				);
	}
});

test('drain distinguishes three active consumers, closed consumers and pending/retry/dead-letter work', () => {
	assertBrowserTeamSnapshot(snapshot());
	assertBrowserTeamSnapshot(snapshot(true), true);
	assert.throws(() => assertBrowserTeamSnapshot(snapshot(true)));
	assert.throws(() => assertBrowserTeamSnapshot(snapshot(), true));
	for (const key of [
		'identityPending',
		'accessPending',
		'deliveryPending'
	]) {
		for (const value of [1, undefined, '0'])
			assert.throws(() =>
				assertBrowserTeamSnapshot({ ...snapshot(), [key]: value })
			);
	}
	for (let index = 0; index < snapshot().queues.length; index++) {
		const value = snapshot();
		value.queues[index].messageCount = 1;
		assert.throws(() => assertBrowserTeamSnapshot(value));
		const stopped = snapshot(true);
		stopped.queues[index].messageCount = 1;
		assert.throws(
			() => assertBrowserTeamSnapshot(stopped, true),
			/1 !== 0/,
			'returned unacked work must reject terminal cleanup'
		);
	}
	for (const mutate of [
		v => v.queues.pop(),
		v => v.queues.push({ ...v.queues[0] }),
		v => {
			v.queues[1].name = v.queues[0].name;
		},
		v => {
			v.queues[1].consumerCount = 1;
		},
		v => {
			v.queues[0].consumerCount = 2;
		}
	]) {
		const value = snapshot();
		mutate(value);
		assert.throws(() => assertBrowserTeamSnapshot(value));
	}
});

test('quiet window polls only observations and requires two consecutive clean snapshots', async () => {
	const observations = [
		snapshot(),
		{ ...snapshot(), accessPending: 1 },
		snapshot(),
		snapshot()
	];
	let calls = 0;
	await waitBrowserTeamQuiet(
		{
			snapshot: async () => {
				calls++;
				return observations.shift();
			}
		},
		clock()
	);
	assert.equal(calls, 4);
	await assert.rejects(
		waitBrowserTeamQuiet(
			{ snapshot: async () => ({ ...snapshot(), identityPending: 1 }) },
			{ ...clock(), timeoutMs: 500 }
		),
		/did not drain/
	);
	let failed = 0;
	await assert.rejects(
		waitBrowserTeamQuiet(
			{
				snapshot: async () => {
					failed++;
					throw new Error('read failed');
				}
			},
			clock()
		),
		/read failed/
	);
	assert.equal(failed, 1);
});

test('graceful stop signals only selected owned process groups and never escalates', async () => {
	const children = new Map(
		['frontend', 'api', 'worker', 'already-exited'].map((name, index) => [
			name,
			{ child: { pid: 500 + index }, exited: name === 'already-exited' }
		])
	);
	const sent = [];
	await stopBrowserTeamChildren(
		children,
		['frontend', 'worker', 'already-exited'],
		{
			...clock(),
			signal: (pid, signal) => {
				sent.push([pid, signal]);
				for (const state of children.values())
					if (state.child.pid === -pid) state.exited = true;
			}
		}
	);
	assert.deepEqual(sent, [
		[-500, 'SIGTERM'],
		[-502, 'SIGTERM']
	]);
	assert.equal(children.get('api').exited, false);
	const hung = new Map([
		['worker', { child: { pid: 900 }, exited: false }]
	]);
	const refused = [];
	await assert.rejects(
		stopBrowserTeamChildren(hung, ['worker'], {
			...clock(),
			timeoutMs: 200,
			signal: (...args) => refused.push(args)
		}),
		/no forced kill/
	);
	assert.deepEqual(refused, [[-900, 'SIGTERM']]);
	await assert.rejects(
		stopBrowserTeamChildren(hung, ['worker'], {
			...clock(),
			timeoutMs: 200,
			signal: () => {
				throw Object.assign(new Error(), { code: 'ESRCH' });
			}
		}),
		/no forced kill/
	);
	for (const pid of [0, 1, -1, undefined, 1.5])
		await assert.rejects(
			stopBrowserTeamChildren(
				new Map([['bad', { child: { pid }, exited: false }]]),
				['bad'],
				{ signal: () => assert.fail('must not signal invalid PID') }
			)
		);
});

test('actual detached Node child exits gracefully on owned group SIGTERM', async () => {
	const child = spawn(
		process.execPath,
		[
			'-e',
			"process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"
		],
		{ detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	const state = { child, exited: false };
	child.once('exit', () => {
		state.exited = true;
	});
	try {
		await once(child.stdout, 'data');
		await stopBrowserTeamChildren(new Map([['owned', state]]), ['owned'], {
			timeoutMs: 5000
		});
		assert.equal(child.exitCode, 0);
	} finally {
		if (!state.exited)
			await stopBrowserTeamChildren(
				new Map([['owned', state]]),
				['owned'],
				{ timeoutMs: 5000 }
			);
	}
});

test('tracked harness and CI wire the opt-in observer to real entrypoints, not manual publishers', async () => {
	const harness = await readFile(
		join(root, 'local-wincrm-stack.mjs'),
		'utf8'
	);
	const module = await readFile(
		join(root, 'local-browser-team.mjs'),
		'utf8'
	);
	const ci = await readFile(
		join(root, '../../../../.github/workflows/ci.yml'),
		'utf8'
	);
	assert.ok(
		harness.indexOf('browserTeamRequested(process.argv.slice(2))') <
			harness.indexOf("process.argv[2] === '--refresh-frontends'")
	);
	assert.match(
		harness,
		/await start\(\s*spec\.label,\s*process\.execPath,\s*\[spec\.entrypoint\],\s*spec\.env\s*\)/
	);
	assert.match(
		harness,
		/if \(withBrowserTeam\) \{\s*await browserTeamAnonymousPreflight\(\);/
	);
	assert.match(harness, /else await smoke\(accounts\)/);
	assert.match(
		harness,
		/preserveResources: failure \|\| !drained \|\| exitCode !== 0/
	);
	assert.doesNotMatch(
		module,
		/\.publishOne\(|\.publish\(|\.sendToQueue\(|SIGKILL|\.sign\(/
	);
	assert.match(
		ci,
		/node --test apps\/crm-access\/test\/integration\/local-frontends\.test\.mjs apps\/crm-access\/test\/integration\/local-browser-team\.test\.mjs/
	);
});
