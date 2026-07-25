import { getTrustProxyConfig } from '@/config/trust-proxy.config';

describe('getTrustProxyConfig', () => {
	it('trusts only loopback by default', () => {
		expect(getTrustProxyConfig(undefined)).toBe('loopback');
	});

	it('supports an explicit gateway chain', () => {
		expect(getTrustProxyConfig('loopback, 10.20.0.0/16')).toEqual([
			'loopback',
			'10.20.0.0/16'
		]);
	});

	it.each(['true', '*', '0.0.0.0/0', '::/0'])(
		'rejects broad trust value %s',
		value => {
			expect(() => getTrustProxyConfig(value)).toThrow('TRUST_PROXY');
		}
	);
});
