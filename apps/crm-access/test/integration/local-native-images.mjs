import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NATIVE_IMAGE_APPS = Object.freeze([
	'identity',
	'billing',
	'widgets',
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales',
	'api-gateway'
]);
export const NATIVE_IMAGE_ROLES = Object.freeze(
	[
		[
			'crm-intake-widget-control-worker',
			'crm-intake',
			'widget-control-worker',
			5313
		],
		[
			'crm-intake-widget-control-publisher',
			'crm-intake',
			'widget-control-publisher',
			5314
		],
		[
			'crm-intake-widget-transfer-worker',
			'crm-intake',
			'widget-transfer-worker',
			5315
		],
		[
			'crm-intake-widget-transfer-publisher',
			'crm-intake',
			'widget-transfer-publisher',
			5316
		],
		['widgets-publisher', 'widgets', 'publisher', 4701]
	].map(Object.freeze)
);
export const NATIVE_IMAGE_BROKER =
	'rabbitmq:4.2.9-management-alpine@sha256:0ab90fc05c41e9d2d8f11af5036e466c364adf5085ed83c477ab41aec0bdde86';
export const NATIVE_TRANSFER_EVENT =
	'widgets.wincrm.lead-transfer.requested.v1';
export const NATIVE_TRANSFER_QUEUE =
	'winwidget.crm-intake.widget-transfer.v1';
export const NATIVE_CONTROL_EVENT =
	'crm.intake.widget-control.requested.v1';
export const NATIVE_CONTROL_QUEUE =
	'winwidget.crm-intake.widget-control.v1';

export function nativeRevisionPath(app) {
	assert.ok(NATIVE_IMAGE_APPS.includes(app));
	if (app === 'api-gateway') return null;
	return ['billing', 'widgets', 'crm-access'].includes(app)
		? '/health/live'
		: '/health/revision';
}

export function nativeImageArguments(args) {
	if (!args.includes('--verify-native-images')) return false;
	assert.equal(
		new Set(args).size,
		args.length,
		'Duplicate image profile flag'
	);
	assert.deepEqual(
		[...args].sort(),
		[
			'--activate-owner',
			'--backend-only',
			'--smoke-and-stop',
			'--verify-native-images',
			'--with-widgets'
		].sort(),
		'The image proof is a separate non-interactive profile'
	);
	return true;
}

export function nativeImageEnvironment(app, values, revision) {
	assert.ok(NATIVE_IMAGE_APPS.includes(app));
	assert.match(revision, /^[a-f0-9]{40}$/);
	const env = Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined)
	);
	Object.assign(env, {
		NODE_ENV: 'production',
		MODE: 'production',
		APP_REVISION: revision
	});
	if (app === 'identity') {
		// No uploads in this proof. HTTPS/production validation stays enabled.
		env.IDENTITY_AVATAR_S3_ENDPOINT = 'https://127.0.0.1:59990';
		env.IDENTITY_AVATAR_S3_PUBLIC_BASE_URL =
			'https://127.0.0.1:59990/avatars';
	}
	if (app === 'widgets') {
		// Never enable test-only outbound-provider URL overrides in a release image.
		delete env.CLOUDFLARE_AI_API_ORIGIN;
		delete env.CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN;
	}
	const prefix = app.toUpperCase().replaceAll('-', '_');
	if (env[prefix + '_DATABASE_URL']) {
		const url = new URL(env[prefix + '_DATABASE_URL']);
		const role = env[prefix + '_PROCESS_ROLE'] || 'api';
		url.searchParams.set(
			'connection_limit',
			role.includes('publisher')
				? '1'
				: role.includes('worker')
					? '4'
					: '5'
		);
		url.searchParams.set('pool_timeout', '10');
		env[prefix + '_DATABASE_URL'] = url.toString();
	}
	for (const [key, value] of Object.entries(env)) {
		assert.match(key, /^[A-Z][A-Z0-9_]+$/);
		assert.equal(
			typeof value,
			'string',
			'Container settings must be strings'
		);
		assert.ok(
			!key.endsWith('_MIGRATION_DATABASE_URL'),
			'Runtime must not receive migration credentials'
		);
	}
	return env;
}

