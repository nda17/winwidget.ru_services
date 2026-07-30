import { randomUUID } from 'node:crypto';
import {
	Agent as HttpAgent,
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type Server,
	type ServerResponse
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { GatewayConfig, GatewayRouteConfig } from './config';
import {
	JwksStore,
	JwksUnavailableError,
	UnknownSigningKeyError,
	type FetchLike
} from './jwks';
import {
	JwtValidationError,
	readBearerAuthorization,
	verifyAccessToken
} from './jwt';
import { logger as defaultLogger, type StructuredLogger } from './logger';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_PATHS = new Set([
	'/api/v1/auth/refresh',
	'/api/v1/auth/logout'
]);
const PUBLIC_WIDGET_API_PREFIXES = [
	'/api/v1/widget',
	'/api/v1/quiz',
	'/api/v1/callback',
	'/api/v1/countdown-timer',
	'/api/v1/stop-offer',
	'/api/v1/online-consultant',
	'/api/v1/calculator',
	'/api/v1/widget-events'
] as const;
const BASE_HOP_BY_HOP_HEADERS = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

interface GatewayOptions {
	logger?: StructuredLogger;
	fetch?: FetchLike;
	now?: () => number;
}

interface JsonErrorBody {
	statusCode: number;
	error: string;
	message: string;
	code: string;
	requestId: string;
	correlationId: string;
}

interface WidgetEventRateLimitEntry {
	count: number;
	expiresAt: number;
}

interface WidgetEventRateLimiterOptions {
	now?: () => number;
	windowMs?: number;
	perSourceLimit?: number;
	perSourceWidgetLimit?: number;
	perWidgetLimit?: number;
	maxEntries?: number;
}

interface WidgetEventRateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

const WIDGET_EVENT_PATH_PATTERN =
	/^\/api\/v1\/widget-events\/([^/]{1,64})\/([^/]{1,128})\/?$/i;

const normalizeWidgetEventType = (value: string): string | null => {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case 'wheel':
		case 'quiz':
		case 'callback':
		case 'stop-offer':
		case 'online-consultant':
		case 'calculator':
			return normalized;
		case 'timer':
		case 'countdown-timer':
			return 'timer';
		default:
			return null;
	}
};

export class WidgetEventRateLimiter {
	private readonly entries = new Map<string, WidgetEventRateLimitEntry>();
	private readonly now: () => number;
	private readonly windowMs: number;
	private readonly perSourceLimit: number;
	private readonly perSourceWidgetLimit: number;
	private readonly perWidgetLimit: number;
	private readonly maxEntries: number;
	private operations = 0;

	constructor(options: WidgetEventRateLimiterOptions = {}) {
		this.now = options.now ?? Date.now;
		this.windowMs = options.windowMs ?? 60_000;
		this.perSourceLimit = options.perSourceLimit ?? 3_000;
		this.perSourceWidgetLimit = options.perSourceWidgetLimit ?? 180;
		this.perWidgetLimit = options.perWidgetLimit ?? 3_000;
		this.maxEntries = Math.max(2, options.maxEntries ?? 50_000);
	}

	consume(
		pathname: string,
		clientIp: string
	): WidgetEventRateLimitResult | null {
		const match = WIDGET_EVENT_PATH_PATTERN.exec(pathname);
		if (!match) return null;

		const now = this.now();
		this.operations += 1;
		if (this.operations % 512 === 0) this.cleanup(now);

		const sourceKey = `source:${clientIp}`;
		const sourceResult = this.consumeKey(
			sourceKey,
			this.perSourceLimit,
			now
		);
		if (!sourceResult.allowed) return sourceResult;

		const widgetType = normalizeWidgetEventType(match[1]);
		if (!widgetType) return sourceResult;

		const widgetKey = `${widgetType}:${match[2]}`;
		const sourceWidgetResult = this.consumeKey(
			`source-widget:${clientIp}:${widgetKey}`,
			this.perSourceWidgetLimit,
			now,
			sourceKey
		);
		if (!sourceWidgetResult.allowed) return sourceWidgetResult;

		return this.consumeKey(
			`widget:${widgetKey}`,
			this.perWidgetLimit,
			now,
			sourceKey
		);
	}

