import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchWidgetOwnersDto } from './widgets-owner-directory.dto';

describe('SearchWidgetOwnersDto', () => {
	it('accepts a bounded keyset request', async () => {
		const dto = plainToInstance(SearchWidgetOwnersDto, {
			search: 'owner',
			plan: 'NONE',
			afterId: 'user-10',
			limit: '100'
		});

		await expect(validate(dto)).resolves.toHaveLength(0);
		expect(dto.limit).toBe(100);
	});

	it.each([
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ limit: 10, plan: 'ENTERPRISE' },
		{ limit: 10, search: 'x'.repeat(201) },
		{ limit: 10, afterId: '' }
	])('rejects an invalid search request %#', async value => {
		const dto = plainToInstance(SearchWidgetOwnersDto, value);
		expect(await validate(dto)).not.toHaveLength(0);
	});
});
