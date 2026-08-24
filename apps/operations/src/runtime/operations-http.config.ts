import { RequestMethod } from '@nestjs/common';

const UNSAFE_TRUST_PROXY_VALUES = new Set([
	'*',
	'true',
	'0.0.0.0/0',
	'::/0'
]);
const TRUST_PROXY_VALUE_PATTERN = /^[A-Za-z0-9.:/_-]{1,128}$/;

export const OPERATIONS_GLOBAL_PREFIX_EXCLUDES = [
	{ path: 'health/live', method: RequestMethod.GET },
	{ path: 'health/ready', method: RequestMethod.GET }
] as const;

export function getOperationsTrustProxyConfig(
	value: string | undefined
): string | string[] {
	const entries = (value || 'loopback')
		.split(',')
		.map(entry => entry.trim())
		.filter(Boolean);
	if (
		!entries.length ||
		entries.some(
			entry =>
				UNSAFE_TRUST_PROXY_VALUES.has(entry.toLowerCase()) ||
				!TRUST_PROXY_VALUE_PATTERN.test(entry)
		)
	) {
		throw new Error(
			'TRUST_PROXY must contain explicit proxy IP/CIDR values or loopback'
		);
	}
	return entries.length === 1 ? entries[0] : entries;
}

export function getOperationsCorsAllowedOrigins(
	mode: string | undefined,
	value: string | undefined
): true | string[] {
	if (mode === 'development') return true;
	const values = value?.split(',').map(item => item.trim());
	if (!values?.length || values.some(item => !item || item === '*')) {
		throw new Error(
			'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
		);
	}
	const origins = values.map(item => {
		let url: URL;
		try {
			url = new URL(item);
		} catch {
			throw new Error(
				'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
			);
		}
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
			);
		}
		return url.origin;
	});
	return [...new Set(origins)];
}

export function getOperationsListenHost(
	mode: string | undefined,
	value: string | undefined
): string {
	const host = value?.trim() || '127.0.0.1';
	if (['0.0.0.0', '::', '*'].includes(host)) {
		throw new Error(
			'OPERATIONS_LISTEN_HOST must not be a wildcard address'
		);
	}
	if (
		mode !== 'development' &&
		!['127.0.0.1', '::1', 'localhost'].includes(host)
	) {
		throw new Error(
			'OPERATIONS_LISTEN_HOST must be loopback in production'
		);
	}
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
		throw new Error('OPERATIONS_LISTEN_HOST is invalid');
	}
	return host;
}
