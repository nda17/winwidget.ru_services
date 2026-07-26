import {
	createPublicKey,
	type JsonWebKey,
	type KeyObject
} from 'node:crypto';
import type { StructuredLogger } from './logger';

interface FetchResponse {
	ok: boolean;
	status: number;
	headers: {
		get(name: string): string | null;
	};
	text(): Promise<string>;
}

export type FetchLike = (
	input: string | URL,
	init?: {
		headers?: Record<string, string>;
		redirect?: 'error';
		signal?: AbortSignal;
	}
) => Promise<FetchResponse>;

export interface JwksStoreOptions {
	url: URL;
	fetchTimeoutMs: number;
	refreshMinIntervalMs: number;
	cacheTtlMs: number;
	maxStaleMs: number;
	maxBytes: number;
	logger: StructuredLogger;
	fetch?: FetchLike;
	now?: () => number;
}

export class JwksUnavailableError extends Error {
	readonly code = 'jwks_unavailable';
}

export class UnknownSigningKeyError extends Error {
	readonly code = 'unknown_signing_key';
}

interface RefreshResult {
	attempted: boolean;
	succeeded: boolean;
}

const PRIVATE_JWK_FIELDS = [
	'd',
	'p',
	'q',
	'dp',
	'dq',
	'qi',
	'oth'
] as const;
const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJwks = (raw: string): Map<string, KeyObject> => {
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		throw new Error('JWKS response is not valid JSON');
	}

	if (!isRecord(document) || !Array.isArray(document.keys)) {
		throw new Error('JWKS response must contain a keys array');
	}
	if (document.keys.length === 0 || document.keys.length > 32) {
		throw new Error('JWKS keys array size is invalid');
	}

	const keys = new Map<string, KeyObject>();
	for (const candidate of document.keys) {
		if (!isRecord(candidate)) {
			throw new Error('JWKS contains an invalid key');
		}

		const kid = candidate.kid;
		if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
			throw new Error('JWKS key kid is invalid');
		}
		if (keys.has(kid)) {
			throw new Error('JWKS contains duplicate kid values');
		}
		if (
			candidate.kty !== 'RSA' ||
			candidate.alg !== 'RS256' ||
			candidate.use !== 'sig'
		) {
			throw new Error('JWKS key must be an RS256 signing key');
		}
		if (
			typeof candidate.n !== 'string' ||
			typeof candidate.e !== 'string'
		) {
			throw new Error('JWKS RSA key material is invalid');
		}
		if (PRIVATE_JWK_FIELDS.some(field => field in candidate)) {
			throw new Error('JWKS must not expose private key material');
		}
		if (
			candidate.key_ops !== undefined &&
			(!Array.isArray(candidate.key_ops) ||
				candidate.key_ops.length !== 1 ||
				candidate.key_ops[0] !== 'verify')
		) {
			throw new Error('JWKS key_ops must contain only verify');
		}

		let key: KeyObject;
		try {
			key = createPublicKey({
				key: candidate as JsonWebKey,
				format: 'jwk'
			});
		} catch {
			throw new Error('JWKS RSA public key cannot be imported');
		}

		if (
			key.asymmetricKeyType !== 'rsa' ||
			(key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
		) {
			throw new Error('JWKS RSA key must be at least 2048 bits');
		}
		keys.set(kid, key);
	}

	return keys;
};

export class JwksStore {
	private keys = new Map<string, KeyObject>();
	private lastAttemptAt = 0;
	private lastSuccessAt = 0;
	private refreshPromise: Promise<RefreshResult> | null = null;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;

	constructor(private readonly options: JwksStoreOptions) {
		this.fetchImpl =
			options.fetch ??
			((input, init) =>
				globalThis.fetch(input, init) as Promise<FetchResponse>);
		this.now = options.now ?? Date.now;
	}

	async initialize(): Promise<boolean> {
		try {
			await this.refresh(true);
		} catch {
			return false;
		}
		return this.isReady();
	}

	async ensureReady(): Promise<boolean> {
		const age = this.now() - this.lastSuccessAt;
		if (this.keys.size === 0 || age > this.options.cacheTtlMs) {
			try {
				await this.refresh(false);
			} catch {
				// A warm cache remains usable up to maxStaleMs.
			}
		}
		return this.isReady();
	}

	isReady(): boolean {
		return (
			this.keys.size > 0 &&
			this.lastSuccessAt > 0 &&
			this.now() - this.lastSuccessAt <= this.options.maxStaleMs
		);
	}

	getStatus() {
		return {
			ready: this.isReady(),
			keyCount: this.keys.size,
			lastSuccessAt:
				this.lastSuccessAt > 0
					? new Date(this.lastSuccessAt).toISOString()
					: null
		};
	}

	async getKey(kid: string): Promise<KeyObject> {
		const cached = this.keys.get(kid);
		if (cached && this.isReady()) return cached;

		let refreshFailed = false;
		try {
			await this.refresh(false);
		} catch {
			refreshFailed = true;
		}

		const refreshed = this.keys.get(kid);
		if (refreshed && this.isReady()) return refreshed;
		if (this.keys.size === 0 || !this.isReady() || refreshFailed) {
			throw new JwksUnavailableError('JWKS is unavailable');
		}
		throw new UnknownSigningKeyError('Unknown JWT kid');
	}

	private async refresh(force: boolean): Promise<RefreshResult> {
		if (this.refreshPromise) return this.refreshPromise;

		const now = this.now();
		if (
			!force &&
			this.lastAttemptAt > 0 &&
			now - this.lastAttemptAt < this.options.refreshMinIntervalMs
		) {
			return { attempted: false, succeeded: false };
		}

		this.lastAttemptAt = now;
		this.refreshPromise = this.fetchAndReplaceKeys();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async fetchAndReplaceKeys(): Promise<RefreshResult> {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.options.fetchTimeoutMs
		);

		try {
			const response = await this.fetchImpl(this.options.url, {
				headers: {
					accept: 'application/json'
				},
				redirect: 'error',
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`JWKS returned HTTP ${response.status}`);
			}

			const contentLength = Number(response.headers.get('content-length'));
			if (
				Number.isFinite(contentLength) &&
				contentLength > this.options.maxBytes
			) {
				throw new Error('JWKS response is too large');
			}

			const body = await response.text();
			if (Buffer.byteLength(body) > this.options.maxBytes) {
				throw new Error('JWKS response is too large');
			}

			const keys = parseJwks(body);
			this.keys = keys;
			this.lastSuccessAt = this.now();
			this.options.logger.log('info', 'jwks_refresh_succeeded', {
				keyCount: keys.size
			});
			return { attempted: true, succeeded: true };
		} catch (error) {
			this.options.logger.log('warn', 'jwks_refresh_failed', {
				errorCode:
					error instanceof Error && error.name === 'AbortError'
						? 'timeout'
						: 'fetch_failed'
			});
			throw new JwksUnavailableError('Unable to refresh JWKS');
		} finally {
			clearTimeout(timeout);
		}
	}
}