	private consumeKey(
		key: string,
		limit: number,
		now: number,
		protectedKey?: string
	): WidgetEventRateLimitResult {
		const current = this.entries.get(key);
		if (!current || current.expiresAt <= now) {
			if (current) this.entries.delete(key);
			this.ensureCapacity(now, protectedKey);
			this.entries.set(key, {
				count: 1,
				expiresAt: now + this.windowMs
			});
			return {
				allowed: true,
				retryAfterSeconds: Math.ceil(this.windowMs / 1000)
			};
		}

		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((current.expiresAt - now) / 1000)
		);
		this.entries.delete(key);
		this.entries.set(key, current);
		if (current.count >= limit) {
			return { allowed: false, retryAfterSeconds };
		}

		current.count += 1;
		return { allowed: true, retryAfterSeconds };
	}

	private ensureCapacity(now: number, protectedKey?: string) {
		if (this.entries.size < this.maxEntries) return;
		this.cleanup(now);

		while (this.entries.size >= this.maxEntries) {
			let fallbackKey: string | undefined;
			let evictionKey: string | undefined;
			for (const key of this.entries.keys()) {
				if (key === protectedKey) continue;
				fallbackKey ??= key;
				if (key.startsWith('widget:')) {
					evictionKey = key;
					break;
				}
			}

			const key = evictionKey ?? fallbackKey;
			if (!key) return;
			this.entries.delete(key);
		}
	}

	private cleanup(now: number) {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key);
		}
	}
}

export interface GatewayRuntime {
	readonly server: Server;
	readonly jwks: JwksStore;
	initialize(): Promise<boolean>;
	listen(port?: number, host?: string): Promise<void>;
	close(): Promise<void>;
	address(): ReturnType<Server['address']>;
}

const getRawHeaderValues = (
	rawHeaders: string[],
	name: string
): string[] => {
	const values: string[] = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === name) {
			values.push(rawHeaders[index + 1] ?? '');
		}
	}
	return values;
};

const normalizeIp = (value: string | undefined): string | undefined => {
	if (!value) return undefined;
	const trimmed = value.trim();
	const withoutMappedPrefix = trimmed.startsWith('::ffff:')
		? trimmed.slice('::ffff:'.length)
		: trimmed;
	return isIP(withoutMappedPrefix) ? withoutMappedPrefix : undefined;
};

const isLoopback = (value: string | undefined): boolean => {
	const address = normalizeIp(value);
	if (!address) return false;
	if (address === '::1') return true;
	if (isIP(address) === 4) {
		const firstOctet = Number(address.split('.')[0]);
		return firstOctet === 127;
	}
	return false;
};

const readSingleIpHeader = (
	headers: IncomingHttpHeaders,
	name: string
): string | undefined => {
	const value = headers[name];
	if (typeof value !== 'string' || value.includes(',')) return undefined;
	return normalizeIp(value);
};

export const resolveClientIp = (
	peerAddress: string | undefined,
	headers: IncomingHttpHeaders
): string => {
	const peerIp = normalizeIp(peerAddress) ?? '0.0.0.0';
	if (!isLoopback(peerAddress)) return peerIp;

	const realIp = readSingleIpHeader(headers, 'x-real-ip');
	const forwardedIp = readSingleIpHeader(headers, 'x-forwarded-for');
	if (realIp && forwardedIp && realIp !== forwardedIp) {
		return peerIp;
	}
	return realIp ?? forwardedIp ?? peerIp;
};

const resolveForwardedProto = (
	request: IncomingMessage
): 'http' | 'https' => {
	if (isLoopback(request.socket.remoteAddress)) {
		const value = request.headers['x-forwarded-proto'];
		if (value === 'http' || value === 'https') return value;
	}
	return 'http';
};

const createRequestContext = (): {
	requestId: string;
	correlationId: string;
} => ({
	requestId: randomUUID(),
	correlationId: randomUUID()
});

