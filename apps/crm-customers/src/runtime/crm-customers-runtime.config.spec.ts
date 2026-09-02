import {
	parseCrmCustomersListenHost,
	parseCrmCustomersPort
} from './crm-customers-runtime.config';

describe('CRM Customers runtime config', () => {
	it('uses safe defaults', () => {
		expect(parseCrmCustomersPort()).toBe(5320);
		expect(parseCrmCustomersListenHost()).toBe('127.0.0.1');
	});

	it.each(['0', '5321', '65536', '1.5', 'invalid'])(
		'rejects invalid port %s',
		value => {
			expect(() => parseCrmCustomersPort(value)).toThrow(
				'CRM_CUSTOMERS_PORT must be the canonical port 5320'
			);
		}
	);

	it('allows only loopback listeners in production', () => {
		expect(parseCrmCustomersListenHost('localhost', 'production')).toBe(
			'localhost'
		);
		expect(() =>
			parseCrmCustomersListenHost('0.0.0.0', 'production')
		).toThrow('must not be a wildcard');
	});

	it('allows an explicit development listener', () => {
		expect(parseCrmCustomersListenHost('10.0.0.4', 'development')).toBe(
			'10.0.0.4'
		);
	});

	it('fails closed for a non-loopback listener without explicit development mode', () => {
		expect(() =>
			parseCrmCustomersListenHost('0.0.0.0', 'development')
		).toThrow('must not be a wildcard');
		expect(() => parseCrmCustomersListenHost('10.0.0.4')).toThrow(
			'must be loopback'
		);
		expect(() =>
			parseCrmCustomersListenHost('10.0.0.4', 'staging')
		).toThrow('must be loopback');
	});
});
