import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config';
import {
	createGateway,
	isLegacyStatisticsRouteTombstoned,
	matchGatewayRoute,
	normalizeGatewayRoutingPathname,
	resolveClientIp,
	WidgetEventRateLimiter
} from '../src/server';
import {
	closeServer,
	createJwksFetch,
	createServer,
	createSigningFixture,
	createTestConfig,
	createTestRoute,
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

describe('Widget event rate limiter', () => {
	it('limits one source and resets its fixed window', () => {
		let now = 1_000;
		const limiter = new WidgetEventRateLimiter({
			now: () => now,
			windowMs: 10_000,
			perSourceLimit: 2,
			perWidgetLimit: 10
		});
		const path = '/api/v1/widget-events/wheel/public-key';

		assert.equal(limiter.consume(path, '203.0.113.1')?.allowed, true);
		assert.equal(limiter.consume(path, '203.0.113.1')?.allowed, true);
		assert.equal(limiter.consume(path, '203.0.113.1')?.allowed, false);
		assert.equal(limiter.consume(path, '203.0.113.2')?.allowed, true);

		now += 10_000;
		assert.equal(limiter.consume(path, '203.0.113.1')?.allowed, true);
	});

	it('applies a shared widget budget across sources', () => {
		const limiter = new WidgetEventRateLimiter({
			perSourceLimit: 10,
			perWidgetLimit: 2
		});
		const path = '/api/v1/widget-events/quiz/public-key';

		assert.equal(limiter.consume(path, '203.0.113.1')?.allowed, true);
		assert.equal(limiter.consume(path, '203.0.113.2')?.allowed, true);
		assert.equal(limiter.consume(path, '203.0.113.3')?.allowed, false);
		assert.equal(
			limiter.consume('/api/v1/widget/wheel', '203.0.113.3'),
			null
		);
	});

	it('normalizes backend-compatible route and type variants', () => {
		const limiter = new WidgetEventRateLimiter({
			perSourceLimit: 10,
			perWidgetLimit: 2
		});

		assert.equal(
			limiter.consume(
				'/api/v1/WIDGET-EVENTS/TIMER/public-key',
				'203.0.113.1'
			)?.allowed,
			true
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/countdown-timer/public-key/',
				'203.0.113.2'
			)?.allowed,
			true
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/tImEr/public-key',
				'203.0.113.3'
			)?.allowed,
			false
		);
	});

	it('applies one source budget across widget keys', () => {
		const limiter = new WidgetEventRateLimiter({
			perSourceLimit: 2,
			perWidgetLimit: 10
		});

		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/wheel/fake-key-1',
				'203.0.113.1'
			)?.allowed,
			true
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/quiz/fake-key-2',
				'203.0.113.1'
			)?.allowed,
			true
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/calculator/fake-key-3',
				'203.0.113.1'
			)?.allowed,
			false
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/calculator/real-key',
				'203.0.113.2'
			)?.allowed,
			true
		);
	});

	it('keeps a stricter source-and-widget budget', () => {
		const limiter = new WidgetEventRateLimiter({
			perSourceLimit: 10,
			perSourceWidgetLimit: 2,
			perWidgetLimit: 10
		});
		const firstWidget = '/api/v1/widget-events/wheel/public-key';

		assert.equal(
			limiter.consume(firstWidget, '203.0.113.1')?.allowed,
			true
		);
		assert.equal(
			limiter.consume(firstWidget, '203.0.113.1')?.allowed,
			true
		);
		assert.equal(
			limiter.consume(firstWidget, '203.0.113.1')?.allowed,
			false
		);
		assert.equal(
			limiter.consume(
				'/api/v1/widget-events/quiz/another-key',
				'203.0.113.1'
			)?.allowed,
			true
		);
	});

	it('evicts bounded entries instead of denying unrelated sources', () => {
		const limiter = new WidgetEventRateLimiter({
			perSourceLimit: 100,
			perWidgetLimit: 100,
			maxEntries: 4
		});

		for (let index = 0; index < 20; index += 1) {
			assert.equal(
				limiter.consume(
					`/api/v1/widget-events/wheel/fake-key-${index}`,
					'203.0.113.1'
				)?.allowed,
				true
			);
		}

		assert.equal(
			limiter.consume('/api/v1/widget-events/quiz/real-key', '203.0.113.2')
				?.allowed,
			true
		);
		const entries = (
			limiter as unknown as {
				entries: Map<string, unknown>;
			}
		).entries;
		assert.equal(entries.size, 4);
	});
});

