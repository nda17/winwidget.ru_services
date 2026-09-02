import { parseCrmIntakeDatabaseUrl } from './crm-intake-prisma.service';

describe('parseCrmIntakeDatabaseUrl', () => {
	it.each([
		undefined,
		'',
		'change_me',
		'postgresql://user:change_me@localhost:5432/db',
		'https://localhost/database',
		'postgresql://localhost/'
	])('fails closed for invalid configuration: %s', value => {
		expect(() => parseCrmIntakeDatabaseUrl(value)).toThrow(
			'CRM_INTAKE_DATABASE_URL'
		);
	});

	it('accepts a concrete PostgreSQL URL', () => {
		const value = 'postgresql://runtime:secret@127.0.0.1:5432/crm_intake';
		expect(parseCrmIntakeDatabaseUrl(value)).toBe(value);
	});
});
