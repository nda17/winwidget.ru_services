import { RequestMethod } from '@nestjs/common';

export const IDENTITY_GLOBAL_PREFIX_EXCLUDES = [
	{ path: 'health/live', method: RequestMethod.ALL },
	{ path: 'health/ready', method: RequestMethod.ALL },
	{ path: 'health/revision', method: RequestMethod.ALL },
	{ path: 'health/ownership', method: RequestMethod.ALL },
	{ path: 'internal/v1/auth/introspect', method: RequestMethod.ALL },
	{
		path: 'internal/v1/widgets/owners/resolve',
		method: RequestMethod.ALL
	},
	{ path: 'internal/v1/widgets/owners/search', method: RequestMethod.ALL },
	{
		path: 'internal/v1/operations/audit-snapshots',
		method: RequestMethod.ALL
	},
	{
		path: 'internal/v1/operations/admin-health',
		method: RequestMethod.GET
	},
	{
		path: 'internal/v1/campaigns/eligible-contacts',
		method: RequestMethod.ALL
	},
	{
		path: 'internal/v1/billing/lifecycle/complete',
		method: RequestMethod.ALL
	},
	{
		path: 'internal/v1/identity/messaging/overview',
		method: RequestMethod.GET
	},
	{
		path: 'internal/v1/identity/messaging/failures',
		method: RequestMethod.GET
	},
	{
		path: 'internal/v1/identity/messaging/failures/:id/retry',
		method: RequestMethod.POST
	},
	{
		path: 'internal/v1/identity/messaging/failures/:id/close',
		method: RequestMethod.POST
	}
] as const;

const UNSAFE_TRUST_PROXY = new Set(['*', 'true', '0.0.0.0/0', '::/0']);
const TRUST_PROXY_PATTERN = /^[A-Za-z0-9.:/_-]{1,128}$/;

export function identityTrustProxy(
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
				UNSAFE_TRUST_PROXY.has(entry.toLowerCase()) ||
				!TRUST_PROXY_PATTERN.test(entry)
		)
	) {
		throw new Error(
			'TRUST_PROXY must contain explicit proxy IP/CIDR values or loopback'
		);
	}
	return entries.length === 1 ? entries[0] : entries;
}

export function identityCorsOrigins(
	mode: string | undefined,
	value: string | undefined
): true | string[] {
	if (mode?.trim().toLowerCase() === 'development') return true;
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

export function identityListenHost(
	mode: string | undefined,
	value: string | undefined
): string {
	const host = value?.trim() || '127.0.0.1';
	if (['0.0.0.0', '::', '*'].includes(host)) {
		throw new Error('IDENTITY_LISTEN_HOST must not be a wildcard address');
	}
	if (
		mode?.trim().toLowerCase() !== 'development' &&
		!['127.0.0.1', '::1', 'localhost'].includes(host)
	) {
		throw new Error('IDENTITY_LISTEN_HOST must be loopback in production');
	}
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
		throw new Error('IDENTITY_LISTEN_HOST is invalid');
	}
	return host;
}
