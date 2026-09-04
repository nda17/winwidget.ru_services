import {
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken
} from './internal-http.config';

describe('CRM Access internal HTTP configuration', () => {
	it.each([
		'http://identity:4900',
		'http://10.0.0.2:4900',
		'ftp://127.0.0.1:4900',
		'https://identity.internal.example/api',
		'https://identity.internal.example?target=crm',
		'https://identity.internal.example#crm',
		'https://user:pass@identity.internal.example',
		'http://127.0.0.1:4900/base',
		'http://user:pass@127.0.0.1:4900'
	])('rejects non-loopback or non-origin URL %s', value => {
		expect(() =>
			parseInternalBaseUrl(
				'IDENTITY_INTERNAL_BASE_URL',
				value,
				'http://127.0.0.1:4900'
			)
		).toThrow('IDENTITY_INTERNAL_BASE_URL');
	});

	it('accepts an explicit HTTPS origin for a separate platform VPS', () => {
		expect(
			parseInternalBaseUrl(
				'IDENTITY_INTERNAL_BASE_URL',
				'https://identity.internal.example/',
				'http://127.0.0.1:4900',
				'production'
			)
		).toBe('https://identity.internal.example');
	});

	it('never falls back to localhost on a production CRM VPS', () => {
		expect(() =>
			parseInternalBaseUrl(
				'IDENTITY_INTERNAL_BASE_URL',
				undefined,
				'http://127.0.0.1:4900',
				'production'
			)
		).toThrow('explicitly configured');
		expect(() =>
			parseInternalBaseUrl(
				'BILLING_INTERNAL_BASE_URL',
				'  ',
				'http://127.0.0.1:4800',
				'production'
			)
		).toThrow('explicitly configured');
	});

	it('normalizes an exact loopback origin', () => {
		expect(
			parseInternalBaseUrl(
				'IDENTITY_INTERNAL_BASE_URL',
				'http://127.0.0.1:4900/',
				'http://127.0.0.1:4900'
			)
		).toBe('http://127.0.0.1:4900');
	});

	it('rejects placeholder tokens and invalid timeouts', () => {
		expect(() =>
			parseInternalToken(
				'IDENTITY_CRM_ACCESS_TOKEN',
				'ci_identity_crm_access_token_at_least_32_chars',
				[]
			)
		).toThrow('IDENTITY_CRM_ACCESS_TOKEN');
		expect(() =>
			parseInternalTimeout('IDENTITY_INTERNAL_TIMEOUT_MS', '499')
		).toThrow('IDENTITY_INTERNAL_TIMEOUT_MS');
		expect(
			parseInternalTimeout('IDENTITY_INTERNAL_TIMEOUT_MS', '10000')
		).toBe(10_000);
	});
});
