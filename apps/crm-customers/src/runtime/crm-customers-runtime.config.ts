const PORT_ERROR = 'CRM_CUSTOMERS_PORT must be the canonical port 5320';
const LISTEN_HOST_ERROR = 'CRM_CUSTOMERS_LISTEN_HOST is invalid';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseCrmCustomersPort(value?: string): number {
	if (value === undefined) return 5320;
	const port = Number(value);
	if (!Number.isInteger(port) || port !== 5320) {
		throw new Error(PORT_ERROR);
	}
	return port;
}

export function parseCrmCustomersListenHost(
	value?: string,
	mode?: string
): string {
	const host = value?.trim() || '127.0.0.1';
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
		throw new Error(LISTEN_HOST_ERROR);
	}
	if (['0.0.0.0', '::'].includes(host)) {
		throw new Error(
			'CRM_CUSTOMERS_LISTEN_HOST must not be a wildcard address'
		);
	}
	if (
		mode?.trim().toLowerCase() !== 'development' &&
		!LOOPBACK_HOSTS.has(host)
	) {
		throw new Error(
			'CRM_CUSTOMERS_LISTEN_HOST must be loopback in production'
		);
	}
	return host;
}
