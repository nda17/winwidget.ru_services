import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
	NATIVE_IMAGE_APPS,
	NATIVE_IMAGE_ROLES,
	nativeBrokerPermissions,
	nativeDiagnosticCodes,
	nativeImageArguments,
	nativeImageEnvironment,
	nativeRevisionPath,
	NativeImageRuntime
} from './local-native-images.mjs';
import { verifyNativeInboxAcceptance } from './local-native-inbox-workflow.mjs';
import { assertPendingWidgetControlRetry } from './local-native-images-workflow.mjs';

const revision = 'a'.repeat(40);
const flags = [
	'--backend-only',
	'--activate-owner',
	'--with-widgets',
	'--verify-native-images',
	'--smoke-and-stop'
];

test('control image retry requires the same immutable command and a durable five-second MAIN publication', () => {
	const payload = {
		eventId: 'event',
		commandId: 'command',
		sourceId: 'source',
		workspaceId: 'workspace'
	};
	const original = { id: 'initial', eventId: 'event', payload };
	const job = {
		...payload,
		activeEventId: 'event',
		status: 'PENDING',
		lastErrorCode: 'DEPENDENCY_UNAVAILABLE'
	};
	const receipt = {
		...payload,
		consumer: 'crm-intake.widget-control.v1',
		status: 'FAILED',
		retryAttempt: 0
	};
	const outbox = {
		id: 'retry',
		eventId: 'event',
		payload,
		status: 'PENDING',
		route: 'MAIN',
		retryAttempt: 1,
		publishedAt: null,
		lastErrorCode: 'DEPENDENCY_UNAVAILABLE',
		createdAt: new Date('2026-09-06T10:00:00Z'),
		availableAt: new Date('2026-09-06T10:00:05Z')
	};
	const fixture = { job, receipt, outbox, original };
	assertPendingWidgetControlRetry(fixture);
	for (const patch of [
		{ status: 'PUBLISHED' },
		{ route: 'RETRY_1' },
		{ retryAttempt: 0 },
		{ publishedAt: new Date() },
		{ payload: { ...payload, commandId: 'other' } },
		{ eventId: 'other' },
		{ id: 'initial' },
		{ availableAt: outbox.createdAt },
		{ availableAt: new Date('2026-09-06T10:00:30Z') }
	])
		assert.throws(() =>
			assertPendingWidgetControlRetry({
				...fixture,
				outbox: { ...outbox, ...patch }
			})
		);
	for (const patch of [
		{ status: 'DELIVERED' },
		{ retryAttempt: 1 },
		{ consumer: 'other' },
		{ sourceId: 'other' }
	])
		assert.throws(() =>
			assertPendingWidgetControlRetry({
				...fixture,
				receipt: { ...receipt, ...patch }
			})
		);
	for (const patch of [
		{ status: 'PROCESSING' },
		{ activeEventId: 'other' },
		{ workspaceId: 'other' }
	])
		assert.throws(() =>
			assertPendingWidgetControlRetry({
				...fixture,
				job: { ...job, ...patch }
			})
		);
});

test('CRM and dependency builds prefer IPv4 only for dependency download without changing runtime DNS or TLS', async () => {
	for (const app of NATIVE_IMAGE_APPS) {
		const source = await readFile(
			new URL(`../../../${app}/Dockerfile`, import.meta.url),
			'utf8'
		);
		assert.match(
			source,
			/NODE_OPTIONS=--dns-result-order=ipv4first corepack prepare pnpm@\$\{PNPM_VERSION\} --activate/
		);
		if (['identity', 'billing', 'crm-access'].includes(app)) {
			assert.match(source, /ARG PNPM_VERSION=9\.15\.9/);
			assert.match(source, /for attempt in 1 2 3; do/);
			assert.match(source, /if \[ "\$attempt" = 3 \]; then exit 1; fi/);
			assert.ok(
				source.indexOf('corepack prepare') <
					source.indexOf('COPY package.json pnpm-lock.yaml')
			);
			const manifest = JSON.parse(
				await readFile(
					new URL(`../../../${app}/package.json`, import.meta.url),
					'utf8'
				)
			);
			assert.equal(manifest.packageManager, 'pnpm@9.15.9');
		}
		assert.doesNotMatch(
			source,
			/ENV\s+NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|strict-ssl=false/
		);
	}
});

