import {
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken
} from './internal-http.config';

describe('CRM Access internal HTTP configuration', () => {
	it.each([
		'http://identity:4900',
		'http://10.0.0.2:4900',
		'https://127.0.0.1:4900',
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