const getConnectionHeaderNames = (
	headers: IncomingHttpHeaders
): Set<string> => {
	const names = new Set(BASE_HOP_BY_HOP_HEADERS);
	const connection = headers.connection;
	if (typeof connection === 'string') {
		for (const value of connection.split(',')) {
			const name = value.trim().toLowerCase();
			if (name) names.add(name);
		}
	}
	return names;
};

const stripRefreshCookie = (
	rawCookie: string,
	pathname: string
): string | undefined => {
	if (REFRESH_COOKIE_PATHS.has(pathname)) return rawCookie;

	const cookies = rawCookie
		.split(';')
		.map(cookie => cookie.trim())
		.filter(Boolean)
		.filter(cookie => {
			const separator = cookie.indexOf('=');
			const name =
				separator >= 0 ? cookie.slice(0, separator).trim() : cookie;
			return name !== REFRESH_COOKIE_NAME;
		});

	return cookies.length > 0 ? cookies.join('; ') : undefined;
};

const createUpstreamHeaders = (
	request: IncomingMessage,
	pathname: string,
	requestId: string,
	correlationId: string,
	validAuthorization?: string
): OutgoingHttpHeaders => {
	const hopByHopHeaders = getConnectionHeaderNames(request.headers);
	const headers: OutgoingHttpHeaders = {};

	for (const [name, value] of Object.entries(request.headers)) {
		const lowerName = name.toLowerCase();
		if (
			value === undefined ||
			hopByHopHeaders.has(lowerName) ||
			lowerName === 'cf-connecting-ip' ||
			lowerName === 'forwarded' ||
			lowerName === 'true-client-ip' ||
			lowerName === 'x-client-ip' ||
			lowerName === 'x-real-ip' ||
			lowerName === 'x-request-id' ||
			lowerName === 'x-correlation-id' ||
			lowerName.startsWith('x-forwarded-') ||
			lowerName.startsWith('x-user') ||
			lowerName.startsWith('x-auth') ||
			lowerName === 'x-winwidget-internal-token' ||
			lowerName.startsWith('x-internal-')
		) {
			continue;
		}
		headers[lowerName] = value;
	}

	const clientIp = resolveClientIp(
		request.socket.remoteAddress,
		request.headers
	);
	headers['x-forwarded-for'] = clientIp;
	headers['x-real-ip'] = clientIp;
	headers['x-forwarded-proto'] = resolveForwardedProto(request);
	headers['x-request-id'] = requestId;
	headers['x-correlation-id'] = correlationId;
	if (validAuthorization) {
		headers.authorization = validAuthorization;
	}

	const rawCookie = request.headers.cookie;
	if (typeof rawCookie === 'string') {
		const cookie = stripRefreshCookie(rawCookie, pathname);
		if (cookie) headers.cookie = cookie;
		else delete headers.cookie;
	}

	return headers;
};

const createDownstreamHeaders = (
	headers: IncomingHttpHeaders,
	requestId: string,
	correlationId: string
): OutgoingHttpHeaders => {
	const hopByHopHeaders = getConnectionHeaderNames(headers);
	const downstream: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase();
		if (value === undefined || hopByHopHeaders.has(lowerName)) continue;
		downstream[lowerName] = value;
	}
	downstream['x-request-id'] = requestId;
	downstream['x-correlation-id'] = correlationId;
	return downstream;
};

const isPublicWidgetApiPath = (pathname: string): boolean =>
	PUBLIC_WIDGET_API_PREFIXES.some(
		prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);

const createGeneratedCorsHeaders = (
	request: IncomingMessage,
	pathname: string,
	config: GatewayConfig
): OutgoingHttpHeaders => {
	if (isPublicWidgetApiPath(pathname)) {
		return {
			'access-control-allow-origin': '*',
			'access-control-expose-headers': 'x-request-id, x-correlation-id'
		};
	}

	const origins = getRawHeaderValues(request.rawHeaders, 'origin');
	if (origins.length !== 1 || !config.corsAllowedOrigins.has(origins[0])) {
		return {};
	}

	return {
		'access-control-allow-origin': origins[0],
		'access-control-allow-credentials': 'true',
		'access-control-expose-headers': 'x-request-id, x-correlation-id',
		vary: 'Origin'
	};
};

