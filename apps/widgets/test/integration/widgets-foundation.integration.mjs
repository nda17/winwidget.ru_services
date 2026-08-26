import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/widgets-client';

const databaseUrl = process.env.WIDGETS_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
	console.log(
		'SKIP Widgets integration: WIDGETS_TEST_DATABASE_URL is not set'
	);
	process.exit(0);
}
if (process.env.WIDGETS_INTEGRATION_ALLOW_MUTATION !== 'true') {
	throw new Error('WIDGETS_INTEGRATION_ALLOW_MUTATION=true is required');
}
assertLocalTestDatabase(databaseUrl);

const port = await getFreePort();
const internalToken = `widgets-foundation-${randomUUID()}`;
const app = spawn('node', ['dist/src/main.js'], {
	cwd: new URL('../../', import.meta.url),
	env: {
		...process.env,
		NODE_ENV: 'test',
		MODE: 'production',
		APP_REVISION: 'widgets-foundation-integration',
		WIDGETS_DATABASE_URL: databaseUrl,
		WIDGETS_PROCESS_ROLE: 'api',
		WIDGETS_LISTEN_HOST: '127.0.0.1',
		WIDGETS_PORT: String(port),
		WIDGETS_INTERNAL_TOKEN: internalToken,
		WIDGETS_INTERNAL_TIMEOUT_MS: '500',
		WIDGETS_ENTITLEMENT_MAX_STALENESS_MS: '86400000',
		CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3000'
	},
	stdio: 'inherit'
});

try {
	await waitForReady(port);
	await assertHealth(port, '/health/live', 'ok');
	await assertHealth(port, '/health/ready', 'ready');
	await assertRuntimeAsset(port);
	await assertDatabaseAcl(databaseUrl);
	console.log('Widgets service-local foundation integration passed');
} finally {
	app.kill('SIGTERM');
	const exited = await Promise.race([
		new Promise(resolve => app.once('exit', code => resolve(code))),
		new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
	]);
	if (exited === 'timeout') {
		app.kill('SIGKILL');
		throw new Error('Widgets integration process did not stop gracefully');
	}
}

function assertLocalTestDatabase(value) {
	const parsed = new URL(value);
	const databaseName = decodeURIComponent(
		parsed.pathname.replace(/^\/+/, '')
	);
	if (
		parsed.protocol !== 'postgresql:' ||
		!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			parsed.hostname.toLowerCase()
		) ||
		!(
			databaseName.toLowerCase().includes('test') ||
			databaseName.toLowerCase().endsWith('_ci')
		)
	) {
		throw new Error(
			'WIDGETS_TEST_DATABASE_URL must point to a local test or CI database'
		);
	}
	for (const [key, configured] of Object.entries(process.env)) {
		if (key.includes('PRODUCTION') && configured?.trim() === value) {
			throw new Error(`WIDGETS_TEST_DATABASE_URL must not reuse ${key}`);
		}
	}
}

async function getFreePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Could not allocate Widgets integration port');
	}
	await new Promise(resolve => server.close(resolve));
	return address.port;
}

async function waitForReady(port) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (app.exitCode !== null) {
			throw new Error(
				`Widgets integration process exited with ${app.exitCode}`
			);
		}
		try {
			const response = await fetch(
				`http://127.0.0.1:${port}/health/ready`,
				{
					signal: AbortSignal.timeout(1000)
				}
			);
			if (response.ok) return;
		} catch {
			// Startup connection failures are expected until Nest begins listening.
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Widgets integration service did not become ready');
}

async function assertHealth(port, path, expectedStatus) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`);
	if (!response.ok) throw new Error(`${path} returned ${response.status}`);
	const payload = await response.json();
	if (
		payload.status !== expectedStatus ||
		payload.service !== 'widgets' ||
		payload.role !== 'api' ||
		payload.revision !== 'widgets-foundation-integration'
	) {
		throw new Error(`${path} returned an invalid Widgets identity`);
	}
}

async function assertRuntimeAsset(port) {
	const response = await fetch(
		`http://127.0.0.1:${port}/widgets/wheel.js`
	);
	if (!response.ok) {
		throw new Error(`Widgets runtime asset returned ${response.status}`);
	}
	const cacheControl = response.headers.get('cache-control') || '';
	if (
		cacheControl !== 'public, max-age=300' ||
		cacheControl.includes('immutable') ||
		response.headers.get('access-control-allow-origin') !== '*'
	) {
		throw new Error('Widgets runtime asset cache/CORS contract drifted');
	}
	if (!(await response.text()).trim()) {
		throw new Error('Widgets runtime asset is empty');
	}
}

async function assertDatabaseAcl(value) {
	const prisma = new PrismaClient({ datasources: { db: { url: value } } });
	try {
		const identity = await prisma.widgetsServiceIdentity.findUnique({
			where: { id: 'widgets-service' },
			select: { id: true }
		});
		if (identity?.id !== 'widgets-service') {
			throw new Error('Widgets service identity is missing');
		}
		let migrationLedgerReadable = true;
		try {
			await prisma.$queryRaw`SELECT count(*) FROM widgets._prisma_migrations`;
		} catch {
			migrationLedgerReadable = false;
		}
		if (migrationLedgerReadable) {
			throw new Error(
				'Widgets runtime role can read the Prisma migration ledger'
			);
		}
	} finally {
		await prisma.$disconnect();
	}
}
