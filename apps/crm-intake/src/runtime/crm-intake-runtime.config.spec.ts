import {
	parseCrmIntakeListenHost,
	parseCrmIntakePort
} from './crm-intake-runtime.config';

describe('CRM Intake runtime config', () => {
	it('uses safe defaults', () => {
		expect(parseCrmIntakePort()).toBe(5310);
		expect(parseCrmIntakeListenHost()).toBe('127.0.0.1');
	});

	it.each(['0', '5311', '65536', '1.5', 'invalid'])(
		'rejects invalid port %s',
		value => {
			expect(() => parseCrmIntakePort(value)).toThrow(
				'CRM_INTAKE_PORT must be the canonical port 5310'
			);
		}
	);

	it('allows only loopback listeners in production', () => {
		expect(parseCrmIntakeListenHost('::1', 'production')).toBe('::1');
		expect(() =>
			parseCrmIntakeListenHost('0.0.0.0', 'production')
		).toThrow('must not be a wildcard');
	});

	it('allows an explicit development listener', () => {
		expect(parseCrmIntakeListenHost('10.0.0.4', 'development')).toBe(
			'10.0.0.4'
		);
	});

	it('fails closed for a non-loopback listener without explicit development mode', () => {
		expect(() =>
			parseCrmIntakeListenHost('0.0.0.0', 'development')
		).toThrow('must not be a wildcard');
		expect(() => parseCrmIntakeListenHost('10.0.0.4')).toThrow(
			'must be loopback'
		);
		expect(() => parseCrmIntakeListenHost('10.0.0.4', 'staging')).toThrow(
			'must be loopback'
		);
	});
});
