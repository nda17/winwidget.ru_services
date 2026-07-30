import { parseCampaignsCorsAllowedOrigins } from './campaigns-cors.config';

describe('campaigns CORS configuration', () => {
	it('normalizes, trims and deduplicates exact origins', () => {
		expect(
			parseCampaignsCorsAllowedOrigins(
				' https://winwidget.ru/,http://localhost:3000,https://winwidget.ru '
			)
		).toEqual(['https://winwidget.ru', 'http://localhost:3000']);
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
		expect(() => parseCampaignsCorsAllowedOrigins(value)).toThrow(
			'CORS_ALLOWED_ORIGINS must contain exact http/https origins'
		);
	});
});
