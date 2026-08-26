import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type RequestOptions,
	type Server
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GatewayConfig, GatewayRouteConfig } from '../src/config';
import type { FetchLike } from '../src/jwks';
import type { StructuredLogger } from '../src/logger';

export interface SigningFixture {
	kid: string;
	privateKey: KeyObject;
	publicJwk: Record<string, unknown>;
}

export const silentLogger: StructuredLogger = {
	log() {}
};

export const createSigningFixture = (kid: string): SigningFixture => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 3072
	});
	return {
		kid,
		privateKey,
		publicJwk: {
			...publicKey.export({ format: 'jwk' }),
			kid,
			kty: 'RSA',
			alg: 'RS256',
			use: 'sig',
			key_ops: ['verify']
		}
	};
};

const encodeJson = (value: Record<string, unknown>): string =>
	Buffer.from(JSON.stringify(value)).toString('base64url');

export const signAccessToken = (
	fixture: SigningFixture,
	overrides: Record<string, unknown> = {},
	headerOverrides: Record<string, unknown> = {}
): string => {
	const now = Math.floor(Date.now() / 1000);
	const header = encodeJson({
		alg: 'RS256',
		kid: fixture.kid,
		typ: 'at+jwt',
		...headerOverrides
	});
	const payload = encodeJson({
		iss: 'https://api.winwidget.test/auth',
		aud: 'https://api.winwidget.test',
		sub: 'user-1',
		sid: '11111111-1111-4111-8111-111111111111',
		roles: ['USER'],
		token_use: 'access',
		jti: '22222222-2222-4222-8222-222222222222',
		iat: now,
		nbf: now,
		exp: now + 10 * 60,
		...overrides
	});
	const input = `${header}.${payload}`;
	const signature = sign(
		'RSA-SHA256',
		Buffer.from(input),
		fixture.privateKey
	).toString('base64url');
	return `${input}.${signature}`;
};

export const createJwksFetch =
	(
		getKeys: () => Record<string, unknown>[],
		getAvailable: () => boolean = () => true,
		onCall: () => void = () => undefined
	): FetchLike =>
	async () => {
		onCall();
		if (!getAvailable()) {
			throw new Error('jwks unavailable');
		}
		const body = JSON.stringify({ keys: getKeys() });
		return {
			ok: true,
			status: 200,
			headers: {
				get(name: string) {
					return name.toLowerCase() === 'content-length'
						? String(Buffer.byteLength(body))
						: null;
				}
			},
			async text() {
				return body;
			}
		};
	};

export const createTestRoute = (
	overrides: Partial<GatewayRouteConfig> = {}
): GatewayRouteConfig => ({
	id: 'test-route',
	pathPrefix: '/api/v1/test',
	upstreamUrl: new URL('http://127.0.0.1:4299'),
	authPolicy: 'optional',
	timeoutMs: 1000,
	...overrides
});

export const createTestConfig = (
	overrides: Partial<GatewayConfig> = {}
): GatewayConfig => ({
	listenHost: '127.0.0.1',
	port: 4100,
	routes: [createTestRoute()],
	jwksUrl: new URL('http://127.0.0.1:4201/.well-known/jwks.json'),
	issuer: 'https://api.winwidget.test/auth',
	audience: 'https://api.winwidget.test',
	corsAllowedOrigins: new Set([
		'https://winwidget.test',
		'https://www.winwidget.test'
	]),
	clockToleranceSeconds: 30,
	maxTokenLifetimeSeconds: 60 * 60,
	maxTokenBytes: 16 * 1024,
	jwksFetchTimeoutMs: 1000,
	jwksRefreshMinIntervalMs: 10,
	jwksCacheTtlMs: 1000,
	jwksMaxStaleMs: 10_000,
	jwksMaxBytes: 256 * 1024,
	shutdownGraceMs: 1000,
	...overrides
});

export const listenServer = (server: Server): Promise<URL> =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address() as AddressInfo;
			resolve(new URL(`http://127.0.0.1:${address.port}`));
		});
	});

export const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(error => {
			if (error) reject(error);
			else resolve();
		});
		server.closeAllConnections();
	});

export interface HttpResult {
	statusCode: number;
	headers: IncomingHttpHeaders;
	rawHeaders: string[];
	body: string;
}

export const makeRequest = (
	url: URL,
	options: RequestOptions & { body?: string } = {}
): Promise<HttpResult> =>
	new Promise((resolve, reject) => {
		const body = options.body;
		const request = httpRequest(
			url,
			{
				...options,
				headers: {
					...(body
						? {
								'content-length': Buffer.byteLength(body)
							}
						: {}),
					...options.headers
				}
			},
			response => {
				const chunks: Buffer[] = [];
				response.on('data', chunk => chunks.push(Buffer.from(chunk)));
				response.on('end', () =>
					resolve({
						statusCode: response.statusCode ?? 0,
						headers: response.headers,
						rawHeaders: response.rawHeaders,
						body: Buffer.concat(chunks).toString('utf8')
					})
				);
			}
		);
		request.once('error', reject);
		if (body) request.write(body);
		request.end();
	});

export { createServer };
