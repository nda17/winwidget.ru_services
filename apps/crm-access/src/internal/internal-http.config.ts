const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function parseInternalBaseUrl(
	name: string,
	value: string | undefined,
	fallback: string,
	mode = process.env.NODE_ENV
): string {
	if (mode === 'production' && !value?.trim()) {
		throw new Error(`${name} must be explicitly configured in production`);
	}
	let url: URL;
	try {
		url = new URL(value?.trim() || fallback);
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
	if (
		(url.protocol !== 'https:' &&
			!(
				url.protocol === 'http:' &&
				LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
			)) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error(
			`${name} must be an exact HTTPS origin or loopback HTTP origin`
		);
	}
	return url.toString().replace(/\/$/, '');
}

export function parseInternalTimeout(
	name: string,
	value: string | undefined
): number {
	const timeout = value?.trim() ? Number(value) : DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
		throw new Error(`${name} must be an integer between 500 and 60000`);
	}
	return timeout;
}

export function parseInternalToken(
	name: string,
	value: string | undefined,
	knownPlaceholders: readonly string[]
): string {
	const token = value?.trim() || '';
	if (
		token.length < 32 ||
		knownPlaceholders.includes(token) ||
		/^(?:change[_-]?me|ci_)/i.test(token)
	) {
		throw new Error(
			`${name} must be a non-placeholder secret with at least 32 characters`
		);
	}
	return token;
}

export async function readBoundedJson(
	response: Response,
	maximumBytes = 64 * 1024
): Promise<unknown> {
	if (!response.body) throw new Error('EMPTY_RESPONSE_BODY');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > maximumBytes) {
				throw new Error('RESPONSE_BODY_TOO_LARGE');
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

export function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[]
): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	);
}

export const isUuidV4 = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value
	);

export const isRecord = (
	value: unknown
): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
