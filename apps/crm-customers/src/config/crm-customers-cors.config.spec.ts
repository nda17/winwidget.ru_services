import { parseCrmCustomersCorsAllowedOrigins } from './crm-customers-cors.config';

describe('parseCrmCustomersCorsAllowedOrigins', () => {
	it('normalizes and deduplicates exact origins', () => {
		expect(
			parseCrmCustomersCorsAllowedOrigins(
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
		expect(() => parseCrmCustomersCorsAllowedOrigins(value)).toThrow(
			'exact http/https origins'
		);
	});
});
