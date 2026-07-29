import { WidgetApiController } from '@/widget/widget-api.controller';
import type { WidgetService } from '@/widget/widget.service';
import type { Request, Response } from 'express';

describe('WidgetApiController', () => {
	it('passes the wheel page URL to lead creation', async () => {
		const widgetService = {
			submitLeadByKey: jest.fn().mockResolvedValue({ success: true })
		} as unknown as WidgetService;
		const controller = new WidgetApiController(widgetService);
		const request = {
			ip: '203.0.113.10',
			headers: {
				origin: 'https://shop.example.com'
			}
		} as Request;
		const response = {
			setHeader: jest.fn()
		} as unknown as Response;

		await controller.submitLead(
			'wheel-public-key',
			{
				phone: '+79990000000',
				email: 'visitor@example.com',
				name: 'Анна',
				bonus: 'Скидку 10%',
				url: 'https://shop.example.com/catalog?utm_source=widget'
			},
			request,
			response
		);

		expect(widgetService.submitLeadByKey).toHaveBeenCalledWith(
			'wheel-public-key',
			'+79990000000',
			'visitor@example.com',
			'Анна',
			'Скидку 10%',
			'203.0.113.10',
			'example.com',
			false,
			'https://shop.example.com/catalog?utm_source=widget'
		);
	});
});