test('native failure diagnostics retain driver codes but never raw log or secret values', () => {
	assert.deepEqual(
		nativeDiagnosticCodes(
			'password=synthetic-only token=synthetic-token P2024 PrismaClientKnownRequestError P2024 55P03'
		),
		['55P03', 'P2024', 'PrismaClientKnownRequestError']
	);
	assert.deepEqual(
		nativeDiagnosticCodes(
			'https://private.invalid credentials=synthetic-only'
		),
		[]
	);
});

test('acceptance driver respects the actual unpaginated pipeline query contract', async () => {
	const stop = new Error('Stop before synthetic business commands');
	const workspaceId = '11111111-1111-4111-8111-111111111111';
	await assert.rejects(
		verifyNativeInboxAcceptance({
			workspaceId,
			request: async path => {
				assert.equal(
					path,
					'/crm/sales/pipelines?workspaceId=' + workspaceId
				);
				throw stop;
			}
		}),
		error => error === stop
	);
});

test('native image proof is an explicit standalone non-interactive profile', () => {
	assert.equal(nativeImageArguments(flags), true);
	assert.equal(nativeImageArguments([]), false);
	assert.equal(nativeImageArguments(['--browser-team']), false);
	for (const flag of flags.filter(
		flag => flag !== '--verify-native-images'
	))
		assert.throws(() =>
			nativeImageArguments(flags.filter(item => item !== flag))
		);
	for (const flag of [
		'--browser-team',
		'--verify-native-widget-http',
		'--activate-owner'
	])
		assert.throws(() => nativeImageArguments([...flags, flag]));
});

test('eight actual API images and seven dedicated background processes have immutable definitions', () => {
	assert.equal(NATIVE_IMAGE_APPS.length, 8);
	assert.equal(NATIVE_IMAGE_ROLES.length, 7);
	assert.equal(new Set(NATIVE_IMAGE_ROLES.map(item => item[3])).size, 7);
	assert.ok(Object.isFrozen(NATIVE_IMAGE_APPS));
	assert.ok(Object.isFrozen(NATIVE_IMAGE_ROLES));
	assert.ok(NATIVE_IMAGE_ROLES.every(Object.isFrozen));
	assert.ok(
		NATIVE_IMAGE_ROLES.every(
			item => item[2] !== 'all' && NATIVE_IMAGE_APPS.includes(item[1])
		)
	);
});

test('each native and acceptance worker reads only its queue; publishers cannot consume or configure', () => {
	for (const [label, app, role] of NATIVE_IMAGE_ROLES) {
		const [configure, write, read] = nativeBrokerPermissions(label).map(
			value => new RegExp(value)
		);
		const queue = label.includes('widget-control')
			? 'winwidget.crm-intake.widget-control.v1'
			: label.includes('widget-transfer')
				? 'winwidget.crm-intake.widget-transfer.v1'
				: 'winwidget.crm-intake.acceptance.v1';
		for (const name of [
			'winwidget.crm-intake.acceptance.v1',
			'winwidget.crm-intake.widget-control.v1',
			'winwidget.crm-intake.widget-transfer.v1',
			'winwidget.events',
			'unrelated'
		]) {
			assert.equal(configure.test(name), false);
			assert.equal(
				read.test(name),
				role.endsWith('worker') && name === queue
			);
		}
		const ownExchange =
			app === 'widgets'
				? 'winwidget.events'
				: label.includes('acceptance')
					? 'winwidget.crm-intake.events'
					: label.includes('widget-control')
						? 'winwidget.crm-intake.widget-control.events'
						: 'winwidget.crm-intake.widget-transfer.events';
		for (const name of [
			'winwidget.events',
			'winwidget.crm-intake.events',
			'winwidget.crm-intake.widget-control.events',
			'winwidget.crm-intake.widget-transfer.events',
			'winwidgetXcrm-intakeXevents'
		])
			assert.equal(
				write.test(name),
				!role.endsWith('worker') && name === ownExchange
			);
	}
	assert.throws(() => nativeBrokerPermissions('unreviewed-publisher'));
});

