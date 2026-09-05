import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
	FRONTEND_PORTS,
	FRONTEND_REVISION,
	createFrontendProxyHandlers,
	frontendProcesses,
	frontendSnapshot,
	mainFrontendTarget,
	prepareFrontendMirror,
	refreshFrontendMirror,
	resolveFrontendSource
} from './local-frontends.mjs';

const put = async (root, file, value = file) => {
	const path = join(root, file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value);
};
async function fixture(t) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'wincrm-frontend-unit-'))
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, 'winwidget.ru_client');
	const stateDirectory = join(root, 'state');
	await mkdir(stateDirectory, { mode: 0o700 });
	await put(
		source,
		'package.json',
		JSON.stringify({ name: 'winwidget-frontends' })
	);
	await put(
		source,
		'pnpm-workspace.yaml',
		'packages: [apps/*, packages/*]'
	);
	await put(source, 'tsconfig.base.json', '{}');
	await put(source, 'scripts/example.mjs');
	await put(source, 'public/logo.svg');
	await put(source, 'packages/winwidget-web/src/shared.ts');
	await put(source, 'packages/winwidget-web/package.json', '{}');
	await mkdir(join(source, 'node_modules'));
	for (const app of Object.keys(FRONTEND_PORTS)) {
		await put(
			source,
			`apps/${app}/package.json`,
			JSON.stringify({
				name: app === 'crm' ? 'wincrm-client' : `@winwidget/${app}`
			})
		);
		await put(source, `apps/${app}/src/app/page.tsx`);
		await put(source, `apps/${app}/next.config.mjs`);
		await mkdir(join(source, 'apps', app, 'node_modules'));
	}
	return {
		root,
		source,
		stateDirectory,
		make: () =>
			prepareFrontendMirror({ workspaceRoot: root, stateDirectory })
	};
}

test('source resolver accepts only the explicit immediate monorepo workspace child', async t => {
	const f = await fixture(t);
	assert.equal(await resolveFrontendSource(f.root), f.source);
	for (const input of [
		join(f.root, 'winwidget.ru_client_crm'),
		join(f.source, 'apps/crm'),
		dirname(f.root)
	])
		await assert.rejects(resolveFrontendSource(f.root, input));
	await symlink(f.source, join(f.root, 'winwidget.ru_frontends'));
	await assert.rejects(
		resolveFrontendSource(f.root, join(f.root, 'winwidget.ru_frontends'))
	);
});

test('one mirror contains all four apps and shared sources with only owned dependency symlinks', async t => {
	const f = await fixture(t);
	const snapshot = await f.make();
	assert.match(snapshot.sourceHash, /^[a-f0-9]{64}$/);
	assert.deepEqual(
		(await frontendSnapshot(snapshot.mirror)).files,
		snapshot.files
	);
	assert.ok(
		await lstat(join(snapshot.mirror, 'node_modules')).then(info =>
			info.isSymbolicLink()
		)
	);
	assert.ok(
		await lstat(join(snapshot.mirror, 'apps/crm/src')).then(
			info => info.isDirectory() && !info.isSymbolicLink()
		)
	);
	const specs = frontendProcesses(snapshot);
	assert.deepEqual(
		specs.map(spec => spec.port),
		[3100, 3002, 3003, 3001]
	);
	assert.ok(
		specs.every(spec => spec.cwd.startsWith(`${snapshot.mirror}/apps/`))
	);
	assert.equal(
		specs
			.filter(spec => spec.args.includes('--webpack'))
			.map(spec => spec.app)
			.join(),
		'crm'
	);
	assert.match(FRONTEND_REVISION, /^[a-f0-9]{40}$/);
});

test('repository rename is explicit and package manifests cannot redirect through a symlink', async t => {
	const f = await fixture(t);
	const renamed = join(f.root, 'winwidget.ru_frontends');
	await rename(f.source, renamed);
	await assert.rejects(resolveFrontendSource(f.root));
	assert.equal(await resolveFrontendSource(f.root, renamed), renamed);
	const manifest = join(renamed, 'apps/crm/package.json');
	await unlink(manifest);
	await symlink('/must-not-be-read', manifest);
	await assert.rejects(resolveFrontendSource(f.root, renamed));
});

test('snapshots exclude env, Git, dependency/build artifacts and prohibited folders without following them', async t => {
	const f = await fixture(t);
	const before = await frontendSnapshot(f.source);
	for (const name of ['.env.production', '.git', 'TEMP', 'other_files'])
		await symlink(
			'/does-not-exist-and-must-not-be-read',
			join(f.source, 'apps/crm', name)
		);
	await put(f.source, 'apps/crm/.next/generated.js');
	await put(f.source, 'apps/widgets/public/generated-logo.svg');
	await put(f.source, 'apps/crm/next-env.d.ts');
	assert.deepEqual((await frontendSnapshot(f.source)).files, before.files);
	const snapshot = await f.make();
	await assert.rejects(
		lstat(join(snapshot.mirror, 'apps/crm/.env.production')),
		{ code: 'ENOENT' }
	);
});