export class NativeImageRuntime {
	constructor({ servicesRoot, stateDirectory, runId, log }) {
		assert.match(runId, /^[a-f0-9]{10}$/);
		this.root = servicesRoot;
		this.directory = stateDirectory;
		this.runId = runId;
		this.label = 'native-images-' + runId;
		this.log = log;
		this.images = new Map();
		this.processes = new Map();
		this.owned = [];
		this.brokerUrls = new Map();
		this.stage = 'preflight';
		this.closed = false;
		this.baseEnvironment = {
			PATH: process.env.PATH,
			HOME: homedir(),
			LANG: 'en_US.UTF-8'
		};
	}

	async command(binary, args, { env = {}, input, timeout = 60_000 } = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn(binary, args, {
				cwd: this.root,
				env: { ...this.baseEnvironment, ...env },
				stdio: ['pipe', 'pipe', 'pipe']
			});
			let output = '';
			let diagnosticBytes = 0;
			const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
			child.stdout.on('data', bytes => {
				output = (output + bytes).slice(-2 * 1024 * 1024);
			});
			child.stderr.on('data', bytes => {
				diagnosticBytes += bytes.length;
			});
			child.once('error', () => {
				clearTimeout(timer);
				reject(new Error('Native image command failed to start'));
			});
			child.once('close', code => {
				clearTimeout(timer);
				resolve({ code, output: output.trim(), diagnosticBytes });
			});
			child.stdin.on('error', () => {});
			child.stdin.end(input);
		});
	}
	async docker(args, options) {
		const reply = await this.command(
			'docker',
			['--context', 'colima', ...args],
			options
		);
		assert.equal(
			reply.code,
			0,
			'Native image Docker command failed during ' +
				this.stage +
				'; diagnostics suppressed'
		);
		return reply.output;
	}
	async record() {
		await writeFile(
			join(this.directory, 'native-images-ownership.json'),
			JSON.stringify(
				{
					runId: this.runId,
					label: this.label,
					revision: this.revision,
					images: Object.fromEntries(this.images),
					owned: this.owned,
					stage: this.stage
				},
				null,
				2
			),
			{ mode: 0o600 }
		);
	}
	async inspect(id) {
		assert.match(id, /^[a-f0-9]{64}$/);
		const item = JSON.parse(await this.docker(['inspect', id]))[0];
		assert.equal(item.Id, id);
		assert.equal(item.Config.Labels['winwidget.test'], this.label);
		assert.ok(item.Name.startsWith('/wincrm-' + this.label + '-'));
		return item;
	}
	async wait(predicate, message, milliseconds = 120_000) {
		const end = Date.now() + milliseconds;
		do {
			const value = await predicate();
			if (value) return value;
			await new Promise(resolve => setTimeout(resolve, 250));
		} while (Date.now() < end);
		throw new Error(message);
	}
	async prepare() {
		assert.ok(
			!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT,
			'Remote Docker overrides forbidden'
		);
		assert.equal(
			(await this.command('docker', ['context', 'show'])).output,
			'colima'
		);
		assert.equal(
			await this.docker([
				'context',
				'inspect',
				'colima',
				'--format',
				'{{.Endpoints.docker.Host}}'
			]),
			'unix://' + homedir() + '/.colima/default/docker.sock'
		);
		assert.equal(
			await this.docker(['info', '--format', '{{.Name}}']),
			'colima'
		);
		const existing = (await this.docker(['ps', '-aq', '--no-trunc']))
			.split('\n')
			.filter(Boolean);
		assert.equal(
			existing.length,
			1,
			'Only the previously verified local test PostgreSQL may exist'
		);
		const postgres = JSON.parse(
			await this.docker(['inspect', existing[0]])
		)[0];
		assert.equal(postgres.Name, '/wincrm-mvp-postgres18');
		assert.equal(postgres.Config.Labels['winwidget.test'], 'crm-mvp');
		this.revision = (
			await this.command('git', ['rev-parse', 'HEAD'])
		).output;
		assert.match(this.revision, /^[a-f0-9]{40}$/);
		for (const app of NATIVE_IMAGE_APPS) await this.build(app);
		await this.prepareBroker();
	}
	async build(app) {
		this.stage = 'build-' + app;
		// Reject changed runtime inputs; the new test driver itself is not a runtime input.
		const paths = [
			'src',
			'prisma',
			'assets',
			'vendor',
			'scripts',
			'widgets-src',
			'Dockerfile',
			'package.json',
			'pnpm-lock.yaml',
			'tsconfig.json',
			'tsconfig.build.json'
		].map(path => 'apps/' + app + '/' + path);
		assert.equal(
			(
				await this.command('git', [
					'diff',
					'--quiet',
					this.revision,
					'--',
					...paths
				])
			).code,
			0,
			'Runtime inputs differ from the immutable revision'
		);
		const tag = 'winwidget-' + app + ':native-images-' + this.revision;
		const existing = await this.command('docker', [
			'--context',
			'colima',
			'image',
			'inspect',
			tag
		]);
		if (existing.code !== 0) {
			this.log(
				'Building native proof image ' +
					app +
					' ' +
					this.revision.slice(0, 8)
			);
			const archive = spawn(
				'git',
				[
					'archive',
					'--format=tar',
					...(app === 'widgets'
						? [this.revision, 'apps/widgets']
						: [this.revision + ':apps/' + app])
				],
				{
					cwd: this.root,
					env: this.baseEnvironment,
					stdio: ['ignore', 'pipe', 'ignore']
				}
			);
			const build = spawn(
				'docker',
				[
					'--context',
					'colima',
					'build',
					'--build-arg',
					'APP_REVISION=' + this.revision,
					'-t',
					tag,
					...(app === 'widgets' ? ['-f', 'apps/widgets/Dockerfile'] : []),
					'-'
				],
				{
					cwd: this.root,
					env: this.baseEnvironment,
					stdio: ['pipe', 'ignore', 'ignore']
				}
			);
			archive.stdout.pipe(build.stdin);
			build.stdin.on('error', () => {});
			const timer = setTimeout(() => {
				archive.kill('SIGTERM');
				build.kill('SIGTERM');
			}, 25 * 60_000);
			try {
				const codes = await Promise.all(
					[archive, build].map(
						child =>
							new Promise((resolve, reject) => {
								child.once('error', () =>
									reject(new Error('Image build transport failed'))
								);
								child.once('close', resolve);
							})
					)
				);
				assert.deepEqual(
					codes,
					[0, 0],
					'Immutable native image build failed; logs suppressed'
				);
			} finally {
				clearTimeout(timer);
			}
		}
		const image = JSON.parse(
			await this.docker(['image', 'inspect', tag])
		)[0];
		assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
		assert.equal(
			image.Config.Labels['org.opencontainers.image.revision'],
			this.revision
		);
		assert.ok(
			image.Config.User && !['0', 'root'].includes(image.Config.User)
		);
		assert.deepEqual(image.Config.Cmd, ['node', 'dist/src/main.js']);
		this.images.set(app, image.Id);
		await this.record();
	}
	async ownRun(label, args, env = {}) {
		const id = await this.docker(
			[
				'run',
				'-d',
				'--pull=never',
				'--name',
				'wincrm-' + this.label + '-' + label,
				'--label',
				'winwidget.test=' + this.label,
				...args
			],
			{ env }
		);
		assert.match(id, /^[a-f0-9]{64}$/);
		this.owned.push({ id, label });
		await this.record();
		await this.inspect(id);
		return id;
	}
	async prepareBroker() {
		this.stage = 'scoped-native-broker';
		await this.docker(['pull', NATIVE_IMAGE_BROKER], { timeout: 180_000 });
		const password = randomBytes(24).toString('hex');
		this.vhost = 'wincrm_native_' + this.runId + '_test';
		this.brokerId = await this.ownRun(
			'rabbitmq',
			[
				'--memory=512m',
				'--memory-swap=512m',
				'--cpus=1',
				'-p',
				'127.0.0.1:5675:5672',
				'-e',
				'RABBITMQ_DEFAULT_USER=native_provisioner',
				'-e',
				'RABBITMQ_DEFAULT_PASS',
				'-e',
				'RABBITMQ_DEFAULT_VHOST',
				'-e',
				'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2',
				NATIVE_IMAGE_BROKER
			],
			{
				RABBITMQ_DEFAULT_PASS: password,
				RABBITMQ_DEFAULT_VHOST: this.vhost
			}
		);
		await this.wait(
			async () =>
				(
					await this.command('docker', [
						'--context',
						'colima',
						'exec',
						'--user=rabbitmq',
						this.brokerId,
						'rabbitmq-diagnostics',
						'-q',
						'check_port_connectivity'
					])
				).code === 0,
			'Native broker startup deadline'
		);
		this.provisionerUrl =
			'amqp://native_provisioner:' +
			password +
			'@127.0.0.1:5675/' +
			this.vhost;
		this.amqp = createRequire(
			join(this.root, 'apps/crm-access/package.json')
		)('amqplib');
		const connection = await this.amqp.connect(this.provisionerUrl);
		try {
			const channel = await connection.createChannel();
			await channel.assertExchange('winwidget.events', 'topic', {
				durable: true
			});
			for (const [kind, queue, event] of [
				['widget-control', NATIVE_CONTROL_QUEUE, NATIVE_CONTROL_EVENT],
				['widget-transfer', NATIVE_TRANSFER_QUEUE, NATIVE_TRANSFER_EVENT]
			]) {
				const prefix = 'winwidget.crm-intake.' + kind;
				for (const suffix of ['events', 'dead-letter'])
					await channel.assertExchange(prefix + '.' + suffix, 'direct', {
						durable: true
					});
				await channel.assertQueue(queue, { durable: true });
				await channel.bindQueue(queue, prefix + '.events', event);
				await channel.assertQueue(queue + '.dead-letter', {
					durable: true
				});
				await channel.bindQueue(
					queue + '.dead-letter',
					prefix + '.dead-letter',
					event
				);
				if (kind === 'widget-transfer')
					await channel.bindQueue(queue, 'winwidget.events', event);
			}
			this.reportingQueue =
				'winwidget.native-images.reporting.' + this.runId;
			await channel.assertQueue(this.reportingQueue, { durable: true });
			await channel.bindQueue(
				this.reportingQueue,
				'winwidget.events',
				'widgets.lead.changed.v1'
			);
			await channel.close();
		} finally {
			await connection.close();
		}
		for (const [label, app, role] of NATIVE_IMAGE_ROLES) {
			const secret = randomBytes(24).toString('hex');
			const user = 'native_' + label.replaceAll('-', '_');
			await this.ctl(['add_user', user, secret]);
			const worker = role.endsWith('worker');
			const prefix =
				app === 'widgets'
					? 'winwidget.events'
					: 'winwidget.crm-intake.' +
						(role.startsWith('widget-control')
							? 'widget-control'
							: 'widget-transfer');
			const escaped = prefix.replaceAll('.', '\\.');
			await this.ctl([
				'set_permissions',
				'-p',
				this.vhost,
				user,
				'^$',
				worker
					? '^$'
					: '^' +
						escaped +
						(app === 'widgets' ? '$' : '\\.(events|dead-letter)$'),
				worker ? '^' + escaped + '\\.v1$' : '^$'
			]);
			if (app === 'widgets')
				await this.ctl([
					'set_topic_permissions',
					'-p',
					this.vhost,
					user,
					'winwidget.events',
					'^(widgets\\.lead\\.changed\\.v1|widgets\\.wincrm\\.lead-transfer\\.requested\\.v1)$',
					'^$'
				]);
			this.brokerUrls.set(
				label,
				'amqp://' + user + ':' + secret + '@127.0.0.1:5675/' + this.vhost
			);
		}
		this.log(
			'Native broker ready with five independent process principals'
		);
	}
	ctl(args) {
		return this.docker([
			'exec',
			'--user=rabbitmq',
			this.brokerId,
			'rabbitmqctl',
			...args
		]);
	}
	async migrate(service, url) {
		this.stage = 'migrate-' + service.app;
		const id = await this.ownRun(
			service.app + '-migration',
			[
				'--network=host',
				'--read-only',
				'--tmpfs',
				'/tmp:rw,nosuid,nodev,size=64m',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--memory=512m',
				'--memory-swap=512m',
				'-e',
				service.databaseVariable,
				'--entrypoint',
				'./node_modules/.bin/prisma',
				this.images.get(service.app),
				'migrate',
				'deploy',
				'--schema',
				'prisma/schema.prisma'
			],
			{ [service.databaseVariable]: url }
		);
		await this.wait(
			async () => !(await this.inspect(id)).State.Running,
			'Native image migration deadline'
		);
		const state = await this.inspect(id);
		assert.equal(
			state.State.ExitCode,
			0,
			'Native image migration failed; logs suppressed'
		);
		assert.equal(state.State.OOMKilled, false);
	}
	async start(label, app, values, port) {
		assert.ok(!this.processes.has(label), 'Image process already exists');
		assert.ok(this.images.has(app));
		this.stage = 'start-' + label;
		const env = nativeImageEnvironment(app, values, this.revision);
		const id = await this.ownRun(
			label,
			[
				'--network=host',
				'--read-only',
				'--tmpfs',
				'/tmp:rw,nosuid,nodev,size=64m',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--pids-limit=128',
				'--memory=384m',
				'--memory-swap=384m',
				'--cpus=1',
				'--restart=unless-stopped',
				...Object.keys(env).flatMap(key => ['-e', key]),
				this.images.get(app)
			],
			env
		);
		this.processes.set(label, { id, app, port });
		await this.wait(async () => {
			const item = await this.inspect(id);
			assert.equal(
				item.State.OOMKilled,
				false,
				'Native image process hit test memory cap'
			);
			assert.equal(
				item.RestartCount,
				0,
				'Native image process failed startup'
			);
			try {
				const response = await fetch(
					'http://127.0.0.1:' + port + '/health/ready',
					{ signal: AbortSignal.timeout(2000) }
				);
				await response.body?.cancel();
				return response.status === 200;
			} catch {
				return false;
			}
		}, 'Native image readiness deadline');
		const item = await this.inspect(id);
		assert.equal(item.Image, this.images.get(app));
		assert.ok(item.Config.Env.includes('APP_REVISION=' + this.revision));
		const revisionPath = nativeRevisionPath(app);
		if (revisionPath) {
			const revision = await fetch(
				'http://127.0.0.1:' + port + revisionPath,
				{ signal: AbortSignal.timeout(2000) }
			);
			assert.equal(revision.status, 200, label + ' revision HTTP status');
			assert.equal((await revision.json()).revision, this.revision);
		}
		this.log(label + ' immutable image ready');
	}
	async startNativeRole(spec, environment) {
		const [label, app, role, port] = spec;
		const prefix = app.toUpperCase().replaceAll('-', '_');
		await this.start(
			label,
			app,
			{
				...environment,
				[prefix + '_PROCESS_ROLE']: role,
				[prefix + '_PORT']: String(port),
				...(app === 'widgets'
					? {
							RABBITMQ_URL: this.brokerUrls.get(label),
							RABBITMQ_CONNECTION_NAME: label,
							RABBITMQ_ASSERT_TOPOLOGY: 'false',
							WIDGETS_OUTBOX_POLL_INTERVAL_MS: '100',
							WIDGETS_OUTBOX_BATCH_SIZE: '10'
						}
					: {
							CRM_INTAKE_RABBITMQ_URL: this.brokerUrls.get(label),
							CRM_INTAKE_RABBITMQ_ASSERT_TOPOLOGY: 'false'
						})
			},
			port
		);
	}
	async stop(id) {
		let item = await this.inspect(id);
		if (item.State.Paused) {
			await this.docker(['unpause', id]);
			item = await this.inspect(id);
		}
		await this.docker(['update', '--restart=no', id]);
		if (item.State.Running)
			await this.docker(['kill', '--signal=TERM', id]);
		await this.wait(
			async () => !(await this.inspect(id)).State.Running,
			'Owned image did not stop gracefully',
			45_000
		);
	}
	async close() {
		if (this.closed) return;
		this.stage = 'graceful-owned-cleanup';
		for (const { id, label } of [...this.owned].reverse()) {
			await this.stop(id);
			const item = await this.inspect(id);
			assert.equal(item.State.OOMKilled, false, 'Owned image hit OOM');
			assert.equal(
				item.State.ExitCode,
				0,
				'Owned image did not exit cleanly: ' + label
			);
			await this.docker(['rm', '-v', id]);
			this.owned = this.owned.filter(item => item.id !== id);
			await this.record();
		}
		assert.equal(
			await this.docker([
				'ps',
				'-aq',
				'--filter',
				'label=winwidget.test=' + this.label
			]),
			''
		);
		this.closed = true;
		await this.record();
		this.log(
			'Only owned native image containers removed; shared PostgreSQL/images cleanup remains separate'
		);
	}
	async finish(evidence) {
		assert.equal(
			this.closed,
			true,
			'Result requires completed owned cleanup'
		);
		assert.equal(this.owned.length, 0);
		assert.equal(evidence.revision, this.revision);
		const path = join(this.directory, 'native-images-result.json');
		await writeFile(
			path + '.pending',
			JSON.stringify(
				{
					...evidence,
					gracefulExitVerified: true,
					ownedContainersRemoved: true,
					sharedPostgresImagesCleanupPending: true
				},
				null,
				2
			) + '\n',
			{ mode: 0o600, flag: 'wx' }
		);
		await rename(path + '.pending', path);
		this.log(
			'Native image proof completed after graceful cleanup: ' + path
		);
	}
}
