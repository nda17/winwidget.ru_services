import { validate } from 'class-validator';
import {
	CloseDeliveryFailureActionDto,
	DeliveryFailureActionDto
} from './widgets-internal.controller';

describe('Widgets internal delivery failure DTOs', () => {
	it('accepts the Core CUID actor identifier', async () => {
		const dto = new DeliveryFailureActionDto();
		dto.actorId = 'cm0abc1230000qwertyuiopas';

		await expect(validate(dto)).resolves.toEqual([]);
	});

	it.each(['', '   ', 'a'.repeat(256)])(
		'rejects an invalid actor identifier',
		async actorId => {
			const dto = new DeliveryFailureActionDto();
			dto.actorId = actorId;

			expect(await validate(dto)).not.toHaveLength(0);
		}
	);

	it('inherits actor validation for close actions', async () => {
		const dto = new CloseDeliveryFailureActionDto();
		dto.actorId = '   ';
		dto.comment = 'Проверено вручную';

		expect(await validate(dto)).not.toHaveLength(0);
	});
});
