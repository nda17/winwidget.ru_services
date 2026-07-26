import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import { createGateway, resolveClientIp } from '../src/server';
import {
	closeServer,
	createJwksFetch,
	createServer,
	createSigningFixture,
	createTestConfig,
	listenServer,
	makeRequest,
	signAccessToken,
	silentLogger
} from './helpers';

interface CapturedRequest {
	url: string;
	method: string;
	headers: IncomingHttpHeaders;
	body: string;
}

describe('API Gateway config', () => {
	it('prefers the dedicated Gateway port in a shared local env', () => {
		const config = loadConfig({
			PORT: '4200',
			GATEWAY_PORT: '4100',
			JWT_JWKS_URL:
				'http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json',
			JWT_ISSUER: 'http://localhost:4100/auth',
			JWT_AUDIENCE: 'http://localhost:4100',
			CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000'
		});

		assert.equal(config.port, 4100);
	});
});

describe('API Gateway proxy', () => {
	const signingKey = createSigningFixture('gateway-key');
	const captured: CapturedRequest[] = [];
	const upstream = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', chunk => chunks.push(Buffer.from(chunk)));
		request.on('end', () => {
			captured.push({
				url: request.url ?? '',
				method: request.method ?? '',
				headers: request.headers,
				body: Buffer.concat(chunks).toString('utf8')
			});
			response.statusCode = 201;
			response.setHeader('content-type', 'text/plain');
			response.setHeader('set-cookie', [
				'accessToken=one; Path=/',
				'refreshToken=two; HttpOnly; Path=/'
			]);
			response.write('stream-');
			setImmediate(() => response.end('complete'));
		});
	});
	let gateway: ReturnType<typeof createGateway>;
	let gatewayUrl: URL;

	before(async () => {
		const upstreamUrl = await listenServer(upstream);
		gateway = createGateway(createTestConfig({ upstreamUrl }), {
			logger: silentLogger,
			fetch: createJwksFetch(() => [signingKey.publicJwk])
		});
		assert.equal(await gateway.initialize(), true);
		await gateway.listen(0, '127.0.0.1');
		const address = gateway.address() as AddressInfo;
		gatewayUrl = new URL(`http://127.0.0.1:${address.port}`);
	});

	after(async () => {
		await gateway.close();
		await closeServer(upstream);
	});

	it('preserves path, body, streaming, Set-Cookie and valid Authorization', async () => {
		const accessToken = signAccessToken(signingKey);
		const result = await makeRequest(
			new URL('/api/v1/widget?key=value%202', gatewayUrl),
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${accessToken}`,
					'content-type': 'application/json',
					cookie: 'theme=dark; refreshToken=secret; session=current',
					'x-real-ip': '198.51.100.10',
					'x-forwarded-for': '198.51.100.10',
					'x-forwarded-host': 'attacker.example',
					'cf-connecting-ip': '203.0.113.99',
					'x-user-id': 'spoofed-user',
					'x-auth-roles': 'ADMIN',
					'x-request-id': 'attacker-controlled',
					connection: 'authorization'
				},
				body: '{"ok":true}'
			}
		);

		assert.equal(result.statusCode, 201);
		assert.equal(result.body, 'stream-complete');
		const setCookies = result.rawHeaders.filter(
			(_value, index, values) =>
				index > 0 && values[index - 1].toLowerCase() === 'set-cookie'
		);
		assert.deepEqual(setCookies, [
			'accessToken=one; Path=/',
			'refreshToken=two; HttpOnly; Path=/'
		]);

		const proxied = captured.at(-1);
		assert.ok(proxied);
		assert.equal(proxied.url, '/api/v1/widget?key=value%202');
		assert.equal(proxied.method, 'POST');
		assert.equal(proxied.body, '{"ok":true}');
		assert.equal(proxied.headers.authorization, `Bearer ${accessToken}`);
		assert.equal(proxied.headers['x-real-ip'], '198.51.100.10');
		assert.equal(proxied.headers['x-forwarded-for'], '198.51.100.10');
		assert.equal(proxied.headers['x-forwarded-host'], undefined);
		assert.equal(proxied.headers['cf-connecting-ip'], undefined);
		assert.equal(proxied.headers['x-user-id'], undefined);
		assert.equal(proxied.headers['x-auth-roles'], undefined);
		assert.equal(proxied.headers.cookie, 'theme=dark; session=current');
		assert.match(
			String(proxied.headers['x-request-id']),
			/^[0-9a-f-]{36}$/
		);
		assert.notEqual(
			proxied.headers['x-request-id'],
			'attacker-controlled'
		);
		assert.equal(
			result.headers['x-request-id'],
			proxied.headers['x-request-id']
		);
	});

	it('allows refresh cookie only on the explicit refresh/logout paths', async () => {
		await makeRequest(new URL('/api/v1/auth/refresh', gatewayUrl), {
			method: 'POST',
			headers: {
				cookie: 'theme=dark; refreshToken=allowed'
			}
		});
		assert.equal(
			captured.at(-1)?.headers.cookie,
			'theme=dark; refreshToken=allowed'
		);

		await makeRequest(new URL('/api/v1/auth/logout', gatewayUrl), {
			method: 'POST',
			headers: {
				cookie: 'refreshToken=allowed'
			}
		});
		assert.equal(captured.at(-1)?.headers.cookie, 'refreshToken=allowed');
	});

	it('lets the monolith decide routes without Authorization but rejects invalid Bearer', async () => {
		const beforeCount = captured.length;
		const anonymous = await makeRequest(
			new URL('/api/v1/public-route', gatewayUrl)
		);
		assert.equal(anonymous.statusCode, 201);
		assert.equal(captured.length, beforeCount + 1);

		const rejected = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer not-a-jwt'
				}
			}
		);
		assert.equal(rejected.statusCode, 401);
		assert.equal(JSON.parse(rejected.body).code, 'invalid_token');
		assert.equal(captured.length, beforeCount + 1);
	});

	it('adds CORS only to generated responses using the exact origin/widget policy', async () => {
		const allowed = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer invalid',
					origin: 'https://winwidget.test'
				}
			}
		);
		assert.equal(allowed.statusCode, 401);
		assert.equal(
			allowed.headers['access-control-allow-origin'],
			'https://winwidget.test'
		);
		assert.equal(
			allowed.headers['access-control-allow-credentials'],
			'true'
		);
		assert.equal(
			allowed.headers['access-control-expose-headers'],
			'x-request-id'
		);
		assert.equal(allowed.headers.vary, 'Origin');

		const denied = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer invalid',
					origin: 'https://attacker.example'
				}
			}
		);
		assert.equal(denied.statusCode, 401);
		assert.equal(denied.headers['access-control-allow-origin'], undefined);
		assert.equal(
			denied.headers['access-control-allow-credentials'],
			undefined
		);

		const widget = await makeRequest(
			new URL('/api/v1/widget/public', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer invalid',
					origin: 'https://embedded.example'
				}
			}
		);
		assert.equal(widget.statusCode, 401);
		assert.equal(widget.headers['access-control-allow-origin'], '*');
		assert.equal(
			widget.headers['access-control-expose-headers'],
			'x-request-id'
		);
		assert.equal(
			widget.headers['access-control-allow-credentials'],
			undefined
		);

		const proxied = await makeRequest(
			new URL('/api/v1/public-route', gatewayUrl),
			{
				headers: {
					origin: 'https://winwidget.test'
				}
			}
		);
		assert.equal(proxied.statusCode, 201);
		assert.equal(
			proxied.headers['access-control-allow-origin'],
			undefined
		);
	});

	it('exposes liveness/readiness and rejects paths outside /api/v1', async () => {
		const live = await makeRequest(new URL('/health/live', gatewayUrl));
		const ready = await makeRequest(new URL('/health/ready', gatewayUrl));
		const readyAlias = await makeRequest(new URL('/health', gatewayUrl));
		const missing = await makeRequest(
			new URL('/api/v2/users', gatewayUrl)
		);

		assert.equal(live.statusCode, 200);
		assert.equal(ready.statusCode, 200);
		assert.equal(readyAlias.statusCode, 200);
		assert.equal(missing.statusCode, 404);
	});
});

describe('Gateway trust boundary', () => {
	it('ignores edge IP headers from a non-loopback peer', () => {
		assert.equal(
			resolveClientIp('203.0.113.10', {
				'x-real-ip': '198.51.100.10',
				'x-forwarded-for': '198.51.100.11'
			}),
			'203.0.113.10'
		);
	});

	it('stays live but not ready and fails closed for Bearer when JWKS is cold', async () => {
		const signingKey = createSigningFixture('cold-key');
		const upstream = createServer((_request, response) => {
			response.end('anonymous');
		});
		const upstreamUrl = await listenServer(upstream);
		const gateway = createGateway(createTestConfig({ upstreamUrl }), {
			logger: silentLogger,
			fetch: createJwksFetch(
				() => [signingKey.publicJwk],
				() => false
			)
		});

		try {
			assert.equal(await gateway.initialize(), false);
			await gateway.listen(0, '127.0.0.1');
			const address = gateway.address() as AddressInfo;
			const url = new URL(`http://127.0.0.1:${address.port}`);
			const live = await makeRequest(new URL('/health/live', url));
			const ready = await makeRequest(new URL('/health/ready', url));
			const bearer = await makeRequest(new URL('/api/v1/users', url), {
				headers: {
					authorization: `Bearer ${signAccessToken(signingKey)}`,
					origin: 'https://winwidget.test'
				}
			});
			const anonymous = await makeRequest(new URL('/api/v1/public', url));

			assert.equal(live.statusCode, 200);
			assert.equal(ready.statusCode, 503);
			assert.equal(bearer.statusCode, 503);
			assert.equal(
				bearer.headers['access-control-allow-origin'],
				'https://winwidget.test'
			);
			assert.equal(anonymous.statusCode, 200);
		} finally {
			await gateway.close();
			await closeServer(upstream);
		}
	});

	it('returns 502 for an unavailable upstream and 504 for an upstream timeout', async () => {
		const signingKey = createSigningFixture('proxy-error-key');
		const releasedPortServer = createServer();
		const releasedUrl = await listenServer(releasedPortServer);
		await closeServer(releasedPortServer);
		const unavailableGateway = createGateway(
			createTestConfig({
				upstreamUrl: releasedUrl,
				proxyTimeoutMs: 100
			}),
			{
				logger: silentLogger,
				fetch: createJwksFetch(() => [signingKey.publicJwk])
			}
		);

		const hangingUpstream = createServer(() => undefined);
		const hangingUrl = await listenServer(hangingUpstream);
		const timeoutGateway = createGateway(
			createTestConfig({
				upstreamUrl: hangingUrl,
				proxyTimeoutMs: 50
			}),
			{
				logger: silentLogger,
				fetch: createJwksFetch(() => [signingKey.publicJwk])
			}
		);

		try {
			await unavailableGateway.initialize();
			await unavailableGateway.listen(0, '127.0.0.1');
			const unavailableAddress =
				unavailableGateway.address() as AddressInfo;
			const unavailable = await makeRequest(
				new URL(
					'/api/v1/test',
					`http://127.0.0.1:${unavailableAddress.port}`
				),
				{
					headers: {
						origin: 'https://winwidget.test'
					}
				}
			);
			assert.equal(unavailable.statusCode, 502);
			assert.equal(
				JSON.parse(unavailable.body).code,
				'upstream_unavailable'
			);
			assert.equal(
				unavailable.headers['access-control-allow-origin'],
				'https://winwidget.test'
			);

			await timeoutGateway.initialize();
			await timeoutGateway.listen(0, '127.0.0.1');
			const timeoutAddress = timeoutGateway.address() as AddressInfo;
			const timedOut = await makeRequest(
				new URL('/api/v1/test', `http://127.0.0.1:${timeoutAddress.port}`)
			);
			assert.equal(timedOut.statusCode, 504);
			assert.equal(JSON.parse(timedOut.body).code, 'upstream_timeout');
		} finally {
			await unavailableGateway.close();
			await timeoutGateway.close();
			await closeServer(hangingUpstream);
		}
	});
});
