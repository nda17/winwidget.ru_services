export interface GatewayConfig {
	listenHost: string;
	port: number;
	upstreamUrl: URL;
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
	proxyTimeoutMs: number;
	shutdownGraceMs: number;
}

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
		upstreamUrl: readHttpUrl(
			'API_UPSTREAM_URL',
			env.API_UPSTREAM_URL?.trim() || 'http://127.0.0.1:4200',
			{ originOnly: true }
		),
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
		proxyTimeoutMs: readInteger(
			env,
			'PROXY_TIMEOUT_MS',
			60 * 1000,
			1000,
			10 * 60 * 1000
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
