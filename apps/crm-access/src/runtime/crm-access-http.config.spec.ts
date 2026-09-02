import {
	getCrmAccessCorsAllowedOrigins,
	getCrmAccessListenHost,
	getCrmAccessTrustProxyConfig
} from './crm-access-http.config';
import { parseCrmAccessPort } from './crm-access-runtime.service';

describe('CRM Access HTTP runtime configuration', () => {
	it('pins the canonical API port', () => {
		expect(parseCrmAccessPort(undefined)).toBe(5300);
		expect(parseCrmAccessPort('5300')).toBe(5300);
		expect(() => parseCrmAccessPort('5301')).toThrow('CRM_ACCESS_PORT');
	});

	it('requires a loopback production listener', () => {
		expect(getCrmAccessListenHost('production', undefined)).toBe(
			'127.0.0.1'
		);
		expect(() => getCrmAccessListenHost('production', '10.0.0.4')).toThrow(
			'CRM_ACCESS_LISTEN_HOST'
		);
		expect(() => getCrmAccessListenHost('development', '0.0.0.0')).toThrow(
			'CRM_ACCESS_LISTEN_HOST'
		);
	});

	it('accepts only exact production CORS origins', () => {
		expect(
			getCrmAccessCorsAllowedOrigins(
				'production',
				'https://crm.winwidget.ru,https://crm.winwidget.ru'
			)
		).toEqual(['https://crm.winwidget.ru']);
		expect(() =>
			getCrmAccessCorsAllowedOrigins('production', '*')
		).toThrow('CORS_ALLOWED_ORIGINS');
		expect(() =>
			getCrmAccessCorsAllowedOrigins(
				'production',
				'https://crm.winwidget.ru/path'
			)
		).toThrow('CORS_ALLOWED_ORIGINS');
	});

	it('rejects unsafe trust-proxy values', () => {
		expect(getCrmAccessTrustProxyConfig(undefined)).toBe('loopback');
		expect(() => getCrmAccessTrustProxyConfig('*')).toThrow('TRUST_PROXY');
	});
});