describe('API Gateway config', () => {
	const baseEnv = {
		PORT: '4200',
		GATEWAY_PORT: '4100',
		JWT_JWKS_URL:
			'http://127.0.0.1:4200/api/v1/auth/.well-known/jwks.json',
		JWT_ISSUER: 'http://localhost:4100/auth',
		JWT_AUDIENCE: 'http://localhost:4100',
		CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000'
	};

	it('loads and orders the declarative route table by specificity', () => {
		const config = loadConfig({
			...baseEnv,
			GATEWAY_ROUTES_JSON: JSON.stringify([
				{
					id: 'monolith',
					pathPrefix: '/api/v1',
					upstreamUrl: 'http://127.0.0.1:4200',
					authPolicy: 'optional',
					timeoutMs: 60_000
				},
				{
					id: 'users',
					pathPrefix: '/api/v1/users',
					upstreamUrl: 'http://127.0.0.1:4300',
					authPolicy: 'required',
					timeoutMs: 10_000
				}
			])
		});

		assert.equal(config.port, 4100);
		assert.deepEqual(
			config.routes.map(route => route.id),
			['users', 'monolith']
		);
		assert.equal(
			config.routes[0].upstreamUrl.origin,
			'http://127.0.0.1:4300'
		);
	});

	it('accepts a non-empty manifest without a monolith catch-all', () => {
		const config = loadConfig({
			...baseEnv,
			GATEWAY_ROUTES_JSON: JSON.stringify([
				{
					id: 'users',
					pathPrefix: '/api/v1/users',
					upstreamUrl: 'http://127.0.0.1:4300',
					authPolicy: 'required',
					timeoutMs: 10_000
				}
			])
		});

		assert.deepEqual(
			config.routes.map(route => route.id),
			['users']
		);
	});

	it('keeps protected restore and Reporting routes ahead of the monolith', () => {
		const config = loadConfig({
			...baseEnv,
			GATEWAY_ROUTES_JSON: JSON.stringify([
				{
					id: 'database-restores',
					pathPrefix: '/api/v1/dev-tools/database-restores',
					upstreamUrl: 'http://127.0.0.1:4200',
					authPolicy: 'required',
					timeoutMs: 120_000
				},
				{
					id: 'campaigns',
					pathPrefix: '/api/v1/admin/campaigns',
					upstreamUrl: 'http://127.0.0.1:4500',
					authPolicy: 'required',
					timeoutMs: 60_000
				},
				{
					id: 'reporting',
					pathPrefix: '/api/v1/admin/reporting',
					upstreamUrl: 'http://127.0.0.1:4600',
					authPolicy: 'required',
					timeoutMs: 60_000
				},
				{
					id: 'monolith',
					pathPrefix: '/api/v1',
					upstreamUrl: 'http://127.0.0.1:4200',
					authPolicy: 'optional',
					timeoutMs: 60_000
				}
			])
		});

		assert.deepEqual(
			config.routes.map(route => route.id),
			['database-restores', 'campaigns', 'reporting', 'monolith']
		);
		assert.equal(
			matchGatewayRoute(
				'/api/v1/dev-tools/database-restores/reporting',
				config.routes
			)?.id,
			'database-restores'
		);
		assert.equal(config.routes[0].authPolicy, 'required');
		assert.equal(config.routes[0].timeoutMs, 120_000);
		for (const path of [
			'/api/v1/admin/reporting',
			'/api/v1/admin/reporting/dashboard',
			'/api/v1/admin/reporting/daily-summary/settings'
		]) {
			assert.equal(
				matchGatewayRoute(path, config.routes)?.id,
				'reporting'
			);
		}
		assert.equal(
			matchGatewayRoute('/api/v1/admin/reporting-export', config.routes)
				?.id,
			'monolith'
		);
	});

	it('routes the complete Widgets API with explicit auth policies', () => {
		const widgetsOrigin = 'http://127.0.0.1:4700';
		const protectedRoutes = [
			['widgets-admin', '/api/v1/widgets/admin'],
			['widgets-management', '/api/v1/widgets'],
			['quizzes-management', '/api/v1/quizzes'],
			['callbacks-management', '/api/v1/callbacks'],
			['countdown-timers-management', '/api/v1/countdown-timers'],
			['stop-offers-management', '/api/v1/stop-offers'],
			['online-consultants-management', '/api/v1/online-consultants'],
			['calculators-management', '/api/v1/calculators'],
			['widget-settings', '/api/v1/widget-settings'],
			['widget-runtime', '/api/v1/widget-runtime']
		] as const;
		const publicRoutes = [
			['widget-public', '/api/v1/widget'],
			['quiz-public', '/api/v1/quiz'],
			['callback-public', '/api/v1/callback'],
			['countdown-timer-public', '/api/v1/countdown-timer'],
			['stop-offer-public', '/api/v1/stop-offer'],
			['online-consultant-public', '/api/v1/online-consultant'],
			['calculator-public', '/api/v1/calculator'],
			['widget-events', '/api/v1/widget-events']
		] as const;
		const widgetRoutes = [
			...protectedRoutes.map(([id, pathPrefix]) => ({
				id,
				pathPrefix,
				upstreamUrl: widgetsOrigin,
				authPolicy: 'required',
				timeoutMs: 60_000
			})),
			...publicRoutes.map(([id, pathPrefix]) => ({
				id,
				pathPrefix,
				upstreamUrl: widgetsOrigin,
				authPolicy: 'optional',
				timeoutMs: 60_000
			}))
		];
		const config = loadConfig({
			...baseEnv,
			GATEWAY_ROUTES_JSON: JSON.stringify([
				...widgetRoutes,
				{
					id: 'monolith',
					pathPrefix: '/api/v1',
					upstreamUrl: 'http://127.0.0.1:4200',
					authPolicy: 'optional',
					timeoutMs: 60_000
				}
			])
		});

		assert.equal(config.routes.length, 19);
		const routeIndex = (id: string): number =>
			config.routes.findIndex(route => route.id === id);
		assert.ok(
			routeIndex('widgets-admin') < routeIndex('widgets-management')
		);
		assert.ok(
			routeIndex('online-consultants-management') <
				routeIndex('online-consultant-public')
		);
		for (const [id, pathPrefix] of protectedRoutes) {
			const route = matchGatewayRoute(
				`${pathPrefix}/example`,
				config.routes
			);
			assert.equal(route?.id, id);
			assert.equal(route?.authPolicy, 'required');
			assert.equal(route?.upstreamUrl.origin, widgetsOrigin);
		}
		for (const [id, pathPrefix] of publicRoutes) {
			const route = matchGatewayRoute(
				`${pathPrefix}/example`,
				config.routes
			);
			assert.equal(route?.id, id);
			assert.equal(route?.authPolicy, 'optional');
			assert.equal(route?.upstreamUrl.origin, widgetsOrigin);
		}
		assert.equal(
			matchGatewayRoute('/api/v1/widgets-admin', config.routes)?.id,
			'monolith'
		);
	});

	it('fails fast for legacy, malformed and incomplete route config', () => {
		assert.throws(
			() =>
				loadConfig({
					...baseEnv,
					API_UPSTREAM_URL: 'http://127.0.0.1:4200',
					GATEWAY_ROUTES_JSON: '[]'
				}),
			/API_UPSTREAM_URL is no longer supported/
		);
		assert.throws(
			() =>
				loadConfig({
					...baseEnv,
					GATEWAY_ROUTES_JSON: '{not-json'
				}),
			/must contain valid JSON/
		);
		assert.throws(
			() =>
				loadConfig({
					...baseEnv,
					GATEWAY_ROUTES_JSON: JSON.stringify([
						{
							id: 'monolith',
							pathPrefix: '/api/v1',
							upstreamUrl: 'http://127.0.0.1:4200',
							authPolicy: 'optional'
						}
					])
				}),
			/must contain exactly/
		);
		assert.throws(
			() =>
				loadConfig({
					...baseEnv,
					GATEWAY_ROUTES_JSON: JSON.stringify([
						{
							id: 'monolith',
							pathPrefix: '/api/v1',
							upstreamUrl: 'http://127.0.0.1:4200',
							authPolicy: 'public',
							timeoutMs: 60_000
						}
					])
				}),
			/authPolicy must be required or optional/
		);
		assert.throws(
			() =>
				loadConfig({
					...baseEnv,
					GATEWAY_ROUTES_JSON: JSON.stringify([
						{
							id: 'encoded',
							pathPrefix: '/api/v1/%75sers',
							upstreamUrl: 'http://127.0.0.1:4200',
							authPolicy: 'required',
							timeoutMs: 60_000
						}
					])
				}),
			/must be \/api\/v1 or a canonical path/
		);
	});

	it('matches the longest prefix only on an exact path boundary', () => {
		const routes = [
			createTestRoute({
				id: 'widgets',
				pathPrefix: '/api/v1/widgets'
			}),
			createTestRoute({
				id: 'widget-admin',
				pathPrefix: '/api/v1/widgets/admin'
			})
		];

		assert.equal(
			matchGatewayRoute('/api/v1/widgets/admin/42', routes)?.id,
			'widget-admin'
		);
		assert.equal(
			matchGatewayRoute('/api/v1/widgets/42', routes)?.id,
			'widgets'
		);
		assert.equal(
			matchGatewayRoute('/api/v1/widgets-admin', routes)?.id,
			undefined
		);
	});

	it('normalizes encoded path segments before route selection', () => {
		assert.equal(
			normalizeGatewayRoutingPathname('/api/v1/%70rotected-route'),
			'/api/v1/protected-route'
		);
		assert.equal(
			normalizeGatewayRoutingPathname('/api/v1/%E0%A4%A'),
			null
		);
		assert.equal(
			normalizeGatewayRoutingPathname('/api/v1/%5Cadmin'),
			null
		);
	});

	it('tombstones only the exact legacy statistics boundary when Reporting is routed', () => {
		const darkRoutes = [createTestRoute()];
		const reportingRoutes = [
			createTestRoute({
				id: 'reporting',
				pathPrefix: '/api/v1/admin/reporting'
			}),
			...darkRoutes
		];
		for (const path of [
			'/api/v1/statistics',
			'/api/v1/statistics/dashboard',
			'/api/v1/statistics/dashboard/export'
		]) {
			assert.equal(
				isLegacyStatisticsRouteTombstoned(path, darkRoutes),
				false
			);
			assert.equal(
				isLegacyStatisticsRouteTombstoned(path, reportingRoutes),
				true
			);
		}
		assert.equal(
			isLegacyStatisticsRouteTombstoned(
				'/api/v1/statistics-export',
				reportingRoutes
			),
			false
		);
	});
});

