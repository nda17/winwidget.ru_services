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
import {
	BillingSettingsPatchDto,
	UpdateCrmCommercialPolicyDto
} from './billing.dto';
import { BillingSettingsController } from './billing-settings.controller';

describe('BillingSettingsController contract', () => {
	const crmCommand = {
		schemaVersion: 1,
		commandId: '22222222-2222-4222-8222-222222222222',
		expectedVersion: 1,
		monthlyPriceMinor: 99000,
		yearlyPriceMinor: 990000,
		additionalSeatMonthlyPriceMinor: 29000,
		additionalSeatYearlyPriceMinor: 290000,
		includedSeats: 2,
		trialSeatLimit: 5
	};

	it.each([
		{ includedSeats: 1 },
		{ includedSeats: 2.5 },
		{ includedSeats: 10001 },
		{ trialSeatLimit: 1 },
		{ trialSeatLimit: 10001 },
		{ monthlyPriceMinor: 0 },
		{ yearlyPriceMinor: 100000001 },
		{ additionalSeatMonthlyPriceMinor: 1.5 },
		{ additionalSeatYearlyPriceMinor: '100' },
		{ expectedVersion: 0 },
		{ commandId: 'invalid' },
		{ schemaVersion: 2 },
		{ trialDays: 7 },
		{ graceDays: 10 },
		{ currency: 'USD' }
	])('rejects invalid or immutable CRM policy fields %j', async patch => {
		const pipes = Reflect.getMetadata(
			PIPES_METADATA,
			BillingSettingsController.prototype.updateCrmSettings
		) as ValidationPipe[];
		await expect(
			pipes[0].transform(
				{ ...crmCommand, ...patch },
				{ type: 'body', metatype: UpdateCrmCommercialPolicyDto }
			)
		).rejects.toBeDefined();
	});

	it('accepts the two-seat minimum and rejects a mismatched idempotency header before service work', async () => {
		const pipes = Reflect.getMetadata(
			PIPES_METADATA,
			BillingSettingsController.prototype.updateCrmSettings
		) as ValidationPipe[];
		const validated = await pipes[0].transform(crmCommand, {
			type: 'body',
			metatype: UpdateCrmCommercialPolicyDto
		});
		const policy = { update: jest.fn() };
		const controller = new BillingSettingsController(
			{} as never,
			policy as never
		);
		expect(() =>
			controller.updateCrmSettings(
				validated,
				{} as never,
				{} as never,
				'other'
			)
		).toThrow('idempotency-key must match commandId');
		expect(policy.update).not.toHaveBeenCalled();
	});

	it.each([
		{
			handler: 'crmSettings',
			method: RequestMethod.GET,
			path: 'admin/crm',
			roles: ['ADMIN', 'DEV']
		},
		{
			handler: 'updateCrmSettings',
			method: RequestMethod.PUT,
			path: 'admin/crm',
			roles: ['DEV']
		},
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
			handler: 'providerReadiness',
			method: RequestMethod.GET,
			path: 'admin/provider-readiness',
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
