const PORT_ERROR = 'CRM_SALES_PORT must be the canonical port 5330';
const LISTEN_HOST_ERROR = 'CRM_SALES_LISTEN_HOST is invalid';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseCrmSalesPort(value?: string): number {
	if (value === undefined) return 5330;
	const port = Number(value);
	if (!Number.isInteger(port) || port !== 5330) {
		throw new Error(PORT_ERROR);
	}
	return port;
}

export function parseCrmSalesListenHost(
	value?: string,
	mode?: string
): string {
	const host = value?.trim() || '127.0.0.1';
	if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
		throw new Error(LISTEN_HOST_ERROR);
	}
	if (['0.0.0.0', '::'].includes(host)) {
		throw new Error(
			'CRM_SALES_LISTEN_HOST must not be a wildcard address'
		);
	}
	if (
		mode?.trim().toLowerCase() !== 'development' &&
		!LOOPBACK_HOSTS.has(host)
	) {
		throw new Error(
			'CRM_SALES_LISTEN_HOST must be loopback in production'
		);
	}
	return host;
}
