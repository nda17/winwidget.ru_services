import { MailingController } from '@/mailing/mailing.controller';
import type { MailingService } from '@/mailing/mailing.service';
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

describe('MailingController', () => {
	const dto = {
		subject: 'Новости',
		message: 'Подробный текст рассылки',
		audience: 'ALL' as const,
		channel: 'EMAIL' as const
	};
	const request = {} as Request;

	it('requires a UUID Idempotency-Key for a new campaign', async () => {
		const mailingService = {
			createAdminBroadcast: jest.fn()
		} as unknown as MailingService;
		const controller = new MailingController(mailingService);

		await expect(
			controller.sendAdminBroadcast(dto, 'admin-1', undefined, request)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.sendAdminBroadcast(dto, 'admin-1', 'invalid', request)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(mailingService.createAdminBroadcast).not.toHaveBeenCalled();
	});

	it('passes the validated key and request to the transactional service', async () => {
		const idempotencyKey = '11111111-1111-4111-8111-111111111111';
		const mailingService = {
			createAdminBroadcast: jest
				.fn()
				.mockResolvedValue({ id: 'campaign-1' })
		} as unknown as MailingService;
		const controller = new MailingController(mailingService);

		await controller.sendAdminBroadcast(
			dto,
			'admin-1',
			idempotencyKey,
			request
		);

		expect(mailingService.createAdminBroadcast).toHaveBeenCalledWith(
			'admin-1',
			dto,
			idempotencyKey,
			request
		);
	});
});
