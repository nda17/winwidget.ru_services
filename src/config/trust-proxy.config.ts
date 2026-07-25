const UNSAFE_TRUST_PROXY_VALUES = new Set([
	'*',
	'true',
	'0.0.0.0/0',
	'::/0'
]);
const TRUST_PROXY_VALUE_PATTERN = /^[A-Za-z0-9.:/_-]{1,128}$/;

export function getTrustProxyConfig(
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
