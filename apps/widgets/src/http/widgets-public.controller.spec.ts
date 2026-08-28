import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CallbackOtpRateLimitException } from '../callback/widgets-callback-otp.service';
import type { WidgetsDomainService } from '../domain/widgets-domain.service';
import { WidgetType } from '../domain/widgets-domain.types';
import { WidgetsPublicController } from './widgets-public.controller';

describe('WidgetsPublicController callback verification', () => {
	it('exposes and returns Retry-After for a callback OTP rate limit', async () => {
		const error = new CallbackOtpRateLimitException(
			42,
			'Повторная отправка кода пока недоступна'
		);
		const widgets = {
			startCallbackVerification: jest.fn().mockRejectedValue(error)
		} as unknown as WidgetsDomainService;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;
		const request = {
			headers: {
				origin: 'https://example.test',
				'x-forwarded-for': '203.0.113.10'
			},
			ip: '203.0.113.10',
			socket: {}
		} as unknown as Request;
		const controller = new WidgetsPublicController(
			widgets,
			{} as ConfigService
		);

		await expect(
			controller.startCallbackVerification(
				'abcdef123456',
				{ phone: '+79991234567' },
				request,
				response
			)
		).rejects.toBe(error);
		expect(response.setHeader).toHaveBeenCalledWith(
			'Access-Control-Expose-Headers',
			'Retry-After'
		);
		expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
	});

	it.each([
		['OFF', { phone: '+79991234567', email: 'visitor@example.test' }],
		[
			'SMS',
			{
				phone: '+79991234567',
				email: 'visitor@example.test',
				challengeId: '11111111-1111-4111-8111-111111111111',
				code: '123456'
			}
		]
	] as const)(
		'propagates the strict %s callback email rejection without stripping the payload',
		async (_verificationMode, dto) => {
			const error = new BadRequestException(
				'Email разрешён только при подтверждении по email'
			);
			const submitLead = jest.fn().mockRejectedValue(error);
			const controller = new WidgetsPublicController(
				{ submitLead } as unknown as WidgetsDomainService,
				{} as ConfigService
			);
			const request = {
				headers: {
					origin: 'https://example.test',
					'x-forwarded-for': '203.0.113.10',
					'x-correlation-id': 'callback-email-contract'
				},
				ip: '203.0.113.10',
				socket: {},
				originalUrl: '/callback/abcdef123456/lead'
			} as unknown as Request;
			const response = {
				setHeader: jest.fn()
			} as unknown as Response;

			await expect(
				controller.submitCallback('abcdef123456', dto, request, response)
			).rejects.toBe(error);
			expect(submitLead).toHaveBeenCalledWith(
				WidgetType.CALLBACK,
				'abcdef123456',
				dto,
				'203.0.113.10',
				'example.test',
				false,
				'callback-email-contract'
			);
		}
	);
});