test('source symlinks and externally redirected dependency directories fail closed', async t => {
	const f = await fixture(t);
	await symlink(
		'/not-readable',
		join(f.source, 'apps/crm/src/foreign.ts')
	);
	await assert.rejects(frontendSnapshot(f.source));
	await unlink(join(f.source, 'apps/crm/src/foreign.ts'));
	await rm(join(f.source, 'apps/crm/node_modules'), { recursive: true });
	await symlink(f.root, join(f.source, 'apps/crm/node_modules'));
	await assert.rejects(f.make());
});

test('refresh updates hashes and removes only previously owned unchanged stale source', async t => {
	const f = await fixture(t);
	const previous = await f.make();
	await put(f.source, 'apps/widgets/src/app/page.tsx', 'new-page');
	await unlink(join(f.source, 'apps/crm/src/app/page.tsx'));
	await put(f.source, 'apps/crm/src/app/inbox/page.tsx', 'new-inbox');
	const next = await refreshFrontendMirror({
		...f,
		mirror: previous.mirror,
		previous
	});
	assert.notEqual(next.sourceHash, previous.sourceHash);
	assert.equal(
		await readFile(
			join(next.mirror, 'apps/widgets/src/app/page.tsx'),
			'utf8'
		),
		'new-page'
	);
	await assert.rejects(
		lstat(join(next.mirror, 'apps/crm/src/app/page.tsx')),
		{ code: 'ENOENT' }
	);
	assert.deepEqual(
		(await frontendSnapshot(next.mirror)).files,
		next.files
	);
});

test('unknown and edited mirror files are preserved and stop refresh before source writes', async t => {
	const f = await fixture(t);
	const previous = await f.make();
	await put(previous.mirror, 'apps/widgets/src/unknown.ts', 'preserve');
	await put(f.source, 'apps/widgets/src/app/page.tsx', 'new-page');
	await assert.rejects(
		refreshFrontendMirror({ ...f, mirror: previous.mirror, previous })
	);
	assert.equal(
		await readFile(
			join(previous.mirror, 'apps/widgets/src/unknown.ts'),
			'utf8'
		),
		'preserve'
	);
	assert.equal(
		await readFile(
			join(previous.mirror, 'apps/widgets/src/app/page.tsx'),
			'utf8'
		),
		'apps/widgets/src/app/page.tsx'
	);
	await unlink(join(previous.mirror, 'apps/widgets/src/unknown.ts'));
	await put(
		previous.mirror,
		'apps/widgets/src/app/page.tsx',
		'local-edit'
	);
	await assert.rejects(
		refreshFrontendMirror({ ...f, mirror: previous.mirror, previous })
	);
	assert.equal(
		await readFile(
			join(previous.mirror, 'apps/widgets/src/app/page.tsx'),
			'utf8'
		),
		'local-edit'
	);
});

test('wrong mirror ownership, corrupt inventory and dependency replacement cannot refresh', async t => {
	const f = await fixture(t);
	const previous = await f.make();
	await assert.rejects(
		refreshFrontendMirror({ ...f, mirror: f.source, previous })
	);
	await assert.rejects(
		refreshFrontendMirror({
			...f,
			mirror: previous.mirror,
			previous: { ...previous, sourceHash: '0'.repeat(64) }
		})
	);
	await unlink(join(previous.mirror, 'node_modules'));
	await symlink(f.root, join(previous.mirror, 'node_modules'));
	await assert.rejects(
		refreshFrontendMirror({ ...f, mirror: previous.mirror, previous })
	);
	await chmod(f.stateDirectory, 0o755);
	await assert.rejects(
		refreshFrontendMirror({ ...f, mirror: previous.mirror, previous })
	);
});

