import {
	getSupportCorsAllowedOrigins,
	getSupportListenHost,
	getSupportTrustProxyConfig
} from './support-http.config';
import {
	parseSupportPort,
	parseSupportProcessRole
} from './support-runtime.service';

describe('Support runtime boundaries', () => {
	it('uses distinct canonical ports for every process role', () => {
		expect(parseSupportPort('api', {})).toBe(5100);
		expect(parseSupportPort('worker', {})).toBe(5101);
		expect(parseSupportPort('outbox-publisher', {})).toBe(5102);
	});

	it('rejects unknown roles and a non-canonical API port', () => {
		expect(() => parseSupportProcessRole('scheduler')).toThrow();
		expect(() =>
			parseSupportPort('api', { SUPPORT_PORT: '5199' })
		).toThrow();
	});

	it('fails closed for wildcard production HTTP boundaries', () => {
		expect(() => getSupportListenHost('production', '0.0.0.0')).toThrow();
		expect(() => getSupportTrustProxyConfig('*')).toThrow();
		expect(() =>
			getSupportCorsAllowedOrigins('production', '*')
		).toThrow();
	});

	it('normalizes explicit production origins and proxy hops', () => {
		expect(
			getSupportCorsAllowedOrigins(
				'production',
				'https://winwidget.ru,https://admin.winwidget.ru'
			)
		).toEqual(['https://winwidget.ru', 'https://admin.winwidget.ru']);
		expect(getSupportTrustProxyConfig('loopback,127.0.0.1')).toEqual([
			'loopback',
			'127.0.0.1'
		]);
	});
});
