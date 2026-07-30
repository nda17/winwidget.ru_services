import {
	parseCampaignsListenHost,
	parseCampaignsPort
} from './campaigns-health.service';

describe('campaigns health configuration', () => {
	it('uses loopback-safe defaults', () => {
		expect(parseCampaignsListenHost()).toBe('127.0.0.1');
		expect(parseCampaignsPort()).toBe(4500);
	});

	it('accepts loopback and a valid custom port', () => {
		expect(parseCampaignsListenHost('127.0.0.1', 'production')).toBe(
			'127.0.0.1'
		);
		expect(parseCampaignsPort('4510')).toBe(4510);
	});

	it('allows a wildcard host outside production', () => {
		expect(parseCampaignsListenHost('0.0.0.0', 'development')).toBe(
			'0.0.0.0'
		);
	});

	it('rejects a wildcard host in production', () => {
		expect(() =>
			parseCampaignsListenHost('0.0.0.0', 'production')
		).toThrow('must be 127.0.0.1 in production');
	});

	it.each(['localhost', '::', 'example.org'])(
		'rejects unsupported listen host %s',
		host => {
			expect(() => parseCampaignsListenHost(host)).toThrow(
				'CAMPAIGNS_LISTEN_HOST'
			);
		}
	);

	it.each(['0', '65536', 'abc', '4.5'])(
		'rejects invalid port %s',
		port => {
			expect(() => parseCampaignsPort(port)).toThrow(
				'CAMPAIGNS_HEALTH_PORT'
			);
		}
	);
});