test('release images retain production guards and remove only test provider overrides', () => {
	const values = {
		NODE_ENV: 'test',
		MODE: 'development',
		APP_REVISION: 'not-a-release',
		CLOUDFLARE_AI_API_ORIGIN: 'http://localhost:1',
		CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN: 'http://localhost:2',
		WIDGETS_PROCESS_ROLE: 'api',
		OMITTED: undefined
	};
	const env = nativeImageEnvironment('widgets', values, revision);
	assert.equal(env.NODE_ENV, 'production');
	assert.equal(env.MODE, 'production');
	assert.equal(env.APP_REVISION, revision);
	assert.equal(env.WIDGETS_PROCESS_ROLE, 'api');
	assert.equal('OMITTED' in env, false);
	assert.equal('CLOUDFLARE_AI_API_ORIGIN' in env, false);
	assert.equal('CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN' in env, false);
	assert.equal(values.NODE_ENV, 'test');
	const identity = nativeImageEnvironment('identity', {}, revision);
	assert.equal(
		new URL(identity.IDENTITY_AVATAR_S3_ENDPOINT).protocol,
		'https:'
	);
});

for (const [role, connections] of [
	['api', 5],
	['widget-transfer-worker', 4],
	['widget-transfer-publisher', 1]
]) {
	test(`bounded CRM pool for ${role} preserves service-owned database`, () => {
		const values = {
			CRM_INTAKE_PROCESS_ROLE: role,
			CRM_INTAKE_DATABASE_URL:
				'postgresql://local_test@127.0.0.1:55440/isolated_test?schema=crm_intake&connection_limit=1'
		};
		const env = nativeImageEnvironment('crm-intake', values, revision);
		const url = new URL(env.CRM_INTAKE_DATABASE_URL);
		assert.equal(
			url.searchParams.get('connection_limit'),
			String(connections)
		);
		assert.equal(url.searchParams.get('pool_timeout'), '10');
		assert.equal(url.searchParams.get('schema'), 'crm_intake');
		assert.equal(url.pathname, '/isolated_test');
		assert.equal(url.username, 'local_test');
	});
}

test('runtime refuses migration credentials, non-string environment and invalid revision', () => {
	assert.throws(() =>
		nativeImageEnvironment(
			'crm-intake',
			{ CRM_INTAKE_MIGRATION_DATABASE_URL: 'forbidden' },
			revision
		)
	);
	assert.throws(() =>
		nativeImageEnvironment('billing', { BILLING_PORT: 4800 }, revision)
	);
	assert.throws(() =>
		nativeImageEnvironment('billing', { 'invalid-key': 'x' }, revision)
	);
	assert.throws(() =>
		nativeImageEnvironment('billing', {}, 'uncommitted')
	);
	assert.throws(() => nativeImageEnvironment('core', {}, revision));
});

test('revision checks match existing HTTP contracts without inventing a Gateway endpoint', async () => {
	for (const app of NATIVE_IMAGE_APPS) {
		const path = nativeRevisionPath(app);
		if (app === 'api-gateway') {
			assert.equal(path, null);
			continue;
		}
		const controller = await readFile(
			new URL(
				`../../../${app}/src/health/${app}-health.controller.ts`,
				import.meta.url
			),
			'utf8'
		);
		assert.ok(controller.includes(`@Get('${path.split('/').at(-1)}')`));
	}
	assert.throws(() => nativeRevisionPath('core'));
});

test('container ownership checks reject another run or a relabelled foreign resource', async () => {
	const runtime = new NativeImageRuntime({
		servicesRoot: '.',
		stateDirectory: '.',
		runId: '0123456789',
		log() {}
	});
	const id = 'a'.repeat(64);
	const expected = {
		Id: id,
		Name: '/wincrm-native-images-0123456789-widgets',
		Config: { Labels: { 'winwidget.test': runtime.label } }
	};
	runtime.docker = async () => JSON.stringify([expected]);
	assert.deepEqual(await runtime.inspect(id), expected);
	for (const item of [
		{ ...expected, Id: 'b'.repeat(64) },
		{ ...expected, Name: '/winwidget-production' },
		{
			...expected,
			Config: { Labels: { 'winwidget.test': 'foreign-test' } }
		}
	]) {
		runtime.docker = async () => JSON.stringify([item]);
		await assert.rejects(runtime.inspect(id));
	}
	await assert.rejects(runtime.inspect('widgets'));
});

