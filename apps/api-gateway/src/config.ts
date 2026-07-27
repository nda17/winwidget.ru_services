export type GatewayAuthPolicy = 'required' | 'optional';

export interface GatewayRouteConfig {
	id: string;
	pathPrefix: string;
	upstreamUrl: URL;
	authPolicy: GatewayAuthPolicy;
	timeoutMs: number;
}

export interface GatewayConfig {
	listenHost: string;
	port: number;
	routes: readonly GatewayRouteConfig[];
	jwksUrl: URL;
	issuer: string;
	audience: string;
	corsAllowedOrigins: ReadonlySet<string>;
	clockToleranceSeconds: number;
	maxTokenLifetimeSeconds: number;
	maxTokenBytes: number;
	jwksFetchTimeoutMs: number;
	jwksRefreshMinIntervalMs: number;
	jwksCacheTtlMs: number;
	jwksMaxStaleMs: number;
	jwksMaxBytes: number;
	shutdownGraceMs: number;
}

const ROUTES_ENV_NAME = 'GATEWAY_ROUTES_JSON';
const ROUTE_FIELDS = new Set([
	'id',
	'pathPrefix',
	'upstreamUrl',
	'authPolicy',
	'timeoutMs'
]);
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ROUTES_JSON_BYTES = 256 * 1024;
const MAX_ROUTES = 256;

const readRequired = (env: NodeJS.ProcessEnv, name: string): string => {
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
};

const readInteger = (
	env: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	min: number,
	max: number
): number => {
	const raw = env[name]?.trim();
	if (!raw) return fallback;

	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(
			`${name} must be an integer between ${min} and ${max}`
		);
	}
	return value;
};

const readHttpUrl = (
	name: string,
	value: string,
	options: { originOnly?: boolean } = {}
): URL => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}

	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new Error(`${name} must use http or https`);
	}
	if (url.username || url.password || url.hash) {
		throw new Error(`${name} must not contain credentials or a fragment`);
	}
	if (
		options.originOnly &&
		(url.pathname !== '/' || url.search.length > 0)
	) {
		throw new Error(`${name} must contain only an origin`);
	}

	return url;
};