describe('API Gateway proxy', () => {
	const signingKey = createSigningFixture('gateway-key');
	const captured: CapturedRequest[] = [];
	const capturedLogs: Array<{
		event: string;
		fields?: Record<string, unknown>;
	}> = [];
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
	const routedUpstream = createServer((request, response) => {
		response.statusCode = 202;
		response.end(`routed:${request.url}`);
	});
	let gateway: ReturnType<typeof createGateway>;
	let gatewayUrl: URL;

	before(async () => {
		const upstreamUrl = await listenServer(upstream);
		const routedUpstreamUrl = await listenServer(routedUpstream);
		gateway = createGateway(
			createTestConfig({
				routes: [
					createTestRoute({
						id: 'routed',
						pathPrefix: '/api/v1/routed',
						upstreamUrl: routedUpstreamUrl
					}),
					createTestRoute({
						id: 'protected',
						pathPrefix: '/api/v1/protected-route',
						upstreamUrl,
						authPolicy: 'required'
					}),
					createTestRoute({ upstreamUrl })
				]
			}),
			{
				logger: {
					log(_level, event, fields) {
						capturedLogs.push({ event, fields });
					}
				},
				fetch: createJwksFetch(() => [signingKey.publicJwk])
			}
		);
		assert.equal(await gateway.initialize(), true);
		await gateway.listen(0, '127.0.0.1');
		const address = gateway.address() as AddressInfo;
		gatewayUrl = new URL(`http://127.0.0.1:${address.port}`);
	});

	after(async () => {
		await gateway.close();
		await closeServer(upstream);
		await closeServer(routedUpstream);
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
					'x-winwidget-internal-token': 'spoofed-service-token',
					'x-internal-control': 'spoofed-control-token',
					'x-request-id': 'attacker-controlled',
					'x-correlation-id': 'attacker-correlation',
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
		assert.equal(proxied.headers['x-winwidget-internal-token'], undefined);
		assert.equal(proxied.headers['x-internal-control'], undefined);
		assert.equal(proxied.headers.cookie, 'theme=dark; session=current');
		assert.match(
			String(proxied.headers['x-request-id']),
			/^[0-9a-f-]{36}$/
		);
		assert.notEqual(
			proxied.headers['x-request-id'],
			'attacker-controlled'
		);
		assert.match(
			String(proxied.headers['x-correlation-id']),
			/^[0-9a-f-]{36}$/
		);
		assert.notEqual(
			proxied.headers['x-correlation-id'],
			'attacker-correlation'
		);
		assert.equal(
			result.headers['x-request-id'],
			proxied.headers['x-request-id']
		);
		assert.equal(
			result.headers['x-correlation-id'],
			proxied.headers['x-correlation-id']
		);
		assert.notEqual(
			result.headers['x-request-id'],
			result.headers['x-correlation-id']
		);
		const completionLog = capturedLogs.find(
			entry =>
				entry.event === 'request_completed' &&
				entry.fields?.requestId === result.headers['x-request-id']
		);
		assert.equal(
			completionLog?.fields?.correlationId,
			result.headers['x-correlation-id']
		);
		assert.equal(completionLog?.fields?.routeId, 'monolith');
	});

	it('keeps dark legacy routes proxied and tombstones them after Reporting routing', async () => {
		const accessToken = signAccessToken(signingKey, { roles: ['ADMIN'] });
		const darkResult = await makeRequest(
			new URL('/api/v1/statistics/dashboard', gatewayUrl),
			{ headers: { authorization: `Bearer ${accessToken}` } }
		);
		assert.equal(darkResult.statusCode, 201);

		const reportingGateway = createGateway(
			createTestConfig({
				routes: [
					createTestRoute({
						id: 'reporting',
						pathPrefix: '/api/v1/admin/reporting',
						upstreamUrl: new URL(
							`http://127.0.0.1:${(routedUpstream.address() as AddressInfo).port}`
						),
						authPolicy: 'required'
					}),
					createTestRoute({
						upstreamUrl: new URL(
							`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
						)
					})
				]
			}),
			{
				logger: silentLogger,
				fetch: createJwksFetch(() => [signingKey.publicJwk])
			}
		);
		assert.equal(await reportingGateway.initialize(), true);
		await reportingGateway.listen(0, '127.0.0.1');
		try {
			const address = reportingGateway.address() as AddressInfo;
			const origin = new URL(`http://127.0.0.1:${address.port}`);
			const current = await makeRequest(
				new URL('/api/v1/admin/reporting/overview', origin),
				{ headers: { authorization: `Bearer ${accessToken}` } }
			);
			assert.equal(current.statusCode, 202);
			const capturedBefore = captured.length;
			for (const path of [
				'/api/v1/statistics/dashboard',
				'/api/v1/statistics/overview',
				'/api/v1/statistics/registrations-by-month',
				'/api/v1/statistics/dashboard/export'
			]) {
				const result = await makeRequest(new URL(path, origin), {
					headers: { authorization: `Bearer ${accessToken}` }
				});
				assert.equal(result.statusCode, 404);
				assert.equal(JSON.parse(result.body).code, 'route_not_found');
			}
			assert.equal(captured.length, capturedBefore);
		} finally {
			await reportingGateway.close();
		}
	});

	it('dispatches to the longest matching route upstream', async () => {
		const result = await makeRequest(
			new URL('/api/v1/routed/item?key=value', gatewayUrl)
		);

		assert.equal(result.statusCode, 202);
		assert.equal(result.body, 'routed:/api/v1/routed/item?key=value');
	});

	it('never publishes internal service endpoints through the catch-all route', async () => {
		const capturedBefore = captured.length;
		for (const path of [
			'/api/v1/internal/reporting/auth/introspect',
			'/api/v1/%69nternal/reporting/snapshot',
			'/api/v1%2Finternal/reporting/snapshot',
			'/api/v1/internal%2Freporting%2Fsnapshot'
		]) {
			const result = await makeRequest(new URL(path, gatewayUrl), {
				headers: {
					'x-winwidget-internal-token': 'attacker-controlled'
				}
			});
			assert.equal(result.statusCode, 404);
			assert.equal(JSON.parse(result.body).code, 'route_not_found');
		}
		assert.equal(captured.length, capturedBefore);
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

	it('enforces required and optional auth policies and rejects any invalid Bearer', async () => {
		const beforeCount = captured.length;
		const anonymous = await makeRequest(
			new URL('/api/v1/public-route', gatewayUrl)
		);
		assert.equal(anonymous.statusCode, 201);
		assert.equal(captured.length, beforeCount + 1);

		const missingRequired = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl)
		);
		assert.equal(missingRequired.statusCode, 401);
		const missingRequiredBody = JSON.parse(missingRequired.body);
		assert.equal(missingRequiredBody.code, 'authentication_required');
		assert.equal(
			missingRequiredBody.requestId,
			missingRequired.headers['x-request-id']
		);
		assert.equal(
			missingRequiredBody.correlationId,
			missingRequired.headers['x-correlation-id']
		);

		const encodedRequired = await makeRequest(
			new URL('/api/v1/%70rotected-route', gatewayUrl)
		);
		assert.equal(encodedRequired.statusCode, 401);
		assert.equal(
			JSON.parse(encodedRequired.body).code,
			'authentication_required'
		);

		const preflight = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl),
			{ method: 'OPTIONS' }
		);
		assert.equal(preflight.statusCode, 201);

		const invalidRequired = await makeRequest(
			new URL('/api/v1/protected-route', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer not-a-jwt'
				}
			}
		);
		assert.equal(invalidRequired.statusCode, 401);
		assert.equal(JSON.parse(invalidRequired.body).code, 'invalid_token');

		const invalidOptional = await makeRequest(
			new URL('/api/v1/public-route', gatewayUrl),
			{
				headers: {
					authorization: 'Bearer not-a-jwt'
				}
			}
		);
		assert.equal(invalidOptional.statusCode, 401);
		assert.equal(JSON.parse(invalidOptional.body).code, 'invalid_token');
		assert.equal(captured.length, beforeCount + 2);
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
			'x-request-id, x-correlation-id'
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
			'x-request-id, x-correlation-id'
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

	it('returns a Gateway 404 when a manifest has no matching route', async () => {
		const signingKey = createSigningFixture('unmatched-route-key');
		const gateway = createGateway(
			createTestConfig({
				routes: [
					createTestRoute({
						id: 'users',
						pathPrefix: '/api/v1/users'
					})
				]
			}),
			{
				logger: silentLogger,
				fetch: createJwksFetch(() => [signingKey.publicJwk])
			}
		);

		try {
			await gateway.initialize();
			await gateway.listen(0, '127.0.0.1');
			const address = gateway.address() as AddressInfo;
			const response = await makeRequest(
				new URL('/api/v1/payments', `http://127.0.0.1:${address.port}`)
			);

			assert.equal(response.statusCode, 404);
			assert.equal(JSON.parse(response.body).code, 'route_not_found');
		} finally {
			await gateway.close();
		}
	});

	it('stays live but not ready and fails closed for Bearer when JWKS is cold', async () => {
		const signingKey = createSigningFixture('cold-key');
		const upstream = createServer((_request, response) => {
			response.end('anonymous');
		});
		const upstreamUrl = await listenServer(upstream);
		const gateway = createGateway(
			createTestConfig({
				routes: [createTestRoute({ upstreamUrl })]
			}),
			{
				logger: silentLogger,
				fetch: createJwksFetch(
					() => [signingKey.publicJwk],
					() => false
				)
			}
		);

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
				routes: [
					createTestRoute({
						upstreamUrl: releasedUrl,
						timeoutMs: 100
					})
				]
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
				routes: [
					createTestRoute({
						upstreamUrl: hangingUrl,
						timeoutMs: 50
					})
				]
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
