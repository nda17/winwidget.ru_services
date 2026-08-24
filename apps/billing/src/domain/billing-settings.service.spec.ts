import { BadRequestException } from '@nestjs/common';
import { BillingSettingsService } from './billing-settings.service';
import {
	AUTO_RENEWAL_CONSENT_TEXT,
	AUTO_RENEWAL_CONSENT_VERSION
} from './billing-legal.constants';

const settings = (overrides: Record<string, unknown> = {}) => ({
	id: 'singleton',
	paymentEnabled: true,
	autoRenewalSignupEnabled: false,
	autoRenewalChargesEnabled: false,
	autoRenewalChargesEnabledAt: new Date('2026-08-01T00:00:00.000Z'),
	affiliateProgramEnabled: true,
	affiliateCashbackPercent: 10,
	aggregateVersion: 5n,
	sourceSequence: 10n,
	updatedAt: new Date('2026-08-23T12:00:00.000Z'),
	...overrides
});

describe('BillingSettingsService', () => {
	it('returns the exact narrow public response', async () => {
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		const service = new BillingSettingsService(prisma as never);
		await expect(service.publicSettings()).resolves.toEqual({
			paymentEnabled: true,
			autoRenewalSignupEnabled: false,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			}
		});
	});

	it('returns the exact non-null admin response', async () => {
		const prisma = {
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings())
			}
		};
		const service = new BillingSettingsService(prisma as never);
		const result = await service.adminSettings();
		expect(result).toEqual({
			id: 'singleton',
			paymentEnabled: true,
			autoRenewalSignupEnabled: false,
			autoRenewalChargesEnabled: false,
			autoRenewalChargesEnabledAt: '2026-08-01T00:00:00.000Z',
			affiliateProgramEnabled: true,
			affiliateCashbackPercent: 10,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			},
			updatedAt: '2026-08-23T12:00:00.000Z'
		});
	});

	it('updates settings and audit in one transaction', async () => {
		const updated = settings({
			paymentEnabled: false,
			affiliateCashbackPercent: 15,
			aggregateVersion: 6n,
			sourceSequence: 11n
		});
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			billingSettings: {
				findUnique: jest.fn().mockResolvedValue(settings()),
				update: jest.fn().mockResolvedValue(updated)
			},
			billingSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 12n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest
				.fn()
				.mockImplementation((work: (tx: unknown) => unknown) =>
					work(transaction)
				)
		};
		const service = new BillingSettingsService(prisma as never);

		const result = await service.updateAdminSettings(
			{ paymentEnabled: false, affiliateCashbackPercent: 15 },
			{
				actor: {
					active: true,
					subject: 'admin-1',
					sessionId: 'session-1',
					roles: ['ADMIN']
				},
				ip: '1'.repeat(200),
				userAgent: 'u'.repeat(600)
			}
		);

		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					metadata: expect.objectContaining({
						requestIp: '1'.repeat(128),
						requestUserAgent: 'u'.repeat(500)
					})
				})
			})
		});
		expect(result).toMatchObject({
			id: 'singleton',
			paymentEnabled: false,
			affiliateCashbackPercent: 15,
			autoRenewalTerms: {
				version: AUTO_RENEWAL_CONSENT_VERSION,
				text: AUTO_RENEWAL_CONSENT_TEXT
			}
		});
	});

	it('rejects an empty PATCH before opening a transaction', async () => {
		const prisma = { $transaction: jest.fn() };
		const service = new BillingSettingsService(prisma as never);
		await expect(
			service.updateAdminSettings(
				{},
				{
					actor: {
						active: true,
						subject: 'admin-1',
						sessionId: 'session-1',
						roles: ['ADMIN']
					}
				}
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
});
