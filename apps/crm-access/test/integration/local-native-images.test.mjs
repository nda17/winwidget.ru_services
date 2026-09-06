import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
	NATIVE_IMAGE_APPS,
	NATIVE_IMAGE_ROLES,
	nativeImageArguments,
	nativeImageEnvironment,
	nativeRevisionPath,
	NativeImageRuntime
} from './local-native-images.mjs';

const revision = 'a'.repeat(40);
const flags = [
	'--backend-only',
	'--activate-owner',
	'--with-widgets',
	'--verify-native-images',
	'--smoke-and-stop'
];

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

test('eight actual API images and five dedicated background processes have immutable definitions', () => {
	assert.equal(NATIVE_IMAGE_APPS.length, 8);
	assert.equal(NATIVE_IMAGE_ROLES.length, 5);
	assert.equal(new Set(NATIVE_IMAGE_ROLES.map(item => item[3])).size, 5);
	assert.ok(Object.isFrozen(NATIVE_IMAGE_APPS));
	assert.ok(Object.isFrozen(NATIVE_IMAGE_ROLES));
	assert.ok(NATIVE_IMAGE_ROLES.every(Object.isFrozen));
	assert.ok(
		NATIVE_IMAGE_ROLES.every(
			item => item[2] !== 'all' && NATIVE_IMAGE_APPS.includes(item[1])
		)
	);
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
