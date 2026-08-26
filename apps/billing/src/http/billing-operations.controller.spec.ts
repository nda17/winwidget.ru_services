import 'reflect-metadata';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
	GUARDS_METADATA,
	HTTP_CODE_METADATA,
	METHOD_METADATA,
	PATH_METADATA
} from '@nestjs/common/constants';
import { BillingOperationsGuard } from '../auth/billing-operations.guard';
import { BillingOperationsController } from './billing-operations.controller';

describe('BillingOperationsController', () => {
	it('exposes the guarded Billing-owned alerts endpoint', () => {
		const handler = BillingOperationsController.prototype.getAdminAlerts;
		expect(
			Reflect.getMetadata(PATH_METADATA, BillingOperationsController)
		).toBe('internal/v1/operations/billing');
		expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
			'admin-alerts'
		);
		expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
			RequestMethod.GET
		);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(
			HttpStatus.OK
		);
		expect(
			Reflect.getMetadata(GUARDS_METADATA, BillingOperationsController)
		).toEqual([BillingOperationsGuard]);
	});

	it('delegates alerts to Billing storage', async () => {
		const alerts = {
			getAlerts: jest.fn().mockResolvedValue({ items: [] })
		};
		const controller = new BillingOperationsController(
			{} as never,
			alerts as never
		);

		await expect(controller.getAdminAlerts()).resolves.toEqual({
			items: []
		});
		expect(alerts.getAlerts).toHaveBeenCalledTimes(1);
	});
});
