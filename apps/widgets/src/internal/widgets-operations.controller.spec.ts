import 'reflect-metadata';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
	GUARDS_METADATA,
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PATH_METADATA
} from '@nestjs/common/constants';
import { WidgetsOperationsController } from './widgets-operations.controller';
import { WidgetsOperationsGuard } from './widgets-operations.guard';

describe('WidgetsOperationsController', () => {
	it('exposes a guarded Operations-only admin alerts endpoint', () => {
		const handler = WidgetsOperationsController.prototype.adminAlerts;
		expect(
			Reflect.getMetadata(PATH_METADATA, WidgetsOperationsController)
		).toBe('internal/v1/operations/widgets');
		expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
			'admin-alerts'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
			RequestMethod.POST
		);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
			HttpStatus.OK
		);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, WidgetsOperationsController)
		).toEqual([WidgetsOperationsGuard]);
	});

	it('delegates alerts to Widgets storage', async () => {
		const monitoring = {
			adminAlerts: jest.fn().mockResolvedValue({ items: [] })
		};
		const controller = new WidgetsOperationsController(
			monitoring as never,
			{} as never,
			{} as never
		);

		await expect(controller.adminAlerts()).resolves.toEqual({ items: [] });
		expect(monitoring.adminAlerts).toHaveBeenCalledTimes(1);
	});
});
