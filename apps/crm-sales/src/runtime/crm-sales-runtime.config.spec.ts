import {
	parseCrmSalesListenHost,
	parseCrmSalesPort
} from './crm-sales-runtime.config';

describe('CRM Sales runtime config', () => {
	it('uses safe defaults', () => {
		expect(parseCrmSalesPort()).toBe(5330);
		expect(parseCrmSalesListenHost()).toBe('127.0.0.1');
	});

	it.each(['0', '5331', '65536', '1.5', 'invalid'])(
		'rejects invalid port %s',
		value => {
			expect(() => parseCrmSalesPort(value)).toThrow(
				'CRM_SALES_PORT must be the canonical port 5330'
			);
		}
	);

	it('allows only loopback listeners in production', () => {
		expect(parseCrmSalesListenHost('127.0.0.1', 'production')).toBe(
			'127.0.0.1'
		);
		expect(() => parseCrmSalesListenHost('0.0.0.0', 'production')).toThrow(
			'must not be a wildcard'
		);
	});

	it('allows an explicit development listener', () => {
		expect(parseCrmSalesListenHost('10.0.0.4', 'development')).toBe(
			'10.0.0.4'
		);
	});

	it('fails closed for a non-loopback listener without explicit development mode', () => {
		expect(() =>
			parseCrmSalesListenHost('0.0.0.0', 'development')
		).toThrow('must not be a wildcard');
		expect(() => parseCrmSalesListenHost('10.0.0.4')).toThrow(
			'must be loopback'
		);
		expect(() => parseCrmSalesListenHost('10.0.0.4', 'staging')).toThrow(
			'must be loopback'
		);
	});
});
