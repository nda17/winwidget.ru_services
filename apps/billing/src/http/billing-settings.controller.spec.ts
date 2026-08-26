import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import {
	GUARDS_METADATA,
	METHOD_METADATA,
	PATH_METADATA,
	PIPES_METADATA
} from '@nestjs/common/constants';
import {
	BILLING_REQUIRED_ROLES,
	BillingAuthGuard
} from '../auth/billing-auth.guard';
import { BillingSettingsPatchDto } from './billing.dto';
import { BillingSettingsController } from './billing-settings.controller';

describe('BillingSettingsController contract', () => {
	it.each([
		{
			handler: 'publicSettings',
			method: RequestMethod.GET,
			path: 'public',
			roles: undefined
		},
		{
			handler: 'adminSettings',
			method: RequestMethod.GET,
			path: 'admin',
			roles: ['ADMIN', 'DEV']
		},
		{
			handler: 'updateAdminSettings',
			method: RequestMethod.PATCH,
			path: 'admin',
			roles: ['ADMIN', 'DEV']
		}
	])('$method billing-settings/$path', contract => {
		const handler = Reflect.get(
			BillingSettingsController.prototype,
			contract.handler
		) as (...args: unknown[]) => unknown;
		expect(
			Reflect.getMetadata(PATH_METADATA, BillingSettingsController)
		).toBe('billing-settings');
		expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
			contract.path
		);
		expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
			contract.method
		);
		expect(Reflect.getMetadata(BILLING_REQUIRED_ROLES, handler)).toEqual(
			contract.roles
		);
		const guards = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
		if (contract.roles) expect(guards).toEqual([BillingAuthGuard]);
		else expect(guards).toEqual([]);
	});

	it('pins an exact partial five-field PATCH DTO', async () => {
		const handler = BillingSettingsController.prototype
			.updateAdminSettings as (...args: unknown[]) => unknown;
		const parameterTypes = Reflect.getMetadata(
			'design:paramtypes',
			BillingSettingsController.prototype,
			'updateAdminSettings'
		) as unknown[];
		expect(parameterTypes[0]).toBe(BillingSettingsPatchDto);
		const pipes = Reflect.getMetadata(
			PIPES_METADATA,
			handler
		) as ValidationPipe[];
		expect(pipes).toHaveLength(1);
		const state = pipes[0] as unknown as {
			validatorOptions: {
				whitelist?: boolean;
				forbidNonWhitelisted?: boolean;
			};
		};
		expect(state.validatorOptions).toMatchObject({
			whitelist: true,
			forbidNonWhitelisted: true
		});
		await expect(
			pipes[0].transform(
				{ paymentEnabled: true, unknown: true },
				{ type: 'body', metatype: BillingSettingsPatchDto }
			)
		).rejects.toBeDefined();
	});
});
