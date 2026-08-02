import {
	isReportingCorsOriginAllowed,
	parseReportingCorsAllowedOrigins
} from './reporting-cors.config';

describe('reporting CORS configuration', () => {
	it('normalizes and deduplicates exact origins', () => {
		const allowed = parseReportingCorsAllowedOrigins(
			' https://winwidget.ru/,http://localhost:3000,https://winwidget.ru '
		);
		expect(allowed).toEqual([
			'https://winwidget.ru',
			'http://localhost:3000'
		]);
		expect(
			isReportingCorsOriginAllowed('https://winwidget.ru', allowed)
		).toBe(true);
		expect(
			isReportingCorsOriginAllowed('https://evil.example', allowed)
		).toBe(false);
	});

	it.each([
		undefined,
		'',
		'*',
		'https://winwidget.ru/path',
		'https://user:password@winwidget.ru',
		'https://winwidget.ru?query=value',
		'https://winwidget.ru#fragment',
		'ftp://winwidget.ru',
		'https://winwidget.ru,'
	])('rejects an unsafe origin list: %s', value => {
		expect(() => parseReportingCorsAllowedOrigins(value)).toThrow(
			'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
		);
	});
});
