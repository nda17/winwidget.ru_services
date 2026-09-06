import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { access } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Executes the built entrypoint and its real termination helper. Nest and its
// dependencies are controlled fault fixtures, not a broker/DB or image proof.
// No production environment, network requests or database credentials are used.
const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../..');
const services = [
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales'
];
const fixtureSecret = 'synthetic-bootstrap-credential-must-not-be-logged';
const [mode, service, scenario] = process.argv.slice(2);

if (mode === '--child') {
	assert.ok(services.includes(service));
	const main = resolve(root, 'apps', service, 'dist/src/main.js');
	const emit = (event, value) =>
		writeSync(1, `${JSON.stringify({ event, value })}\n`);
	const heldHandle = setInterval(() => {}, 1000);
	if (scenario === 'legacy-exit-code') {
		process.exitCode = 1;
		emit('legacy-still-alive');
	} else {
		const application = {
			getHttpAdapter: () => ({ getInstance: () => ({ set() {} }) }),
			setGlobalPrefix() {},
			use() {},
			useBodyParser() {},
			useGlobalPipes() {
				if (scenario === 'configuration-reject')
					throw new Error(fixtureSecret);
			},
			useGlobalFilters() {},
			enableCors() {},
			get: () => ({ port: 5300 }),
			enableShutdownHooks() {
				process.once('SIGTERM', async () => {
					await application.close();
					clearInterval(heldHandle);
					emit('normal-shutdown');
				});
			},
			async listen() {
				emit('listen');
				if (scenario !== 'success') throw new Error(fixtureSecret);
				setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30);
			},
			async close() {
				emit('close');
				if (scenario === 'cleanup-reject') throw new Error(fixtureSecret);
				if (scenario === 'cleanup-hang') await new Promise(() => {});
				// Intentionally retain a handle even when close succeeds. Failed
				// startup must exit; ordinary graceful shutdown clears it above.
			}
		};
		const originalLoad = Module._load;
		Module._load = function (request, parent, isMain) {
			if (request === main || parent?.filename !== main)
				return originalLoad.call(this, request, parent, isMain);
			if (request === '@nestjs/core')
				return {
					NestFactory: {
						async create() {
							emit('create');
							if (scenario === 'create-reject')
								throw new Error(fixtureSecret);
							return application;
						}
					}
				};
			if (request === '@nestjs/common')
				return {
					Logger: {
						error: (...args) => emit('error', args),
						log: (...args) => emit('started', args)
					},
					RequestMethod: { GET: 0, POST: 1 },
					ValidationPipe: class {}
				};
			if (request === './runtime/bootstrap-failure')
				return originalLoad.call(this, request, parent, isMain);
			assert.ok(request.startsWith('./'), 'Unexpected main dependency');
			return new Proxy(
				{},
				{
					get: (_, key) =>
						key === 'EXPORT_EXPOSE_HEADERS'
							? ''
							: function fixtureDependency() {
									return [];
								}
				}
			);
		};
		createRequire(main)(main);
	}
} else {
	assert.ok(
		mode === undefined || services.includes(mode),
		'Select a CRM service'
	);
	assert.equal(service, undefined, 'Unexpected extra argument');
	const selected = mode ? [mode] : services;
	for (const app of selected) {
		await access(resolve(root, 'apps', app, 'dist/src/main.js'));
		for (const fault of [
			'create-reject',
			'configuration-reject',
			'listen-reject',
			'cleanup-reject',
			'cleanup-hang',
			'success',
			'legacy-exit-code'
		]) {
			await test(`${app}: ${fault}`, { timeout: 12_000 }, async () => {
				const child = spawn(
					process.execPath,
					[script, '--child', app, fault],
					{
						cwd: root,
						env: { NODE_ENV: 'test' },
						stdio: ['ignore', 'pipe', 'pipe']
					}
				);
				let stdout = '',
					stderr = '',
					forced = false;
				const started = Date.now();
				const deadline = setTimeout(
					() => {
						forced = true;
						child.kill('SIGKILL');
					},
					fault === 'legacy-exit-code' ? 750 : 10_000
				);
				child.stdout.on('data', chunk => {
					stdout += chunk;
				});
				child.stderr.on('data', chunk => {
					stderr += chunk;
				});
				let result;
				try {
					result = await new Promise((resolve, reject) => {
						child.once('error', reject);
						child.once('close', (code, signal) =>
							resolve({ code, signal })
						);
					});
				} finally {
					clearTimeout(deadline);
				}
				assert.ok(
					!stdout.includes(fixtureSecret) &&
						!stderr.includes(fixtureSecret),
					'Bootstrap or cleanup leaked a connection error'
				);
				assert.equal(stderr, '');
				const events = stdout
					.trim()
					.split('\n')
					.filter(Boolean)
					.map(line => JSON.parse(line).event);
				if (fault === 'legacy-exit-code') {
					assert.equal(
						forced,
						true,
						'Negative control must reproduce retained handles'
					);
					assert.equal(result.signal, 'SIGKILL');
					assert.deepEqual(events, ['legacy-still-alive']);
					return;
				}
				assert.equal(
					forced,
					false,
					'Bootstrap process did not terminate itself'
				);
				assert.equal(result.signal, null);
				assert.equal(result.code, fault === 'success' ? 0 : 1);
				assert.equal(events.filter(event => event === 'create').length, 1);
				assert.equal(
					events.filter(event => event === 'close').length,
					fault === 'create-reject' ? 0 : 1
				);
				assert.equal(events.includes('error'), fault !== 'success');
				assert.equal(events.includes('started'), fault === 'success');
				assert.equal(
					events.includes('normal-shutdown'),
					fault === 'success'
				);
				if (fault === 'cleanup-hang')
					assert.ok(Date.now() - started >= 5_000);
			});
		}
	}
}
