import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from '@/billing-boundary/billing-boundary.constants';
import type { BillingSettingsCompositionService } from '@/billing-boundary/billing-settings-composition.service';
import type { PrismaService } from '@/prisma.service';
import type { Request } from 'express';
import { SiteSettingsService } from './site-settings.service';

describe('SiteSettingsService Billing composition', () => {
	const coreSettings = (
		updatedAt = new Date('2026-08-11T00:02:00.000Z')
	) => ({
		id: 'singleton',
		bannerEnabled: false,
		bannerText: '',
		snowflakeEnabled: false,
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

	it('reads the Core singleton composed with the Billing projection', async () => {
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
				repairPending: jest.fn().mockResolvedValue(undefined)
			} as unknown as BillingSettingsCompositionService
		);

		await expect(service.get()).rejects.toMatchObject({
			response: expect.objectContaining({
				code: 'billing_settings_projection_unavailable'
			})
		});
	});

	it('delegates Billing-owned updates to the durable composition', async () => {
		const core = coreSettings();
		const billing = billingSettings();
		const composition = {
			execute: jest.fn().mockResolvedValue({
				coreSettings: core,
				billingSettings: billing
			})
		} as unknown as BillingSettingsCompositionService;
		const service = new SiteSettingsService(
			{} as PrismaService,
			{} as AdminEventLogService,
			composition
		);
		const request = {} as Request;

		await expect(
			service.update(
				{ bannerEnabled: true, paymentEnabled: false },
				{ adminId: 'admin-1', request }
			)
		).resolves.toEqual(
			expect.objectContaining({
				paymentEnabled: false,
				autoRenewalTerms: expect.any(Object)
			})
		);
		expect(composition.execute).toHaveBeenCalledWith({
			corePatch: { bannerEnabled: true },
			billingPatch: { paymentEnabled: false },
			actorId: 'admin-1',
			request
		});
	});

	it('updates Core-only fields and recomposes the Billing projection', async () => {
		const updated = { ...coreSettings(), bannerEnabled: true };
		const billing = billingSettings();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: 'singleton' }]),
			siteSettings: {
				update: jest.fn().mockResolvedValue(updated),
				findUniqueOrThrow: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			billingSettingsReadProjection: {
				findUnique: jest.fn().mockResolvedValue(billing)
			}
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
			composition
		);

		await expect(
			service.update(
				{ bannerEnabled: true },
				{ adminId: 'admin-1', request: {} as Request }
			)
		).resolves.toEqual(expect.objectContaining({ bannerEnabled: true }));
		expect(transaction.siteSettings.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: { bannerEnabled: true }
		});
		expect(composition.execute).not.toHaveBeenCalled();
	});
});
