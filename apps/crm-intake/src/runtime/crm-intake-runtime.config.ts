const LISTEN_HOST_ERROR = 'CRM_INTAKE_LISTEN_HOST is invalid';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseCrmIntakePort(
	value?: string,
	role: 'api' | 'worker' | 'publisher' | 'all' = 'api'
): number {
	const expected =
		role === 'worker' ? 5311 : role === 'publisher' ? 5312 : 5310;
	if (value === undefined) return expected;
	const port = Number(value);
	if (!Number.isInteger(port) || port !== expected) {
		throw new Error(
			`CRM_INTAKE_PORT must be the canonical port ${expected}`
		);
	}
	return port;
}

export function parseCrmIntakeListenHost(
	value?: string,
	mode?: string
): string {
	const host = value?.trim() || '127.0.0.1';
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
		throw new Error(LISTEN_HOST_ERROR);
	}
	if (['0.0.0.0', '::'].includes(host)) {
		throw new Error(
			'CRM_INTAKE_LISTEN_HOST must not be a wildcard address'
		);
	}
	if (
		mode?.trim().toLowerCase() !== 'development' &&
		!LOOPBACK_HOSTS.has(host)
	) {
		throw new Error(
			'CRM_INTAKE_LISTEN_HOST must be loopback in production'
		);
	}
	return host;
}