test('image workflow never composes or monkeypatches business workers in the host process', async () => {
	const workflow = await readFile(
		new URL('./local-native-images-workflow.mjs', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(
		workflow,
		/dist\/src|\.prototype\s*\[|logger\s*=|\.processEvent\(|management\/api/
	);
	assert.match(workflow, /runtime\.startNativeRole/);
	assert.match(workflow, /channel\.ack\(message\)/);
	assert.match(workflow, /\.consume\(/);
	assert.match(workflow, /capacityVerified: false/);
	assert.match(workflow, /browserVerified: false/);
	assert.match(workflow, /postgresInstances: 1/);
	assert.match(workflow, /assertPendingWidgetControlRetry\(/);
	assert.match(workflow, /controlDurableRetryRestartVerified: true/);
	assert.match(workflow, /controlCommittedReplayVerified: true/);
	assert.match(
		workflow,
		/assert\.deepEqual\(await controlSnapshot\(\), beforeControlReplay\)/
	);
});

test('native Inbox scope and acceptance proof uses actual HTTP and push workers with separate evidence', async () => {
	const source = await readFile(
		new URL('./local-native-inbox-workflow.mjs', import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(
		source,
		/dist\/src|\.prototype|\.processEvent\(|intakeDb\.\w+\.(?:update|create|delete)|Date\.now\s*=/
	);
	for (const marker of [
		'CREATE_FROM_ENTRY',
		'EXISTING',
		'RETRY_SCHEDULED',
		'RETRY_WAIT',
		'nativeCrossWorkspaceDenied',
		'nativeTeamRevocationVerified',
		'acceptanceBrokerReplayVerified',
		'publishedAt.getTime() >= original.availableAt.getTime()',
		'invitationAdmissionVerified: false'
	])
		assert.ok(source.includes(marker));
	const driver = await readFile(
		new URL('./local-native-images-workflow.mjs', import.meta.url),
		'utf8'
	);
	assert.match(driver, /verifyNativeInboxScope\(/);
	assert.match(driver, /verifyNativeInboxAcceptance\(/);
});

test('image profile retains existing native quota fixture and granular writer grants', async () => {
	const harness = await readFile(
		new URL('./local-wincrm-stack.mjs', import.meta.url),
		'utf8'
	);
	assert.match(
		harness,
		/if \(withNativeWidgetHttp \|\| withNativeImages\)\s*await tx\.widgetUsageCounter\.create/
	);
	assert.match(
		harness,
		/withNativeWidgetHttp \|\| withNativeImages\s*\? \['quiz_leads'\]/
	);
	assert.match(
		harness,
		/withNativeWidgetHttp \|\| withNativeImages\s*\? \{ UPDATE: \['outbox_events'\] \}/
	);
	assert.match(
		harness,
		/withNativeWidgetHttp \|\| withNativeImages\s*\? \['aggregate_versions', 'source_sequences'\]/
	);
	assert.match(
		harness,
		/if \(exitCode === 0 && nativeImageEvidence\)\s*await nativeImages\.finish\(nativeImageEvidence\)/
	);
});

test('successful image proof cannot be written before owned cleanup or for another revision', async () => {
	const runtime = new NativeImageRuntime({
		servicesRoot: '.',
		stateDirectory: '.',
		runId: '0123456789',
		log() {}
	});
	runtime.revision = revision;
	await assert.rejects(runtime.finish({ revision }));
	runtime.closed = true;
	runtime.owned = [{ id: 'a'.repeat(64), label: 'owned' }];
	await assert.rejects(runtime.finish({ revision }));
	runtime.owned = [];
	await assert.rejects(runtime.finish({ revision: 'b'.repeat(40) }));
});