const sendJson = (
	response: ServerResponse,
	statusCode: number,
	body: object,
	requestId: string,
	correlationId: string,
	headOnly = false,
	extraHeaders: OutgoingHttpHeaders = {}
) => {
	const payload = Buffer.from(JSON.stringify(body));
	response.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': payload.byteLength,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		'x-request-id': requestId,
		'x-correlation-id': correlationId,
		...extraHeaders
	});
	response.end(headOnly ? undefined : payload);
};

const sendError = (
	request: IncomingMessage,
	response: ServerResponse,
	statusCode: number,
	error: string,
	message: string,
	code: string,
	requestId: string,
	correlationId: string,
	extraHeaders: OutgoingHttpHeaders = {}
) => {
	request.resume();
	const body: JsonErrorBody = {
		statusCode,
		error,
		message,
		code,
		requestId,
		correlationId
	};
	sendJson(
		response,
		statusCode,
		body,
		requestId,
		correlationId,
		request.method === 'HEAD',
		extraHeaders
	);
};

export const normalizeGatewayRoutingPathname = (
	pathname: string
): string | null => {
	try {
		const normalized = decodeURIComponent(pathname);
		if (
			normalized.includes('\0') ||
			normalized.includes('\\') ||
			normalized.startsWith('//')
		) {
			return null;
		}
		return normalized;
	} catch {
		return null;
	}
};

const parseRequestTarget = (
	request: IncomingMessage
): {
	rawPath: string;
	pathname: string;
	routingPathname: string;
} | null => {
	const rawPath = request.url;
	if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
		return null;
	}

	try {
		const parsed = new URL(rawPath, 'http://gateway.invalid');
		const routingPathname = normalizeGatewayRoutingPathname(
			parsed.pathname
		);
		if (!routingPathname) return null;
		return { rawPath, pathname: parsed.pathname, routingPathname };
	} catch {
		return null;
	}
};

const isApiV1Path = (pathname: string): boolean =>
	pathname === '/api/v1' || pathname.startsWith('/api/v1/');

export const matchGatewayRoute = (
	pathname: string,
	routes: readonly GatewayRouteConfig[]
): GatewayRouteConfig | undefined => {
	let match: GatewayRouteConfig | undefined;
	for (const route of routes) {
		const matchesBoundary =
			pathname === route.pathPrefix ||
			pathname.startsWith(`${route.pathPrefix}/`);
		if (
			matchesBoundary &&
			(!match || route.pathPrefix.length > match.pathPrefix.length)
		) {
			match = route;
		}
	}
	return match;
};

