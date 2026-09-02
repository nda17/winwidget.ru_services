import { parseCrmCustomersDatabaseUrl } from './crm-customers-prisma.service';

describe('parseCrmCustomersDatabaseUrl', () => {
	it.each([
		undefined,
		'',
		'change_me',
		'postgresql://user:change_me@localhost:5432/db',
		'https://localhost/database',
		'postgresql://localhost/'
	])('fails closed for invalid configuration: %s', value => {
		expect(() => parseCrmCustomersDatabaseUrl(value)).toThrow(
			'CRM_CUSTOMERS_DATABASE_URL'
		);
	});

	it('accepts a concrete PostgreSQL URL', () => {
		const value =
			'postgresql://runtime:secret@127.0.0.1:5432/crm_customers';
		expect(parseCrmCustomersDatabaseUrl(value)).toBe(value);
	});
});
