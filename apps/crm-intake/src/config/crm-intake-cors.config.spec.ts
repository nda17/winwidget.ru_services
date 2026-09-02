import { parseCrmIntakeCorsAllowedOrigins } from './crm-intake-cors.config';

describe('parseCrmIntakeCorsAllowedOrigins', () => {
	it('normalizes and deduplicates exact origins', () => {
		expect(
			parseCrmIntakeCorsAllowedOrigins(
				'https://crm.winwidget.ru, http://localhost:3001,https://crm.winwidget.ru'
			)
		).toEqual(['https://crm.winwidget.ru', 'http://localhost:3001']);
	});

	it.each([
		undefined,
		'',
		'*',
		'https://crm.winwidget.ru/path',
		'https://user:pass@crm.winwidget.ru',
		'ftp://crm.winwidget.ru'
	])('rejects a non-exact origin: %s', value => {
		expect(() => parseCrmIntakeCorsAllowedOrigins(value)).toThrow(
			'exact http/https origins'
		);
	});
});
