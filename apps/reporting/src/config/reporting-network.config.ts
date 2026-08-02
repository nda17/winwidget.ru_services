export function parseReportingPort(value?: string): number {
	if (value === undefined) return 4600;
	if (!/^\d+$/.test(value.trim())) {
		throw new Error(
			'REPORTING_PORT must be an integer between 1 and 65535'
		);
	}
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(
			'REPORTING_PORT must be an integer between 1 and 65535'
		);
	}
	return port;
}

export function parseReportingListenHost(
	value?: string,
	nodeEnvironment?: string
): string {
	const host = value?.trim() || '127.0.0.1';
	if (host !== '0.0.0.0' && host !== '127.0.0.1') {
		throw new Error('REPORTING_LISTEN_HOST must be 0.0.0.0 or 127.0.0.1');
	}
	if (nodeEnvironment?.trim() === 'production' && host !== '127.0.0.1') {
		throw new Error(
			'REPORTING_LISTEN_HOST must be 127.0.0.1 in production'
		);
	}
	return host;
}
