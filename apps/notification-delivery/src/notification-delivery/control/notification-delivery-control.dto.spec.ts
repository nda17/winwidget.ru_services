import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
	CloseNotificationDeliveryFailureDto,
	NotificationDeliveryFailuresQueryDto
} from './notification-delivery-control.dto';

describe('Notification delivery control DTOs', () => {
	it('accepts the internal aggregation limit of 10000', async () => {
		const dto = plainToInstance(NotificationDeliveryFailuresQueryDto, {
			page: '2',
			limit: '10000',
			integration: 'payment-email',
			category: 'RATE_LIMIT',
			status: 'RETRYING'
		});

		expect(await validate(dto)).toEqual([]);
		expect(dto.page).toBe(2);
		expect(dto.limit).toBe(10_000);
	});

	it('rejects an oversized limit and a consumer outside this service', async () => {
		const dto = plainToInstance(NotificationDeliveryFailuresQueryDto, {
			limit: '10001',
			integration: 'payment-telegram'
		});

		const errors = await validate(dto);

		expect(errors.map(error => error.property)).toEqual(
			expect.arrayContaining(['limit', 'integration'])
		);
	});

	it('validates the actor and close comment', async () => {
		const dto = plainToInstance(CloseNotificationDeliveryFailureDto, {
			actorId: '',
			comment: 'no'
		});

		const errors = await validate(dto);

		expect(errors.map(error => error.property)).toEqual(
			expect.arrayContaining(['actorId', 'comment'])
		);
	});
});