test('main proxy route matrix preserves Nginx business/asset namespaces and query suffixes', () => {
	assert.equal(mainFrontendTarget('/ad%6din/settings'), 'admin-panel');
	assert.equal(mainFrontendTarget('/unknown/%2e%2e/login'), 'widgets');
	assert.equal(
		mainFrontendTarget('/_frontends/widgets/%5fnext/static/app.js'),
		'widgets'
	);
	assert.throws(() => mainFrontendTarget('/bad%00path'));
	assert.throws(() => mainFrontendTarget('/bad%zzpath'));
	for (const prefix of [
		'cabinet',
		'payment',
		'login',
		'register',
		'restore-password',
		'social-auth',
		'logout',
		'wheels',
		'quizzes',
		'callbacks',
		'timers',
		'stop-offers',
		'calculators',
		'page-wheel',
		'page-quiz',
		'page-callback',
		'page-timer',
		'page-stop-offer',
		'page-ai-consultant',
		'page-calculator'
	]) {
		for (const suffix of ['', '/', '/example', '?returnUrl=%2Fadmin'])
			assert.equal(mainFrontendTarget(`/${prefix}${suffix}`), 'widgets');
		assert.equal(mainFrontendTarget(`/${prefix}-other`), 'landing');
	}
	for (const app of ['landing', 'widgets', 'admin-panel'])
		for (const asset of [
			'static/chunks/app.js',
			'image?url=%2Ficon.png&w=64&q=75',
			'webpack-hmr'
		])
			assert.equal(
				mainFrontendTarget(`/_frontends/${app}/_next/${asset}`),
				app
			);
	for (const route of [
		'/_frontends/unknown/_next/static/x.js',
		'/_frontends/crm/_next/image',
		'/_frontends/widgets/health',
		'/_frontends/widgets/_next-malformed'
	])
		assert.equal(mainFrontendTarget(route), null);
	assert.equal(
		mainFrontendTarget('/admin/crm?workspaceId=opaque'),
		'admin-panel'
	);
	assert.equal(mainFrontendTarget('/administrator'), 'landing');
	assert.equal(
		mainFrontendTarget('/_next/image?url=%2Ficon.png&w=64&q=75'),
		'landing'
	);
	for (const route of [
		'https://example.com',
		'//example.com/path',
		'/bad\\path',
		'/bad\npath'
	])
		assert.throws(() => mainFrontendTarget(route));
});

function connection() {
	const stream = new EventEmitter();
	stream.writes = [];
	stream.write = bytes => {
		stream.writes.push(bytes.toString());
		return true;
	};
	stream.pipe = target => {
		stream.piped = target;
		return target;
	};
	stream.destroy = () => {
		stream.destroyed = true;
	};
	return stream;
}
test('HTTP proxy preserves method, exact URI/query and opaque cookies without backend destinations', () => {
	let options;
	const upstream = new EventEmitter();
	upstream.setTimeout = () => {};
	upstream.destroy = () => {};
	const handlers = createFrontendProxyHandlers({
		request: input => {
			options = input;
			return upstream;
		}
	});
	const req = connection();
	Object.assign(req, {
		url: '/social-auth?code=opaque&returnUrl=%2Fadmin',
		method: 'POST',
		headers: { cookie: 'synthetic=value' }
	});
	const res = connection();
	handlers.http(req, res);
	assert.deepEqual(options, {
		hostname: '127.0.0.1',
		port: 3002,
		method: 'POST',
		path: req.url,
		headers: { cookie: 'synthetic=value', host: 'localhost:3000' }
	});
	assert.equal(req.piped, upstream);
});
test('WS upgrade uses the selected Next namespace and bidirectionally forwards buffered head bytes', () => {
	let options;
	const upstream = new EventEmitter();
	upstream.setTimeout = () => {};
	upstream.end = () => {};
	const handlers = createFrontendProxyHandlers({
		request: input => {
			options = input;
			return upstream;
		}
	});
	const socket = connection();
	const peer = connection();
	handlers.upgrade(
		{
			url: '/_frontends/admin-panel/_next/webpack-hmr',
			method: 'GET',
			headers: { upgrade: 'websocket' }
		},
		socket,
		Buffer.from('client-head')
	);
	assert.equal(options.port, 3003);
	upstream.emit(
		'upgrade',
		{
			statusCode: 101,
			statusMessage: 'Switching Protocols',
			rawHeaders: ['Upgrade', 'websocket', 'Connection', 'Upgrade']
		},
		peer,
		Buffer.from('server-head')
	);
	assert.equal(peer.writes[0], 'client-head');
	assert.ok(
		socket.writes[0].startsWith('HTTP/1.1 101 Switching Protocols\r\n')
	);
	assert.equal(socket.writes[1], 'server-head');
	assert.equal(peer.piped, socket);
	assert.equal(socket.piped, peer);
	socket.emit('close');
	assert.equal(peer.destroyed, true);
});
test('unknown namespace never opens HTTP or WS upstream', () => {
	const handlers = createFrontendProxyHandlers({
		request: () => assert.fail('No upstream permitted')
	});
	const res = {
		writeHead(status) {
			this.status = status;
			return this;
		},
		end() {}
	};
	handlers.http({ url: '/_frontends/unknown/_next/x' }, res);
	assert.equal(res.status, 404);
	const socket = connection();
	handlers.upgrade(
		{ url: '/_frontends/unknown/_next/x' },
		socket,
		Buffer.alloc(0)
	);
	assert.equal(socket.destroyed, true);
});
