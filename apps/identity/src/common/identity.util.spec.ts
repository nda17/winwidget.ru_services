import { normalizeEmail, normalizePhone } from './identity.util';

describe('Identity canonical normalization', () => {
	it.each([
		['8 (999) 123-45-67', '+79991234567'],
		['7 999 123 45 67', '+79991234567'],
		['9991234567', '+79991234567'],
		['+7 (999) 123-45-67', '+79991234567'],
		[' +44 (20) 1234-5678 ', '+442012345678'],
		['legacy-extension', 'legacy-extension']
	])(
		'normalizes phone %s with the canonical Identity semantics',
		(input, expected) => {
			expect(normalizePhone(input)).toBe(expected);
		}
	);

	it('normalizes email for all unique lookups and cutover collisions', () => {
		expect(normalizeEmail(' USER@Example.COM ')).toBe('user@example.com');
	});
});
