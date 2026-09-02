import { parseCrmSalesCorsAllowedOrigins } from './crm-sales-cors.config';

describe('parseCrmSalesCorsAllowedOrigins', () => {
	it('normalizes and deduplicates exact origins', () => {
		expect(
			parseCrmSalesCorsAllowedOrigins(
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
		expect(() => parseCrmSalesCorsAllowedOrigins(value)).toThrow(
			'exact http/https origins'
		);
	});
});
