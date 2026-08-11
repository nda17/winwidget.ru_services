import { SiteSettingsService } from './site-settings.service';
import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import type { BillingSettingsCompositionService } from '@/billing-boundary/billing-settings-composition.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '@/payment/payment.constants';
import type { PrismaService } from '@/prisma.service';
import { BillingCoreOwnership } from '@prisma/client';
import type { Request } from 'express';

describe('SiteSettingsService Billing composition', () => {
	const coreSettings = (
		updatedAt = new Date('2026-08-11T00:02:00.000Z')
	) => ({
		id: 'singleton',
		bannerEnabled: false,
		bannerText: '',
		snowflakeEnabled: false,
		paymentEnabled: true,
		autoRenewalSignupEnabled: false,
		autoRenewalChargesEnabled: false,
		autoRenewalChargesEnabledAt: new Date('2026-08-11T00:00:00.000Z'),
		recaptchaEnabled: true,
		googleAuthEnabled: true,
		yandexAuthEnabled: true,
		githubAuthEnabled: true,
		vkAuthEnabled: false,
		telegramAuthEnabled: true,
		affiliateProgramEnabled: false,
		affiliateCashbackPercent: 10,
		updatedAt
	});
	const billingSettings = (
		updatedAt: Date | string = '2026-08-11T00:01:00.000Z'
	) => ({
		id: 'singleton',
		paymentEnabled: false,
		autoRenewalSignupEnabled: true,
		autoRenewalChargesEnabled: true,
		autoRenewalChargesEnabledAt: new Date('2026-08-11T00:01:00.000Z'),
		affiliateProgramEnabled: true,
		affiliateCashbackPercent: 15,
		updatedAt
	});

	it('reads only the Billing projection and preserves max singleton updatedAt', async () => {
		const core = coreSettings();
		const billing = billingSettings();
		const prisma = {
			siteSettings: { findUnique: jest.fn().mockResolvedValue(core) },
			billingSettingsReadProjection: {
				findUnique: jest.fn().mockResolvedValue(billing)
			}
		} as unknown as PrismaService;
		const composition = {
			repairPending: jest.fn().mockResolvedValue(undefined)
		} as unknown as BillingSettingsCompositionService;
		const service = new SiteSettingsService(
			prisma,
			{} as AdminEventLogService,
			{
				get: jest.fn().mockResolvedValue({
					ownership: BillingCoreOwnership.BILLING,
					sourceProducersEnabled: false
				})
			} as unknown as BillingCoreStateService,
			composition
		);

		await expect(service.get()).resolves.toEqual(
			expect.objectContaining({
				bannerEnabled: false,
				paymentEnabled: false,
				affiliateProgramEnabled: true,
				updatedAt: core.updatedAt,
				autoRenewalTerms: {
					version: AUTO_RENEWAL_CONSENT_VERSION,
					text: AUTO_RENEWAL_CONSENT_TEXT
				}
			})
		);
		expect(composition.repairPending).toHaveBeenCalledTimes(1);
	});

	it('fails closed without a Billing settings projection', async () => {
		const service = new SiteSettingsService(
			{
				siteSettings: {
					findUnique: jest.fn().mockResolvedValue(coreSettings())
				},
				billingSettingsReadProjection: {
					findUnique: jest.fn().mockResolvedValue(null)
				}
			} as unknown as PrismaService,
			{} as AdminEventLogService,
			{
				get: jest.fn().mockResolvedValue({
					ownership: BillingCoreOwnership.BILLING,
					sourceProducersEnabled: false
				})
			} as unknown as BillingCoreStateService,
			{
				repairPending: jest.fn().mockResolvedValue(undefined)
			} as unknown as BillingSettingsCompositionService
		);

		await expect(service.get()).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'billing_settings_projection_unavailable'
			})
		});
	});

	it('updates only Core-owned fields during the frozen window', async () => {
		const updated = { ...coreSettings(), bannerEnabled: true };
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'singleton' }]),
			siteSettings: {
				update: jest.fn().mockResolvedValue(updated),
				findUniqueOrThrow: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;
		const composition = {
			execute: jest.fn()
		} as unknown as BillingSettingsCompositionService;
		const service = new SiteSettingsService(
			prisma,
			adminEventLog,
			{
				get: jest.fn().mockResolvedValue({
					ownership: BillingCoreOwnership.CORE,
					sourceProducersEnabled: false
				})
			} as unknown as BillingCoreStateService,
			composition
		);

		await service.update(
			{ bannerEnabled: true },
			{ adminId: 'admin-1', request: {} as Request }
		);

		expect(transaction.siteSettings.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: { bannerEnabled: true }
		});
		expect(composition.execute).not.toHaveBeenCalled();
	});

	it('fails closed for Billing-owned fields during the frozen window', async () => {
		const composition = {
			execute: jest.fn()
		} as unknown as BillingSettingsCompositionService;
		const service = new SiteSettingsService(
			{} as PrismaService,
			{} as AdminEventLogService,
			{
				get: jest.fn().mockResolvedValue({
					ownership: BillingCoreOwnership.CORE,
					sourceProducersEnabled: false
				})
			} as unknown as BillingCoreStateService,
			composition
		);

		await expect(
			service.update(
				{ paymentEnabled: false },
				{ adminId: 'admin-1', request: {} as Request }
			)
		).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'billing_migration_in_progress'
			})
		});
		expect(composition.execute).not.toHaveBeenCalled();
	});
});
