import 'reflect-metadata';
import {
	INestApplication,
	RequestMethod,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { BillingSettingsService } from '../domain/billing-settings.service';
import { CrmCommercialPolicyService } from '../domain/crm-commercial-policy.service';
import { IdentityInternalClient } from '../internal/identity-internal.client';

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
			handler: 'crmPricing',
			method: RequestMethod.GET,
			path: 'crm',
			roles: []
		},
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

	it('reads the same customer price policy without changing Billing or administrator rights', async () => {
		const result = { schemaVersion: 1, version: 7, includedSeats: 2 };
		const policy = {
			get: jest.fn().mockResolvedValue(result),
			update: jest.fn()
		};
		const settings = {
			publicSettings: jest.fn(),
			updateAdminSettings: jest.fn()
		};
		const controller = new BillingSettingsController(
			settings as never,
			policy as never
		);
		await expect(controller.crmPricing()).resolves.toBe(result);
		expect(policy.get).toHaveBeenCalledTimes(1);
		expect(policy.get).toHaveBeenCalledWith();
		expect(policy.update).not.toHaveBeenCalled();
		expect(settings.publicSettings).not.toHaveBeenCalled();
		expect(settings.updateAdminSettings).not.toHaveBeenCalled();
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

describe('WinCRM customer pricing HTTP boundary', () => {
	let app: INestApplication;
	let base: string;
	const policy = {
		version: 7,
		monthlyPriceMinor: 99000,
		yearlyPriceMinor: 990000,
		additionalSeatMonthlyPriceMinor: 29000,
		additionalSeatYearlyPriceMinor: 290000,
		includedSeats: 2,
		trialSeatLimit: 5,
		trialDays: 5,
		graceDays: 3,
		createdByUserId: 'synthetic-dev-subject',
		createdAt: new Date('2026-09-05T00:00:00.000Z')
	};
	const prisma = { crmCommercialPolicy: { findFirst: jest.fn() } };
	const identity = {
		introspect: jest.fn(async (bearer: string) => {
			if (bearer !== 'Bearer synthetic-user-token')
				throw new UnauthorizedException();
			return { subject: 'synthetic-user-subject', roles: ['USER'] };
		})
	};
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [BillingSettingsController],
			providers: [
				BillingAuthGuard,
				{ provide: IdentityInternalClient, useValue: identity },
				{ provide: BillingSettingsService, useValue: {} },
				{
					provide: CrmCommercialPolicyService,
					useValue: new CrmCommercialPolicyService(prisma as never)
				}
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		app.setGlobalPrefix('api/v1');
		await app.listen(0, '127.0.0.1');
		base = await app.getUrl();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		prisma.crmCommercialPolicy.findFirst.mockResolvedValue(policy);
	});
	afterAll(async () => {
		await app?.close();
	});

	it('requires a current Identity session before reading prices, ignoring forged user headers', async () => {
		const cases: Record<string, string>[] = [
			{},
			{ 'x-user-id': 'synthetic-owner', 'x-user-role': 'DEV' },
			{ authorization: 'Bearer rejected-token' }
		];
		for (const headers of cases) {
			const response = await fetch(`${base}/api/v1/billing-settings/crm`, {
				headers
			});
			expect(response.status).toBe(401);
			await response.body?.cancel();
		}
		expect(prisma.crmCommercialPolicy.findFirst).not.toHaveBeenCalled();
	});

	it('returns one latest immutable policy without actor data or any write delegate', async () => {
		const response = await fetch(`${base}/api/v1/billing-settings/crm`, {
			headers: { authorization: 'Bearer synthetic-user-token' }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.json();
		expect(Object.keys(body).sort()).toEqual(
			[
				'schemaVersion',
				'productCode',
				'version',
				'currency',
				'monthlyPriceMinor',
				'yearlyPriceMinor',
				'additionalSeatMonthlyPriceMinor',
				'additionalSeatYearlyPriceMinor',
				'includedSeats',
				'trialSeatLimit',
				'trialDays',
				'graceDays',
				'createdAt'
			].sort()
		);
		expect(body).toMatchObject({
			schemaVersion: 1,
			productCode: 'WINCRM',
			currency: 'RUB',
			version: 7,
			includedSeats: 2,
			trialDays: 5,
			graceDays: 3
		});
		expect(prisma.crmCommercialPolicy.findFirst).toHaveBeenCalledTimes(1);
		expect(prisma.crmCommercialPolicy.findFirst).toHaveBeenCalledWith({
			orderBy: { version: 'desc' }
		});
	});

	it('does not grant a customer read or write access to the administrative endpoints', async () => {
		for (const method of ['GET', 'PUT']) {
			const response = await fetch(
				`${base}/api/v1/billing-settings/admin/crm`,
				{
					method,
					headers: { authorization: 'Bearer synthetic-user-token' }
				}
			);
			expect(response.status).toBe(403);
			await response.body?.cancel();
		}
		expect(prisma.crmCommercialPolicy.findFirst).not.toHaveBeenCalled();
	});

	it('does not invent fallback prices when the policy has not been configured', async () => {
		prisma.crmCommercialPolicy.findFirst.mockResolvedValue(null);
		const response = await fetch(`${base}/api/v1/billing-settings/crm`, {
			headers: { authorization: 'Bearer synthetic-user-token' }
		});
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe(
			'crm_commercial_policy_unavailable'
		);
	});
});