const readCorsAllowedOrigins = (
	env: NodeJS.ProcessEnv
): ReadonlySet<string> => {
	const raw = readRequired(env, 'CORS_ALLOWED_ORIGINS');
	const origins = new Set<string>();

	for (const value of raw.split(',')) {
		const candidate = value.trim();
		if (!candidate || candidate === '*') {
			throw new Error(
				'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
			);
		}
		const url = readHttpUrl('CORS_ALLOWED_ORIGINS', candidate, {
			originOnly: true
		});
		origins.add(url.origin);
	}

	if (origins.size === 0) {
		throw new Error('CORS_ALLOWED_ORIGINS must not be empty');
	}
	return origins;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const readRoutePathPrefix = (value: unknown, index: number): string => {
	const name = `${ROUTES_ENV_NAME}[${index}].pathPrefix`;
	if (typeof value !== 'string' || !value) {
		throw new Error(`${name} must be a non-empty string`);
	}
	if (
		(value !== '/api/v1' && !value.startsWith('/api/v1/')) ||
		(value.length > '/api/v1'.length && value.endsWith('/')) ||
		value.includes('//') ||
		value.includes('%') ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#')
	) {
		throw new Error(
			`${name} must be /api/v1 or a canonical path below /api/v1 without a trailing slash`
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(value, 'http://gateway.invalid');
	} catch {
		throw new Error(`${name} must be a valid path`);
	}
	if (parsed.pathname !== value) {
		throw new Error(`${name} must be a canonical path`);
	}
	return value;
};

const readRoutes = (
	env: NodeJS.ProcessEnv
): readonly GatewayRouteConfig[] => {
	if (env.API_UPSTREAM_URL?.trim()) {
		throw new Error(
			'API_UPSTREAM_URL is no longer supported; use GATEWAY_ROUTES_JSON'
		);
	}

	const raw = readRequired(env, ROUTES_ENV_NAME);
	if (Buffer.byteLength(raw) > MAX_ROUTES_JSON_BYTES) {
		throw new Error(`${ROUTES_ENV_NAME} is too large`);
	}

	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		throw new Error(`${ROUTES_ENV_NAME} must contain valid JSON`);
	}
	if (
		!Array.isArray(document) ||
		document.length === 0 ||
		document.length > MAX_ROUTES
	) {
		throw new Error(
			`${ROUTES_ENV_NAME} must contain between 1 and ${MAX_ROUTES} routes`
		);
	}

	const ids = new Set<string>();
	const pathPrefixes = new Set<string>();
	const routes = document.map((candidate, index): GatewayRouteConfig => {
		const name = `${ROUTES_ENV_NAME}[${index}]`;
		if (!isRecord(candidate)) {
			throw new Error(`${name} must be an object`);
		}

		const fields = Object.keys(candidate);
		const unknownFields = fields.filter(field => !ROUTE_FIELDS.has(field));
		const missingFields = [...ROUTE_FIELDS].filter(
			field => !(field in candidate)
		);
		if (unknownFields.length > 0 || missingFields.length > 0) {
			throw new Error(
				`${name} must contain exactly id, pathPrefix, upstreamUrl, authPolicy and timeoutMs`
			);
		}

		if (
			typeof candidate.id !== 'string' ||
			!ROUTE_ID_PATTERN.test(candidate.id)
		) {
			throw new Error(`${name}.id is invalid`);
		}
		if (ids.has(candidate.id)) {
			throw new Error(`${ROUTES_ENV_NAME} contains duplicate route id`);
		}
		ids.add(candidate.id);

		const pathPrefix = readRoutePathPrefix(candidate.pathPrefix, index);
		if (pathPrefixes.has(pathPrefix)) {
			throw new Error(
				`${ROUTES_ENV_NAME} contains duplicate route pathPrefix`
			);
		}
		pathPrefixes.add(pathPrefix);

		if (typeof candidate.upstreamUrl !== 'string') {
			throw new Error(`${name}.upstreamUrl must be a string`);
		}
		const upstreamUrl = readHttpUrl(
			`${name}.upstreamUrl`,
			candidate.upstreamUrl,
			{ originOnly: true }
		);

		if (
			candidate.authPolicy !== 'required' &&
			candidate.authPolicy !== 'optional'
		) {
			throw new Error(`${name}.authPolicy must be required or optional`);
		}
		if (
			typeof candidate.timeoutMs !== 'number' ||
			!Number.isSafeInteger(candidate.timeoutMs) ||
			candidate.timeoutMs < 1000 ||
			candidate.timeoutMs > 10 * 60 * 1000
		) {
			throw new Error(
				`${name}.timeoutMs must be an integer between 1000 and 600000`
			);
		}

		return {
			id: candidate.id,
			pathPrefix,
			upstreamUrl,
			authPolicy: candidate.authPolicy,
			timeoutMs: candidate.timeoutMs
		};
	});

	return routes.sort(
		(left, right) => right.pathPrefix.length - left.pathPrefix.length
	);
};

export const loadConfig = (
	env: NodeJS.ProcessEnv = process.env
): GatewayConfig => {
	const listenHost = env.GATEWAY_LISTEN_HOST?.trim() || '127.0.0.1';
	const portVariable = env.GATEWAY_PORT?.trim() ? 'GATEWAY_PORT' : 'PORT';
	if (listenHost.length > 255 || /[\s/]/.test(listenHost)) {
		throw new Error('GATEWAY_LISTEN_HOST is invalid');
	}

	const jwksCacheTtlMs = readInteger(
		env,
		'JWKS_CACHE_TTL_MS',
		5 * 60 * 1000,
		1000,
		24 * 60 * 60 * 1000
	);
	const jwksMaxStaleMs = readInteger(
		env,
		'JWKS_MAX_STALE_MS',
		60 * 60 * 1000,
		jwksCacheTtlMs,
		7 * 24 * 60 * 60 * 1000
	);

	return {
		listenHost,
		port: readInteger(env, portVariable, 4100, 1, 65535),
		routes: readRoutes(env),
		jwksUrl: readHttpUrl(
			'JWT_JWKS_URL',
			readRequired(env, 'JWT_JWKS_URL')
		),
		issuer: readRequired(env, 'JWT_ISSUER'),
		audience: readRequired(env, 'JWT_AUDIENCE'),
		corsAllowedOrigins: readCorsAllowedOrigins(env),
		clockToleranceSeconds: readInteger(
			env,
			'JWT_CLOCK_TOLERANCE_SECONDS',
			30,
			0,
			60
		),
		maxTokenLifetimeSeconds: readInteger(
			env,
			'JWT_MAX_TOKEN_LIFETIME_SECONDS',
			15 * 60,
			60,
			30 * 60
		),
		maxTokenBytes: readInteger(
			env,
			'JWT_MAX_TOKEN_BYTES',
			16 * 1024,
			1024,
			64 * 1024
		),
		jwksFetchTimeoutMs: readInteger(
			env,
			'JWKS_FETCH_TIMEOUT_MS',
			3000,
			250,
			30000
		),
		jwksRefreshMinIntervalMs: readInteger(
			env,
			'JWKS_REFRESH_MIN_INTERVAL_MS',
			5000,
			250,
			5 * 60 * 1000
		),
		jwksCacheTtlMs,
		jwksMaxStaleMs,
		jwksMaxBytes: readInteger(
			env,
			'JWKS_MAX_BYTES',
			256 * 1024,
			1024,
			1024 * 1024
		),
		shutdownGraceMs: readInteger(
			env,
			'SHUTDOWN_GRACE_MS',
			10 * 1000,
			1000,
			60 * 1000
		)
	};
};