export const createGateway = (
	config: GatewayConfig,
	options: GatewayOptions = {}
): GatewayRuntime => {
	const log = options.logger ?? defaultLogger;
	const jwks = new JwksStore({
		url: config.jwksUrl,
		fetchTimeoutMs: config.jwksFetchTimeoutMs,
		refreshMinIntervalMs: config.jwksRefreshMinIntervalMs,
		cacheTtlMs: config.jwksCacheTtlMs,
		maxStaleMs: config.jwksMaxStaleMs,
		maxBytes: config.jwksMaxBytes,
		logger: log,
		fetch: options.fetch,
		now: options.now
	});
	const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 256 });
	const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 256 });
	const activeProxyRequests = new Set<ReturnType<typeof httpRequest>>();
	const widgetEventRateLimiter = new WidgetEventRateLimiter({
		now: options.now
	});

	const server = createServer((request, response) => {
		const { requestId, correlationId } = createRequestContext();
		const startedAt = process.hrtime.bigint();
		let requestPath = '/';
		let routeId = 'unmatched';
		let logged = false;
		const logCompletion = (event: string) => {
			if (logged) return;
			logged = true;
			const durationMs =
				Number(process.hrtime.bigint() - startedAt) / 1_000_000;
			log.log('info', event, {
				requestId,
				correlationId,
				routeId,
				method: request.method,
				path: requestPath,
				statusCode: response.statusCode,
				durationMs: Math.round(durationMs)
			});
		};
		response.once('finish', () => logCompletion('request_completed'));
		response.once('close', () => {
			if (!response.writableEnded) logCompletion('request_aborted');
		});

		const target = parseRequestTarget(request);
		const corsHeaders = createGeneratedCorsHeaders(
			request,
			target?.routingPathname ?? '',
			config
		);
		void (async () => {
			if (!target) {
				sendError(
					request,
					response,
					400,
					'Bad Request',
					'Invalid request target',
					'invalid_request_target',
					requestId,
					correlationId,
					corsHeaders
				);
				return;
			}
			requestPath = target.pathname;

			const isHead = request.method === 'HEAD';
			if (
				(request.method === 'GET' || isHead) &&
				target.pathname === '/health/live'
			) {
				routeId = 'gateway-health';
				sendJson(
					response,
					200,
					{ status: 'ok' },
					requestId,
					correlationId,
					isHead,
					corsHeaders
				);
				return;
			}
			if (
				(request.method === 'GET' || isHead) &&
				(target.pathname === '/health/ready' ||
					target.pathname === '/health')
			) {
				routeId = 'gateway-health';
				const ready = await jwks.ensureReady();
				sendJson(
					response,
					ready ? 200 : 503,
					{
						status: ready ? 'ready' : 'not_ready',
						jwks: jwks.getStatus()
					},
					requestId,
					correlationId,
					isHead,
					corsHeaders
				);
				return;
			}

			if (!isApiV1Path(target.routingPathname)) {
				sendError(
					request,
					response,
					404,
					'Not Found',
					'Route not found',
					'route_not_found',
					requestId,
					correlationId,
					corsHeaders
				);
				return;
			}

			const route = matchGatewayRoute(
				target.routingPathname,
				config.routes
			);
			if (!route) {
				sendError(
					request,
					response,
					404,
					'Not Found',
					'Route not found',
					'route_not_found',
					requestId,
					correlationId,
					corsHeaders
				);
				return;
			}
			routeId = route.id;

			if (request.method === 'POST') {
				const rateLimit = widgetEventRateLimiter.consume(
					target.routingPathname,
					resolveClientIp(request.socket.remoteAddress, request.headers)
				);
				if (rateLimit && !rateLimit.allowed) {
					log.log('warn', 'widget_event_rate_limited', {
						requestId,
						correlationId,
						routeId,
						path: target.pathname
					});
					sendError(
						request,
						response,
						429,
						'Too Many Requests',
						'Widget event rate limit exceeded',
						'widget_event_rate_limited',
						requestId,
						correlationId,
						{
							...corsHeaders,
							'retry-after': String(rateLimit.retryAfterSeconds)
						}
					);
					return;
				}
			}

			let bearerToken: string | undefined;
			try {
				bearerToken = readBearerAuthorization(request.rawHeaders);
				if (
					!bearerToken &&
					route.authPolicy === 'required' &&
					request.method !== 'OPTIONS'
				) {
					sendError(
						request,
						response,
						401,
						'Unauthorized',
						'Access token is required',
						'authentication_required',
						requestId,
						correlationId,
						corsHeaders
					);
					return;
				}
				if (bearerToken) {
					await verifyAccessToken(bearerToken, jwks, config);
				}
			} catch (error) {
				if (error instanceof JwksUnavailableError) {
					sendError(
						request,
						response,
						503,
						'Service Unavailable',
						'Authentication keys are unavailable',
						'authentication_keys_unavailable',
						requestId,
						correlationId,
						corsHeaders
					);
					return;
				}

				const errorCode =
					error instanceof UnknownSigningKeyError
						? 'unknown_kid'
						: error instanceof JwtValidationError
							? error.code
							: 'invalid_token';
				log.log('warn', 'access_token_rejected', {
					requestId,
					correlationId,
					routeId,
					errorCode
				});
				sendError(
					request,
					response,
					401,
					'Unauthorized',
					'Invalid access token',
					'invalid_token',
					requestId,
					correlationId,
					corsHeaders
				);
				return;
			}

			const upstreamHeaders = createUpstreamHeaders(
				request,
				target.routingPathname,
				requestId,
				correlationId,
				bearerToken ? request.headers.authorization : undefined
			);
			const useTls = route.upstreamUrl.protocol === 'https:';
			const requestFn = useTls ? httpsRequest : httpRequest;
			const proxyRequest = requestFn(
				{
					protocol: route.upstreamUrl.protocol,
					hostname: route.upstreamUrl.hostname,
					port: route.upstreamUrl.port || (useTls ? 443 : 80),
					method: request.method,
					path: target.rawPath,
					headers: upstreamHeaders,
					agent: useTls ? httpsAgent : httpAgent
				},
				upstreamResponse => {
					clearTimeout(responseHeaderTimeout);
					const downstreamHeaders = createDownstreamHeaders(
						upstreamResponse.headers,
						requestId,
						correlationId
					);
					response.writeHead(
						upstreamResponse.statusCode ?? 502,
						downstreamHeaders
					);

					upstreamResponse.setTimeout(route.timeoutMs, () =>
						upstreamResponse.destroy(
							new Error('upstream_response_timeout')
						)
					);
					upstreamResponse.pipe(response);
					upstreamResponse.once('end', () => {
						activeProxyRequests.delete(proxyRequest);
					});
					upstreamResponse.once('error', () => {
						activeProxyRequests.delete(proxyRequest);
						if (!response.destroyed) response.destroy();
					});
				}
			);
			activeProxyRequests.add(proxyRequest);
			let timedOut = false;
			const responseHeaderTimeout = setTimeout(() => {
				timedOut = true;
				proxyRequest.destroy(new Error('upstream_headers_timeout'));
			}, route.timeoutMs);

			proxyRequest.once('error', () => {
				clearTimeout(responseHeaderTimeout);
				activeProxyRequests.delete(proxyRequest);
				if (response.headersSent || response.destroyed) {
					if (!response.destroyed) response.destroy();
					return;
				}

				const statusCode = timedOut ? 504 : 502;
				sendError(
					request,
					response,
					statusCode,
					timedOut ? 'Gateway Timeout' : 'Bad Gateway',
					timedOut
						? 'Upstream request timed out'
						: 'Upstream service is unavailable',
					timedOut ? 'upstream_timeout' : 'upstream_unavailable',
					requestId,
					correlationId,
					corsHeaders
				);
			});
			request.once('aborted', () => {
				clearTimeout(responseHeaderTimeout);
				proxyRequest.destroy(new Error('client_aborted'));
			});
			response.once('close', () => {
				if (!response.writableEnded) {
					clearTimeout(responseHeaderTimeout);
					proxyRequest.destroy(new Error('client_closed'));
				}
			});
			request.pipe(proxyRequest);
		})().catch(() => {
			if (!response.headersSent && !response.destroyed) {
				sendError(
					request,
					response,
					500,
					'Internal Server Error',
					'Gateway request failed',
					'gateway_error',
					requestId,
					correlationId,
					corsHeaders
				);
			} else if (!response.destroyed) {
				response.destroy();
			}
		});
	});

	server.maxHeadersCount = 100;
	server.headersTimeout = 15_000;
	server.requestTimeout = 120_000;
	server.keepAliveTimeout = 5_000;
	server.on('clientError', (_error, socket) => {
		if (!socket.writable) return;
		socket.end(
			'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
		);
	});

	const listen = (
		port = config.port,
		host = config.listenHost
	): Promise<void> =>
		new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				server.off('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, host);
		});

	const close = async (): Promise<void> => {
		const closePromise = new Promise<void>(resolve => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.close(() => resolve());
			server.closeIdleConnections();
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			closePromise,
			new Promise<void>(resolve => {
				timeout = setTimeout(() => {
					for (const request of activeProxyRequests) {
						request.destroy(new Error('gateway_shutdown'));
					}
					server.closeAllConnections();
					resolve();
				}, config.shutdownGraceMs);
			})
		]);
		if (timeout) clearTimeout(timeout);
		httpAgent.destroy();
		httpsAgent.destroy();
	};

	return {
		server,
		jwks,
		initialize: () => jwks.initialize(),
		listen,
		close,
		address: () => server.address()
	};
};
